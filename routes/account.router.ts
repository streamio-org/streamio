import { Router, type Request, type Response } from "express";
import { AccountService } from "../services/account.service.js";
import { requireAuth } from "../auth/middleware.js";
import type { Redis } from "../database/redis.js";
import type { Database } from "../database/db.js";
import type { RoomService } from "../services/room.service.js";
import type { RoomHub } from "../services/room-socket.service.js";
import { AdultService, ADULT_PREFERENCE_KEY } from "../services/adult.service.js";
import { StatsService } from "../services/stats.service.js";
import type { WebPlatformHandler } from "../PlatformHandler.js";

/** Rows in the library tables — watchlist, favorites, ratings, watch history. */
type LibraryRow = { provider: string; show_id: string };

export function createAccountRouter(
  db: Database,
  redis: Redis,
  roomService: RoomService,
  roomHub: RoomHub,
  platformHandler: WebPlatformHandler
): Router {
  const router  = Router();
  const service = new AccountService(db, redis);
  const adultService = new AdultService(db, redis);
  const statsService = new StatsService(db);

  /**
   * The content routes cache the resolved 18+ preference for a minute, so
   * writing it has to drop that entry — otherwise the toggle appears not to
   * take effect until the cache expires.
   */
  const invalidateIfAdultKey = async (userId: string, key: string) => {
    if (key === ADULT_PREFERENCE_KEY) await adultService.invalidate(userId);
  };

  /**
   * A library row is only `{ provider, show_id }` — no `adult` flag to check
   * here — so this can't hide an 18+ item up front the way `content.router.ts`
   * does for a listing. It's a no-op today, kept as the one place that
   * decision would go if a cheap per-row signal existed; a gated item is
   * instead caught when the page hydrates each row through
   * `GET /api/shows/:id`, which 403s and is treated as permanent (drop the
   * row) by the frontend.
   */
  async function filterAdultRows<T extends LibraryRow>(
    userId: string,
    rows: T[]
  ): Promise<T[]> {
    return rows;
  }

  /**
   * Reads `limit`/`offset` off a listing request.
   *
   * An absent `limit` stays `undefined` — i.e. unbounded — rather than taking a
   * default page size. These endpoints predate paging and the Flutter client
   * still fetches them whole, so defaulting would silently truncate a large
   * library instead of failing visibly. Watch history keeps its own published
   * default of 50.
   */
  function readPage(req: Request): { limit?: number; offset: number } {
    const rawLimit = req.query.limit as string | undefined;
    const parsed   = parseInt(rawLimit as string);
    const limit    = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 100) : undefined;
    const offset   = Math.max(parseInt(req.query.offset as string) || 0, 0);
    return { limit, offset };
  }

  /**
   * Sends one page of a listing, with the two numbers a pager needs.
   *
   * Headers rather than an `{ items, total }` envelope: the response stays a
   * bare JSON array, so every existing consumer — the Flutter client included —
   * is unaffected.
   *
   * - `X-Total-Count` is the listing's full size. It is the database total,
   *   counted before `filterAdultRows` and before the frontend drops rows the
   *   detail endpoint gates, so a user with 18+ content disabled can see a
   *   count that reads slightly high. Counting what survives filtering would
   *   mean fetching every row, which is the work paging exists to avoid.
   *
   * - `X-Page-Rows` is how many rows the query actually *read*, before 18+
   *   filtering removed any. **This is what a caller must advance its offset
   *   by** — the array it receives can be shorter, and stepping by the shorter
   *   number re-requests the rows that were filtered out, serving them again as
   *   duplicates. It is also the honest test for a last page: a full page that
   *   arrives half-empty still has more behind it.
   */
  const sendPage = async (
    res: Response,
    userId: string,
    items: LibraryRow[],
    total: number
  ) => {
    res.setHeader("X-Total-Count", String(total));
    res.setHeader("X-Page-Rows", String(items.length));
    res.json(await filterAdultRows(userId, items));
  };

  // All routes require authentication
  router.use(requireAuth);

  // ── GET /api/account/me ───────────────────────────────────
  router.get("/me", async (req: Request, res: Response) => {
    const user = await service.getUserById(req.user!.sub);
    res.json(user);
  });

  /**
   * ── GET /api/account/stats ────────────────────────────────
   *
   * Your own statistics and every badge, earned or not.
   *
   * Private by construction: the whole router is `requireAuth` and the id is
   * read from the token, never from the request — there is no shape of this
   * URL that reads someone else's numbers. If badges are ever surfaced on a
   * public profile, that has to be a *separate*, earned-only endpoint under
   * /api/social; don't relax this one.
   *
   * The read is also what awards badges (see StatsService.syncBadges), so it
   * must not be cached.
   */
  router.get("/stats", async (req: Request, res: Response) => {
    try {
      res.json(await statsService.getStatsWithBadges(req.user!.sub));
    } catch (err) {
      console.error("[account] stats failed:", err);
      res.status(500).json({ error: "Failed to load stats" });
    }
  });

  // ── GET /api/account/badges ───────────────────────────────
  // The badge half alone, for callers that don't need the numbers.
  router.get("/badges", async (req: Request, res: Response) => {
    try {
      const { badges } = await statsService.getStatsWithBadges(req.user!.sub);
      res.json({ badges, earned: badges.filter((b) => b.earned).length, total: badges.length });
    } catch (err) {
      console.error("[account] badges failed:", err);
      res.status(500).json({ error: "Failed to load badges" });
    }
  });

  // ── PATCH /api/account/me ─────────────────────────────────
  router.patch("/me", async (req: Request, res: Response) => {
    const { display_name, avatar_url } = req.body;
    const user = await service.updateProfile(req.user!.sub, {
      displayName: display_name,
      avatarUrl:   avatar_url,
    });
    res.json(user);
  });

  // ── GET /api/account/watchlist ────────────────────────────
  router.get("/watchlist", async (req: Request, res: Response) => {
    const page = readPage(req);
    const [items, total] = await Promise.all([
      service.getWatchlist(req.user!.sub, page),
      service.countWatchlist(req.user!.sub),
    ]);
    await sendPage(res, req.user!.sub, items, total);
  });

  // ── GET /api/account/watchlist/search ─────────────────────
  // Custom filtered query — does not affect the plain /watchlist route above.
  // Query params: provider, search (matches show_id), rating, min_rating, max_rating
  router.get("/watchlist/search", async (req: Request, res: Response) => {
    const { provider, search, rating, min_rating, max_rating } = req.query;

    const ratingNum    = rating     !== undefined ? Number(rating)     : undefined;
    const minRatingNum = min_rating !== undefined ? Number(min_rating) : undefined;
    const maxRatingNum = max_rating !== undefined ? Number(max_rating) : undefined;

    if (rating !== undefined && (Number.isNaN(ratingNum) || ratingNum! < 1 || ratingNum! > 10)) {
      res.status(400).json({ error: "rating must be a number between 1 and 10." });
      return;
    }
    if (min_rating !== undefined && Number.isNaN(minRatingNum)) {
      res.status(400).json({ error: "min_rating must be a number." });
      return;
    }
    if (max_rating !== undefined && Number.isNaN(maxRatingNum)) {
      res.status(400).json({ error: "max_rating must be a number." });
      return;
    }

    const filters = {
      provider:  provider ? String(provider) : undefined,
      search:    search   ? String(search)   : undefined,
      rating:    ratingNum,
      minRating: minRatingNum,
      maxRating: maxRatingNum,
    };
    const [items, total] = await Promise.all([
      service.getWatchlistFiltered(req.user!.sub, filters, readPage(req)),
      service.countWatchlistFiltered(req.user!.sub, filters),
    ]);
    await sendPage(res, req.user!.sub, items, total);
  });

  // ── POST /api/account/watchlist ───────────────────────────
  router.post("/watchlist", async (req: Request, res: Response) => {
    const { provider, show_id } = req.body;
    if (!provider || !show_id) {
      res.status(400).json({ error: "provider and show_id are required." });
      return;
    }
    await service.addToWatchlist(req.user!.sub, provider, show_id);
    res.status(201).json({ message: "Added to watchlist." });
  });

  // ── DELETE /api/account/watchlist/:provider/:showId ───────
  router.delete(
    "/watchlist/:provider/:showId",
    async (req: Request, res: Response) => {
      const provider = Array.isArray(req.params.provider)
        ? req.params.provider[0]
        : req.params.provider;
      const showId = Array.isArray(req.params.showId)
        ? req.params.showId[0]
        : req.params.showId;

      if (!provider || !showId) {
        res.status(400).json({ error: "provider and showId are required." });
        return;
      }

      await service.removeFromWatchlist(req.user!.sub, provider, showId);
      res.json({ message: "Removed from watchlist." });
    }
  );

  // ── GET /api/account/history ──────────────────────────────
  router.get("/history", async (req: Request, res: Response) => {
    const limit  = Math.min(parseInt(req.query.limit  as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const [items, total] = await Promise.all([
      service.getWatchHistory(req.user!.sub, limit, offset),
      service.countWatchHistory(req.user!.sub),
    ]);
    await sendPage(res, req.user!.sub, items, total);
  });

  // ── GET /api/account/history/search ───────────────────────
  // Custom filtered query — does not affect the plain /history route above.
  // Query params: provider, completed, date_from, date_to, search (matches show_id/episode_label), limit, offset
  router.get("/history/search", async (req: Request, res: Response) => {
    const { provider, completed, date_from, date_to, search } = req.query;
    const limit  = Math.min(parseInt(req.query.limit  as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    let completedBool: boolean | undefined;
    if (completed !== undefined) {
      if (completed === "true")       completedBool = true;
      else if (completed === "false") completedBool = false;
      else {
        res.status(400).json({ error: "completed must be 'true' or 'false'." });
        return;
      }
    }

    let dateFrom: Date | undefined;
    let dateTo: Date | undefined;
    if (date_from !== undefined) {
      dateFrom = new Date(String(date_from));
      if (Number.isNaN(dateFrom.getTime())) {
        res.status(400).json({ error: "date_from must be a valid date." });
        return;
      }
    }
    if (date_to !== undefined) {
      dateTo = new Date(String(date_to));
      if (Number.isNaN(dateTo.getTime())) {
        res.status(400).json({ error: "date_to must be a valid date." });
        return;
      }
    }

    const filters = {
      provider:  provider ? String(provider) : undefined,
      completed: completedBool,
      dateFrom,
      dateTo,
      search:    search ? String(search) : undefined,
    };
    const [items, total] = await Promise.all([
      service.getWatchHistoryFiltered(req.user!.sub, filters, limit, offset),
      service.countWatchHistoryFiltered(req.user!.sub, filters),
    ]);
    await sendPage(res, req.user!.sub, items, total);
  });

  // ── POST /api/account/history ─────────────────────────────
  router.post("/history", async (req: Request, res: Response) => {
    const { provider, show_id, episode_id, episode_label, progress_seconds, duration_seconds, completed } = req.body;

    if (!provider || !show_id || progress_seconds === undefined) {
      res.status(400).json({ error: "provider, show_id, and progress_seconds are required." });
      return;
    }

    await service.upsertWatchProgress(
      req.user!.sub,
      provider,
      show_id,
      episode_id ?? null,
      Number(progress_seconds),
      Boolean(completed),
      episode_label ?? null,
      duration_seconds != null ? Number(duration_seconds) : null
    );
    res.json({ message: "Progress saved." });
  });
  
  router.put("/history/complete", async (req, res) => {
    try {
      const { provider, show_id } = req.body;
      // Movies have no episode id (a movie is one row with episode_id NULL)
      // — requiring it here made them impossible to complete.
      const episode_id = req.body.episode_id ?? null;

      if (!provider || !show_id) {
        return res.status(400).json({ error: "provider and show_id required" });
      }

      const progress = await service.getWatchProgress(
        req.user!.sub,
        provider,
        show_id,
        episode_id
      );

      if (!progress) {
        return res.status(404).json({ error: "Progress entry not found" });
      }

      await service.upsertWatchProgress(
        req.user!.sub,
        provider,
        show_id,
        episode_id,
        // Duration is unknown for rows saved before it was recorded; keeping the
        // existing progress beats resetting the bar to 0 on a completed row.
        progress.duration_seconds || progress.progress_seconds || 0,
        true,
        progress.episode_label,
        progress.duration_seconds
      );

      return res.json({ message: "Marked as complete." });

    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "Failed to update watch progress" });
    }
  });

  // ── GET /api/account/history/progress/:provider/:showId ────
  // All episode progress rows for one show, keyed by episode_id — used by
  // the watch page to mark each episode button completed/in-progress.
  router.get("/history/progress/:provider/:showId", async (req: Request, res: Response) => {
    const provider = String(req.params.provider);
    const showId = String(req.params.showId);
    const rows = await service.getWatchProgressForShow(req.user!.sub, provider, showId);
    res.json(rows);
  });

  router.post("/history/progress/", async (req, res) => {
    const { provider, showId, episodeId } = req.body;
    if (!provider || !showId) {
      res.status(400).json({ error: "provider and showId are required." });
      return;
    }
    const progress = await service.getWatchProgress(
      req.user!.sub,
      provider,
      showId,
      episodeId ?? null
    );
    if (!progress) {
      res.json({ progress_seconds: null, completed: false });
      return;
    }
    res.json(progress);
  });

  // ── DELETE /api/account/history/:provider/:showId/:episodeId ─
  router.delete(
    "/history/:provider/:showId/:episodeId",
    async (req: Request, res: Response) => {
      const provider = Array.isArray(req.params.provider)
        ? req.params.provider[0]
        : req.params.provider;
      const showId = Array.isArray(req.params.showId)
        ? req.params.showId[0]
        : req.params.showId;
      const episodeId = Array.isArray(req.params.episodeId)
        ? req.params.episodeId[0]
        : req.params.episodeId;

      await service.deleteHistoryEntry(req.user!.sub, provider, showId, episodeId);
      res.json({ message: "Entry removed." });
    }
  );

  // ── DELETE /api/account/history/:provider/:showId ─────────────
  router.delete(
    "/history/:provider/:showId",
    async (req: Request, res: Response) => {
      const provider = Array.isArray(req.params.provider)
        ? req.params.provider[0]
        : req.params.provider;
      const showId = Array.isArray(req.params.showId)
        ? req.params.showId[0]
        : req.params.showId;

      await service.deleteHistoryEntry(req.user!.sub, provider, showId, null);
      res.json({ message: "Entry removed." });
    }
  );

  // ── DELETE /api/account/history ───────────────────────────────
  router.delete("/history", async (req: Request, res: Response) => {
    await service.clearHistory(req.user!.sub);
    res.json({ message: "History cleared." });
  });

  // ── GET /api/account/preferences ─────────────────────────
  router.get("/preferences", async (req: Request, res: Response) => {
    const prefs = await service.getPreferences(req.user!.sub);
    res.json(prefs);
  });

  // ── PUT /api/account/preferences/:key ────────────────────
  router.put(
    "/preferences/:key",
    async (req: Request, res: Response) => {
      const key = Array.isArray(req.params.key)
        ? req.params.key[0]
        : req.params.key;
      const { value } = req.body;

      if (!key) {
        res.status(400).json({ error: "key is required." });
        return;
      }

      if (value === undefined) {
        res.status(400).json({ error: "value is required." });
        return;
      }

      await service.setPreference(req.user!.sub, key, value);
      await invalidateIfAdultKey(req.user!.sub, key);
      res.json({ message: "Preference saved." });
    }
  );

  // ── DELETE /api/account/preferences/:key ─────────────────
  router.delete(
    "/preferences/:key",
    async (req: Request, res: Response) => {
      const key = Array.isArray(req.params.key)
        ? req.params.key[0]
        : req.params.key;

      if (!key) {
        res.status(400).json({ error: "key is required." });
        return;
      }

      await service.deletePreference(req.user!.sub, key);
      await invalidateIfAdultKey(req.user!.sub, key);
      res.json({ message: "Preference removed." });
    }
  );

  // ── DELETE /api/account/me ────────────────────────────────
  router.delete("/me", async (req: Request, res: Response) => {
    const userId = req.user!.sub;

    // Hand off/close any rooms this user is in *before* deleting them, so a
    // room they own gets reassigned to another member (same as a normal
    // "leave") instead of being cascade-deleted out from under everyone
    // else still watching. Also lets connected members' sockets be told.
    const leftRooms = await roomService.leaveAllRooms(userId);
    for (const { code, room } of leftRooms) {
      if (room) roomHub.notifyMembersChanged(room.code, room.members, room.ownerId);
      else roomHub.closeRoom(code, "owner_account_deleted");
    }

    await service.deleteUser(userId);
    res.clearCookie("refresh_token", { path: "/api/auth/refresh" });
    res.json({ message: "Account deleted." });
  });

  // ── GET /api/account/favorites ────────────────────────────
  router.get("/favorites", async (req: Request, res: Response) => {
    const page = readPage(req);
    const [items, total] = await Promise.all([
      service.getFavorites(req.user!.sub, page),
      service.countFavorites(req.user!.sub),
    ]);
    await sendPage(res, req.user!.sub, items, total);
  });

  // ── GET /api/account/favorites/search ──────────────────────
  // Custom filtered query — does not affect the plain /favorites route above.
  // Query params: provider, search (matches show_id), rating, min_rating, max_rating
  router.get("/favorites/search", async (req: Request, res: Response) => {
    const { provider, search, rating, min_rating, max_rating } = req.query;

    const ratingNum    = rating     !== undefined ? Number(rating)     : undefined;
    const minRatingNum = min_rating !== undefined ? Number(min_rating) : undefined;
    const maxRatingNum = max_rating !== undefined ? Number(max_rating) : undefined;

    if (rating !== undefined && (Number.isNaN(ratingNum) || ratingNum! < 1 || ratingNum! > 10)) {
      res.status(400).json({ error: "rating must be a number between 1 and 10." });
      return;
    }
    if (min_rating !== undefined && Number.isNaN(minRatingNum)) {
      res.status(400).json({ error: "min_rating must be a number." });
      return;
    }
    if (max_rating !== undefined && Number.isNaN(maxRatingNum)) {
      res.status(400).json({ error: "max_rating must be a number." });
      return;
    }

    const filters = {
      provider:  provider ? String(provider) : undefined,
      search:    search   ? String(search)   : undefined,
      rating:    ratingNum,
      minRating: minRatingNum,
      maxRating: maxRatingNum,
    };
    const [items, total] = await Promise.all([
      service.getFavoritesFiltered(req.user!.sub, filters, readPage(req)),
      service.countFavoritesFiltered(req.user!.sub, filters),
    ]);
    await sendPage(res, req.user!.sub, items, total);
  });

  // ── GET /api/account/favorites/:provider/:showId ──────────
  router.get(
    "/favorites/:provider/:showId",
    async (req: Request, res: Response) => {
      const { provider, showId } = req.params;
      const favorite = await service.isFavorite(req.user!.sub, String(provider), String(showId));
      res.json({ favorite });
    }
  );

  // ── POST /api/account/favorites ───────────────────────────
  router.post("/favorites", async (req: Request, res: Response) => {
    const { provider, show_id } = req.body;
    if (!provider || !show_id) {
      res.status(400).json({ error: "provider and show_id are required." });
      return;
    }
    await service.addFavorite(req.user!.sub, provider, show_id);
    res.status(201).json({ message: "Added to favorites." });
  });

  // ── DELETE /api/account/favorites/:provider/:showId ───────
  router.delete(
    "/favorites/:provider/:showId",
    async (req: Request, res: Response) => {
      const { provider, showId } = req.params;
      await service.removeFavorite(req.user!.sub, String(provider), String(showId));
      res.json({ message: "Removed from favorites." });
    }
  );

  // ── GET /api/account/ratings ──────────────────────────────
  router.get("/ratings", async (req: Request, res: Response) => {
    const items = await service.getAllRatings(req.user!.sub);
    res.json(await filterAdultRows(req.user!.sub, items));
  });

  // ── GET /api/account/ratings/:provider/:showId ────────────
  router.get(
    "/ratings/:provider/:showId",
    async (req: Request, res: Response) => {
      const { provider, showId } = req.params;
      const rating = await service.getRating(req.user!.sub, String(provider), String(showId));
      if (rating === null) {
        res.status(404).json({ error: "Rating not found." });
        return;
      }
      res.json({ rating });
    }
  );

  // ── PUT /api/account/ratings/:provider/:showId ────────────
  router.put(
    "/ratings/:provider/:showId",
    async (req: Request, res: Response) => {
      const { provider, showId } = req.params;
      const { rating } = req.body;

      if (rating === undefined || typeof rating !== "number" || rating < 1 || rating > 10) {
        res.status(400).json({ error: "rating must be a number between 1 and 10." });
        return;
      }
      if (rating != Math.floor(rating)) {
        res.status(400).json({ error: "rating must be an integer." });
        return;
      }

      await service.upsertRating(req.user!.sub, String(provider), String(showId), rating);
      res.json({ message: "Rating saved." });
    }
  );

  // ── DELETE /api/account/ratings/:provider/:showId ─────────
  router.delete(
    "/ratings/:provider/:showId",
    async (req: Request, res: Response) => {
      const { provider, showId } = req.params;
      await service.deleteRating(req.user!.sub, String(provider), String(showId));
      res.json({ message: "Rating removed." });
    }
  );

  return router;
}