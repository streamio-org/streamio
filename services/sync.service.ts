// sync.service.ts
//
// Syncs user-library data (watchlist, favorites, ratings, watch history, follows)
// between this server and the "hosting points" (peer Streamio instances) configured
// in the `hosting_points` table.
//
// Model: pull-based, bidirectional, additive-only.
// - Each server periodically pulls changes from every enabled peer and merges them
//   into its own DB. It never pushes — the peer syncs back on its own schedule.
// - Users are matched across servers by email (the only identifier both sides
//   share). A peer's row is skipped if no local user has that email — nothing is
//   ever created on this side except merges into an existing account.
// - Deletions do NOT propagate: removing an item on one server does not remove it
//   on peers. This is the safe default; re-adding it elsewhere will just re-sync back.
import axios from "axios";
import { Database } from "../database/db.js";
import { Redis } from "../database/redis.js";
import { SettingsService } from "./settings.service.js";
import { AccountService } from "./account.service.js";
import { FollowService } from "./follow.service.js";

interface SyncExport {
  serverTime: string;
  watchlist: Array<{ email: string; provider: string; show_id: string }>;
  favorites: Array<{ email: string; provider: string; show_id: string }>;
  ratings: Array<{ email: string; provider: string; show_id: string; rating: number; updated_at: string }>;
  watchHistory: Array<{
    email: string;
    provider: string;
    show_id: string;
    episode_id: string | null;
    episode_label: string | null;
    progress_seconds: number;
    duration_seconds: number | null;
    completed: boolean;
    watched_at: string;
  }>;
  follows: Array<{ follower_email: string; followee_email: string }>;
}

export class SyncService {
  private readonly settingsService: SettingsService;
  private readonly accountService: AccountService;
  private readonly followService: FollowService;
  private syncing = false;
  private lastCycleAt = 0;
  private schedulerHandle: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Database,
    private readonly redis: Redis
  ) {
    this.settingsService = new SettingsService(db);
    this.accountService = new AccountService(db, redis);
    this.followService = new FollowService(db, redis);
  }

  // ── Export (peer-facing) ──────────────────────────────────

  async exportChanges(since: Date): Promise<SyncExport> {
    const serverTime = new Date();

    const [watchlist, favorites, ratings, watchHistory, follows] = await Promise.all([
      this.db.all<{ email: string; provider: string; show_id: string }>(
        `SELECT u.email, w.provider, w.show_id
         FROM watchlist w JOIN users u ON u.id = w.user_id
         WHERE w.added_at > $1`,
        [since]
      ),
      this.db.all<{ email: string; provider: string; show_id: string }>(
        `SELECT u.email, f.provider, f.show_id
         FROM favorites f JOIN users u ON u.id = f.user_id
         WHERE f.added_at > $1`,
        [since]
      ),
      this.db.all<{ email: string; provider: string; show_id: string; rating: number; updated_at: string }>(
        `SELECT u.email, r.provider, r.show_id, r.rating, r.updated_at
         FROM ratings r JOIN users u ON u.id = r.user_id
         WHERE r.updated_at > $1`,
        [since]
      ),
      this.db.all(
        `SELECT u.email, h.provider, h.show_id, h.episode_id, h.episode_label,
                h.progress_seconds, h.duration_seconds, h.completed, h.watched_at
         FROM watch_history h JOIN users u ON u.id = h.user_id
         WHERE h.watched_at > $1`,
        [since]
      ),
      this.db.all<{ follower_email: string; followee_email: string }>(
        `SELECT uf.email AS follower_email, ue.email AS followee_email
         FROM follows f
         JOIN users uf ON uf.id = f.follower_id
         JOIN users ue ON ue.id = f.followee_id
         WHERE f.created_at > $1`,
        [since]
      ),
    ]);

    return {
      serverTime: serverTime.toISOString(),
      watchlist,
      favorites,
      ratings,
      watchHistory: watchHistory as SyncExport["watchHistory"],
      follows,
    };
  }

  // ── Import (local merge of a peer's export) ───────────────

  async importChanges(data: SyncExport): Promise<{ imported: number; errors: string[] }> {
    let imported = 0;
    const errors: string[] = [];
    const userIdByEmail = new Map<string, string | null>();

    const resolveUserId = async (email: string): Promise<string | null> => {
      if (userIdByEmail.has(email)) return userIdByEmail.get(email)!;
      const row = await this.db.one<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
      const id = row?.id ?? null;
      userIdByEmail.set(email, id);
      return id;
    };

    // Each table loop below catches per-item, not per-table: one bad row (e.g. a
    // constraint edge case) must not stop the rest of that table's batch from
    // merging, since importChanges only runs again next cycle for rows still
    // ahead of the watermark.
    const recordError = (table: string, err: any) => {
      const message = `${table}: ${err.message}`;
      if (!errors.includes(message)) errors.push(message);
    };

    // Watchlist — idempotent add, safe to re-run.
    for (const item of data.watchlist) {
      try {
        const userId = await resolveUserId(item.email);
        if (!userId) continue;
        await this.accountService.addToWatchlist(userId, item.provider, item.show_id);
        imported++;
      } catch (err: any) {
        recordError("watchlist", err);
      }
    }

    // Favorites — idempotent add, safe to re-run.
    for (const item of data.favorites) {
      try {
        const userId = await resolveUserId(item.email);
        if (!userId) continue;
        await this.accountService.addFavorite(userId, item.provider, item.show_id);
        imported++;
      } catch (err: any) {
        recordError("favorites", err);
      }
    }

    // Ratings — newer updated_at wins, but an equal rating is a no-op even if
    // the peer's updated_at is newer. Both sides bump updated_at = NOW() on
    // write (see upsertRating), so in a bidirectional setup treating "newer
    // timestamp" alone as the tiebreak on an already-equal value would make
    // both sides re-export and re-import each other's copy forever, endlessly
    // bumping updated_at without the value ever changing.
    for (const item of data.ratings) {
      try {
        const userId = await resolveUserId(item.email);
        if (!userId) continue;
        const local = await this.db.one<{ rating: number; updated_at: string }>(
          `SELECT rating, updated_at FROM ratings WHERE user_id = $1 AND provider = $2 AND show_id = $3`,
          [userId, item.provider, item.show_id]
        );
        if (local && (local.rating === item.rating || new Date(local.updated_at) >= new Date(item.updated_at))) {
          continue;
        }
        await this.accountService.upsertRating(userId, item.provider, item.show_id, item.rating);
        imported++;
      } catch (err: any) {
        recordError("ratings", err);
      }
    }

    // Watch history — strictly greater progress wins. No timestamp tiebreak on
    // equal progress: like ratings, watched_at is bumped to NOW() on every write
    // (see upsertWatchProgress), so a "newer timestamp wins" rule on equal-value
    // rows would never converge between two peers re-importing each other's copy.
    for (const item of data.watchHistory) {
      try {
        const userId = await resolveUserId(item.email);
        if (!userId) continue;
        const local = await this.db.one<{ progress_seconds: number }>(
          `SELECT progress_seconds FROM watch_history
           WHERE user_id = $1 AND provider = $2 AND show_id = $3
           AND (episode_id = $4 OR ($4 IS NULL AND episode_id IS NULL))`,
          [userId, item.provider, item.show_id, item.episode_id]
        );
        const peerWins = !local || item.progress_seconds > local.progress_seconds;
        if (!peerWins) continue;
        await this.accountService.upsertWatchProgress(
          userId,
          item.provider,
          item.show_id,
          item.episode_id,
          item.progress_seconds,
          item.completed,
          item.episode_label,
          item.duration_seconds
        );
        imported++;
      } catch (err: any) {
        recordError("watchHistory", err);
      }
    }

    // Follows — matched by email pair on both ends; skipped if either side
    // doesn't have a local account.
    for (const item of data.follows) {
      try {
        const followerId = await resolveUserId(item.follower_email);
        const followeeId = await resolveUserId(item.followee_email);
        if (!followerId || !followeeId || followerId === followeeId) continue;
        await this.followService.follow(followerId, followeeId);
        imported++;
      } catch (err: any) {
        recordError("follows", err);
      }
    }

    return { imported, errors };
  }

  // ── Sync cycle: pull from every enabled hosting point ─────

  async runSyncCycle(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    this.lastCycleAt = Date.now();

    try {
      const peers = await this.settingsService.listHostingPoints();
      for (const peer of peers.filter((p) => p.enabled)) {
        await this.syncWithPeer(peer.id);
      }
    } finally {
      this.syncing = false;
    }
  }

  private async syncWithPeer(hostingPointId: string): Promise<void> {
    const peer = await this.db.one<{ id: string; url: string; shared_secret: string; last_synced_at: Date | null }>(
      `SELECT id, url, shared_secret, last_synced_at FROM hosting_points WHERE id = $1`,
      [hostingPointId]
    );
    if (!peer) return;

    const since = peer.last_synced_at ?? new Date(0);

    try {
      const response = await axios.get<SyncExport>(`${peer.url.replace(/\/$/, "")}/api/sync/export`, {
        headers: { "X-Sync-Secret": peer.shared_secret },
        params: { since: since.toISOString() },
        timeout: 15_000,
      });

      const { imported, errors } = await this.importChanges(response.data);

      // Watermark is the peer's own clock (from its export response), not ours —
      // avoids under-pulling on clock skew between the two servers. But only
      // advance it on a fully clean import: a partial table failure means some
      // rows in this batch were never merged, so re-pull the same window next
      // time (importChanges is idempotent, so this costs nothing extra).
      await this.settingsService.markSyncResult(
        peer.id,
        errors.length ? "error" : "ok",
        errors.length ? errors.join("; ") : null,
        errors.length ? since : new Date(response.data.serverTime)
      );
      void imported;
    } catch (err: any) {
      await this.settingsService.markSyncResult(peer.id, "error", err.message, since);
    }
  }

  // ── Scheduler ──────────────────────────────────────────────
  // Ticks every minute and re-reads settings each time, so enabling/disabling
  // sync or changing the interval takes effect without a restart.

  startScheduler(): void {
    if (this.schedulerHandle) return;
    this.schedulerHandle = setInterval(async () => {
      try {
        const settings = await this.settingsService.getSyncSettings();
        if (!settings.enabled) return;
        const dueAt = this.lastCycleAt + settings.intervalMinutes * 60_000;
        if (Date.now() >= dueAt) {
          await this.runSyncCycle();
        }
      } catch (err) {
        console.error("Sync scheduler tick failed:", err);
      }
    }, 60_000);
  }

  stopScheduler(): void {
    if (this.schedulerHandle) {
      clearInterval(this.schedulerHandle);
      this.schedulerHandle = null;
    }
  }
}
