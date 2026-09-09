// local-provider.router.ts
//
// Admin-only management API behind the "local" provider (core/providers/LocalProvider.ts):
// create a movie/show, optionally auto-filled from a TMDB id, upload a video
// file per movie/episode, and track it through ffmpeg transcoding. Every id
// this router accepts is a raw `local_*` table row id — not the
// `local-movie-<id>`/`local-tv-<id>#s<n>e<m>` wire scheme `LocalProvider`
// builds for the public content routes. The two are deliberately different
// namespaces: this API is never reached by anything but the admin page.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Router, type Request, type Response } from "express";
import type { Database } from "../database/db.js";
import { requireAuth, createRequireAdmin } from "../auth/middleware.js";
import { TranscodeService } from "../services/transcode.service.js";
import { originalDirFor, removeMediaFiles } from "../services/local-media-storage.js";
import {
  fetchTmdbMovieSnapshot,
  fetchTmdbTvSnapshot,
  fetchTmdbSeasonSnapshot,
} from "../services/tmdb-import.service.js";

// This is a filename sanity check, not a codec check — ffmpeg decides what
// it can actually decode (see transcode.service.ts), so the goal here is
// only to reject obviously-not-a-video uploads before they hit disk. Kept
// broad on purpose: an admin's mkv rip is at least as likely as an mp4, and
// this list covers the containers ffmpeg's Alpine build (Dockerfile) reads
// day to day, whatever video/audio codec is actually packed inside them.
const VIDEO_EXTENSION_RE =
  /\.(mp4|m4v|mkv|webm|mov|avi|wmv|flv|f4v|ts|m2ts|mts|mpg|mpeg|m2v|3gp|3g2|ogv|vob|asf|rm|rmvb|divx)$/i;
// Generous — this uploads whole movies/episodes, not thumbnails.
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024 * 1024;

/**
 * Uploads arrive in chunks rather than as one multipart POST, because a
 * self-hosted install is often reached through a Cloudflare Tunnel or similar
 * proxy, and Cloudflare resets any request whose body exceeds ~100MB
 * (`net::ERR_CONNECTION_RESET` at the browser, nothing at all in the app's
 * logs — the request never arrives). A movie is never going to fit. 8MB
 * leaves a wide margin under that cap, keeps each request short enough not
 * to bump into proxy read timeouts, and makes a dropped chunk cost 8MB of
 * re-upload instead of the whole file.
 */
const CHUNK_SIZE = 8 * 1024 * 1024;
/** An upload nobody has touched for this long is abandoned; its partial file
 *  is swept so a closed browser tab doesn't strand gigabytes on disk. */
const UPLOAD_SESSION_TTL_MS = 6 * 60 * 60 * 1000;

interface UploadSession {
  fileId: string;
  filename: string;
  size: number;
  received: number;
  targetKind: "movie" | "episode";
  targetId: string;
  destPath: string;
  touchedAt: number;
}

function param(value: unknown): string {
  return Array.isArray(value) ? String(value[0]) : String(value ?? "");
}

/** The single file written for `fileId` — used by the retry endpoint, since
 *  nothing else remembers the exact name. Absent once a successful transcode
 *  has cleaned the original up (see transcode.service.ts). */
async function findOriginalPath(fileId: string): Promise<string | null> {
  const dir = originalDirFor(fileId);
  try {
    const entries = await fs.promises.readdir(dir);
    return entries.length ? path.join(dir, entries[0]) : null;
  } catch {
    return null;
  }
}

export function createLocalProviderRouter(db: Database): Router {
  const router = Router();
  const transcodeService = new TranscodeService(db);

  // Server-wide admin-only management, same gate as settings.router.ts.
  router.use(requireAuth, createRequireAdmin(db));

  // In memory, like the transcode queue it feeds: a session only spans one
  // admin's upload, and a restart mid-upload loses the browser's side of it
  // anyway. The sweep below is what stops an abandoned one lingering on disk.
  const uploads = new Map<string, UploadSession>();

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - UPLOAD_SESSION_TTL_MS;
    for (const [id, session] of uploads) {
      if (session.touchedAt < cutoff) {
        uploads.delete(id);
        void removeMediaFiles(session.fileId);
      }
    }
  }, 30 * 60 * 1000);
  sweeper.unref();

  // ── Titles ───────────────────────────────────────────────────

  /**
   * The grid's data. A movie's state is its own file's status; a show has no
   * file of its own, so the lateral rolls its episodes up into counts — that
   * is what lets a show card say "3/12 ready" instead of nothing at all.
   */
  router.get("/titles", async (_req: Request, res: Response) => {
    const rows = await db.all(
      `SELECT t.*,
              f.status AS file_status,
              f.error  AS file_error,
              ep.total   AS episode_count,
              ep.ready   AS episode_ready,
              ep.working AS episode_working,
              ep.failed  AS episode_failed
         FROM local_titles t
         LEFT JOIN local_media_files f ON f.id = t.file_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE mf.status = 'ready')::int AS ready,
                  COUNT(*) FILTER (WHERE mf.status IN ('pending','transcoding'))::int AS working,
                  COUNT(*) FILTER (WHERE mf.status = 'failed')::int AS failed
             FROM local_episodes e
             JOIN local_seasons s ON s.id = e.season_id
             LEFT JOIN local_media_files mf ON mf.id = e.file_id
            WHERE s.title_id = t.id
         ) ep ON t.media_type = 'tv'
        ORDER BY t.created_at DESC`,
    );
    res.json(rows);
  });

  router.get("/titles/:id", async (req: Request, res: Response) => {
    const id = param(req.params.id);
    const title = await db.one(
      `SELECT t.*, f.status AS file_status, f.error AS file_error
         FROM local_titles t
         LEFT JOIN local_media_files f ON f.id = t.file_id
        WHERE t.id = $1`,
      [id],
    );
    if (!title) {
      res.status(404).json({ error: "Title not found." });
      return;
    }

    if (title.media_type === "tv") {
      const seasons = await db.all(
        `SELECT * FROM local_seasons WHERE title_id = $1 ORDER BY number ASC`,
        [id],
      );
      for (const season of seasons) {
        season.episodes = await db.all(
          `SELECT e.*, f.status AS file_status, f.error AS file_error
             FROM local_episodes e
             LEFT JOIN local_media_files f ON f.id = e.file_id
            WHERE e.season_id = $1
            ORDER BY e.number ASC`,
          [season.id],
        );
      }
      title.seasons = seasons;
    }

    res.json(title);
  });

  /**
   * Body: `{ mediaType: "movie"|"tv", title?, tmdbId? }`. With `tmdbId`, the
   * title/overview/poster/etc. are snapshotted from TMDB *once*, at creation
   * — not re-fetched live on every read (see tmdb-import.service.ts) — and
   * for a `tv` show every season/episode is pre-created too, so the admin
   * only has to upload a file against each one rather than typing episode
   * metadata by hand.
   */
  router.post("/titles", async (req: Request, res: Response) => {
    const mediaType = req.body?.mediaType === "tv" ? "tv" : req.body?.mediaType === "movie" ? "movie" : null;
    if (!mediaType) {
      res.status(400).json({ error: "mediaType must be 'movie' or 'tv'." });
      return;
    }

    const tmdbIdRaw = req.body?.tmdbId;
    const tmdbId = tmdbIdRaw ? Number(tmdbIdRaw) : null;
    if (tmdbIdRaw && !(Number.isFinite(tmdbId) && tmdbId! > 0)) {
      res.status(400).json({ error: "tmdbId must be a positive number." });
      return;
    }

    let snapshot: Awaited<ReturnType<typeof fetchTmdbMovieSnapshot>> | Awaited<ReturnType<typeof fetchTmdbTvSnapshot>> | null = null;
    if (tmdbId) {
      try {
        snapshot = mediaType === "movie"
          ? await fetchTmdbMovieSnapshot(tmdbId)
          : await fetchTmdbTvSnapshot(tmdbId);
      } catch (err: any) {
        res.status(400).json({ error: err?.message || "TMDB lookup failed." });
        return;
      }
    }

    const title = snapshot?.title || (typeof req.body?.title === "string" ? req.body.title.trim() : "");
    if (!title) {
      res.status(400).json({ error: "title is required (or provide a valid tmdbId)." });
      return;
    }

    const row = await db.one(
      `INSERT INTO local_titles
         (media_type, title, overview, poster, banner, released, runtime, genres, imdb_id, tmdb_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        mediaType,
        title,
        snapshot?.overview ?? null,
        snapshot?.poster ?? null,
        snapshot?.banner ?? null,
        snapshot?.released ?? null,
        mediaType === "movie" ? (snapshot as any)?.runtime ?? null : null,
        JSON.stringify(snapshot?.genres ?? []),
        snapshot?.imdbId ?? null,
        tmdbId,
        req.user!.email,
      ],
    );

    if (mediaType === "tv" && snapshot && "seasonNumbers" in snapshot) {
      for (const seasonNumber of snapshot.seasonNumbers) {
        try {
          const seasonData = await fetchTmdbSeasonSnapshot(tmdbId!, seasonNumber);
          const seasonRow = await db.one(
            `INSERT INTO local_seasons (title_id, number, name, poster) VALUES ($1,$2,$3,$4) RETURNING id`,
            [row.id, seasonNumber, seasonData.name, seasonData.poster],
          );
          for (const ep of seasonData.episodes) {
            await db.query(
              `INSERT INTO local_episodes (season_id, number, title, overview, poster, released)
               VALUES ($1,$2,$3,$4,$5,$6)`,
              [seasonRow.id, ep.number, ep.title, ep.overview, ep.poster, ep.released],
            );
          }
        } catch (err) {
          // One bad season (TMDB hiccup, an empty season) must not sink the
          // whole import — the admin still gets a title back and can add
          // that season manually.
          console.error(`local-provider: failed importing season ${seasonNumber} for tmdb ${tmdbId}:`, err);
        }
      }
    }

    res.status(201).json(row);
  });

  router.delete("/titles/:id", async (req: Request, res: Response) => {
    const id = param(req.params.id);
    const title = await db.one<{ id: string; media_type: string; file_id: string | null }>(
      `SELECT id, media_type, file_id FROM local_titles WHERE id = $1`,
      [id],
    );
    if (!title) {
      res.status(404).json({ error: "Title not found." });
      return;
    }

    const fileIds: string[] = [];
    if (title.file_id) fileIds.push(title.file_id);
    if (title.media_type === "tv") {
      const episodeFiles = await db.all<{ file_id: string }>(
        `SELECT e.file_id
           FROM local_episodes e
           JOIN local_seasons s ON s.id = e.season_id
          WHERE s.title_id = $1 AND e.file_id IS NOT NULL`,
        [id],
      );
      fileIds.push(...episodeFiles.map((r) => r.file_id));
    }

    // Cascades to local_seasons/local_episodes; local_media_files rows have
    // no FK pointing the other way, so they're cleaned up explicitly.
    await db.query(`DELETE FROM local_titles WHERE id = $1`, [id]);
    if (fileIds.length) {
      await db.query(`DELETE FROM local_media_files WHERE id = ANY($1::uuid[])`, [fileIds]);
      await Promise.all(fileIds.map((fid) => removeMediaFiles(fid)));
    }

    res.json({ message: "Title deleted." });
  });

  // ── Seasons / episodes (manual, non-TMDB flow) ─────────────────

  router.post("/titles/:id/seasons", async (req: Request, res: Response) => {
    const titleId = param(req.params.id);
    const title = await db.one<{ id: string; media_type: string }>(
      `SELECT id, media_type FROM local_titles WHERE id = $1`,
      [titleId],
    );
    if (!title || title.media_type !== "tv") {
      res.status(404).json({ error: "Show not found." });
      return;
    }

    const number = Number(req.body?.number);
    if (!Number.isFinite(number) || number < 0) {
      res.status(400).json({ error: "number must be a non-negative integer." });
      return;
    }

    const row = await db.one(
      `INSERT INTO local_seasons (title_id, number, name, poster) VALUES ($1,$2,$3,$4) RETURNING *`,
      [titleId, number, req.body?.name ?? null, req.body?.poster ?? null],
    );
    res.status(201).json(row);
  });

  router.post("/seasons/:id/episodes", async (req: Request, res: Response) => {
    const seasonId = param(req.params.id);
    const season = await db.one<{ id: string }>(`SELECT id FROM local_seasons WHERE id = $1`, [seasonId]);
    if (!season) {
      res.status(404).json({ error: "Season not found." });
      return;
    }

    const number = Number(req.body?.number);
    if (!Number.isFinite(number) || number < 1) {
      res.status(400).json({ error: "number must be a positive integer." });
      return;
    }

    const row = await db.one(
      `INSERT INTO local_episodes (season_id, number, title, overview, poster, released)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [seasonId, number, req.body?.title ?? null, req.body?.overview ?? null, req.body?.poster ?? null, req.body?.released ?? null],
    );
    res.status(201).json(row);
  });

  // ── Uploads (chunked — see CHUNK_SIZE) ────────────────────────
  //
  // Three steps: open a session against a movie/episode, POST the file 8MB
  // at a time, then complete it (which is what creates the
  // `local_media_files` row and starts the transcode). Nothing is linked to
  // the title until the last byte has landed, so an interrupted upload
  // leaves the existing file — if any — playing untouched.

  router.post("/uploads", async (req: Request, res: Response) => {
    const targetKind = req.body?.targetKind === "episode" ? "episode" : req.body?.targetKind === "movie" ? "movie" : null;
    const targetId = typeof req.body?.targetId === "string" ? req.body.targetId : "";
    const filename = typeof req.body?.filename === "string" ? req.body.filename : "";
    const size = Number(req.body?.size);

    if (!targetKind || !targetId) {
      res.status(400).json({ error: "targetKind ('movie'|'episode') and targetId are required." });
      return;
    }
    if (!VIDEO_EXTENSION_RE.test(filename)) {
      res.status(400).json({ error: "That doesn't look like a video file." });
      return;
    }
    if (!Number.isFinite(size) || size <= 0) {
      res.status(400).json({ error: "size must be the file's byte length." });
      return;
    }
    if (size > MAX_UPLOAD_BYTES) {
      res.status(400).json({ error: "File is too large." });
      return;
    }

    const exists = targetKind === "movie"
      ? await db.one<{ id: string }>(
          `SELECT id FROM local_titles WHERE id = $1 AND media_type = 'movie'`,
          [targetId],
        )
      : await db.one<{ id: string }>(`SELECT id FROM local_episodes WHERE id = $1`, [targetId]);
    if (!exists) {
      res.status(404).json({ error: targetKind === "movie" ? "Movie not found." : "Episode not found." });
      return;
    }

    const fileId = crypto.randomUUID();
    const dir = originalDirFor(fileId);
    await fs.promises.mkdir(dir, { recursive: true });
    const destPath = path.join(dir, `original${path.extname(filename).slice(0, 10)}`);

    uploads.set(fileId, {
      fileId,
      filename,
      size,
      received: 0,
      targetKind,
      targetId,
      destPath,
      touchedAt: Date.now(),
    });

    res.status(201).json({ uploadId: fileId, chunkSize: CHUNK_SIZE });
  });

  /**
   * One chunk, sent as a raw body (`application/octet-stream`, which
   * `express.json()` leaves alone) and streamed straight to disk — never
   * buffered whole in memory, so a 20GB upload costs no more RAM than an
   * 8MB one.
   *
   * `?offset=` is checked rather than trusted so a retried chunk can't
   * corrupt the file: a replay of something already written is answered as
   * success (the client's ack was simply lost), and anything else is a 409
   * carrying `received` so the client can resync instead of guessing.
   */
  router.post("/uploads/:id/chunk", async (req: Request, res: Response) => {
    const session = uploads.get(param(req.params.id));
    if (!session) {
      res.status(404).json({ error: "Upload session not found — start the upload again." });
      return;
    }

    const offset = Number(param(req.query.offset));
    if (!Number.isFinite(offset) || offset < 0) {
      res.status(400).json({ error: "offset is required." });
      return;
    }
    const length = Number(req.headers["content-length"] ?? 0);

    if (offset + length <= session.received) {
      res.json({ received: session.received });
      return;
    }
    if (offset !== session.received) {
      res.status(409).json({ error: "Chunk out of order.", received: session.received });
      return;
    }
    if (session.received + length > session.size) {
      res.status(400).json({ error: "Upload is longer than the declared size." });
      return;
    }

    try {
      await pipeline(req, fs.createWriteStream(session.destPath, { flags: "a" }));
    } catch (err) {
      // A dropped connection mid-chunk can leave a partial write, so the
      // authoritative "how much do we actually have" is the file itself,
      // not the byte count we expected.
      const actual = await fs.promises.stat(session.destPath).then((s) => s.size).catch(() => session.received);
      session.received = actual;
      session.touchedAt = Date.now();
      res.status(409).json({ error: "Chunk interrupted.", received: session.received });
      return;
    }

    session.received += length;
    session.touchedAt = Date.now();
    res.json({ received: session.received });
  });

  router.post("/uploads/:id/complete", async (req: Request, res: Response) => {
    const uploadId = param(req.params.id);
    const session = uploads.get(uploadId);
    if (!session) {
      res.status(404).json({ error: "Upload session not found — start the upload again." });
      return;
    }
    if (session.received !== session.size) {
      res.status(409).json({
        error: `Upload is incomplete (${session.received} of ${session.size} bytes).`,
        received: session.received,
      });
      return;
    }

    // Re-read the target now rather than trusting what it looked like when
    // the session opened: a long upload gives an admin plenty of time to
    // delete the title underneath it.
    const target = session.targetKind === "movie"
      ? await db.one<{ id: string; file_id: string | null }>(
          `SELECT id, file_id FROM local_titles WHERE id = $1 AND media_type = 'movie'`,
          [session.targetId],
        )
      : await db.one<{ id: string; file_id: string | null }>(
          `SELECT id, file_id FROM local_episodes WHERE id = $1`,
          [session.targetId],
        );

    uploads.delete(uploadId);

    if (!target) {
      await removeMediaFiles(session.fileId);
      res.status(404).json({ error: "The movie or episode this upload belonged to is gone." });
      return;
    }

    await db.query(
      `INSERT INTO local_media_files (id, original_filename) VALUES ($1, $2)`,
      [session.fileId, session.filename],
    );
    if (session.targetKind === "movie") {
      await db.query(`UPDATE local_titles SET file_id = $1 WHERE id = $2`, [session.fileId, target.id]);
    } else {
      await db.query(`UPDATE local_episodes SET file_id = $1 WHERE id = $2`, [session.fileId, target.id]);
    }

    transcodeService.enqueue(session.fileId, session.destPath);

    if (target.file_id) {
      await db.query(`DELETE FROM local_media_files WHERE id = $1`, [target.file_id]);
      await removeMediaFiles(target.file_id);
    }

    res.status(201).json({ fileId: session.fileId, status: "pending" });
  });

  /** Cancelled from the browser (or a file picked by mistake) — drops the
   *  partial file rather than waiting for the sweeper. */
  router.delete("/uploads/:id", async (req: Request, res: Response) => {
    const uploadId = param(req.params.id);
    const session = uploads.get(uploadId);
    if (session) {
      uploads.delete(uploadId);
      await removeMediaFiles(session.fileId);
    }
    res.json({ message: "Upload cancelled." });
  });

  // ── Transcode status / retry ───────────────────────────────────

  router.get("/files/:id/status", async (req: Request, res: Response) => {
    const id = param(req.params.id);
    const file = await db.one(
      `SELECT id, status, error, duration_seconds FROM local_media_files WHERE id = $1`,
      [id],
    );
    if (!file) {
      res.status(404).json({ error: "File not found." });
      return;
    }
    // `progress` is live from the running ffmpeg (null when queued behind
    // another job, or already finished) — the encode is the long part of
    // this flow, so the admin page draws a real bar for it rather than an
    // indeterminate spinner.
    res.json({ ...file, progress: transcodeService.getProgress(id) });
  });

  router.post("/files/:id/retry", async (req: Request, res: Response) => {
    const id = param(req.params.id);
    const file = await db.one<{ id: string; status: string }>(
      `SELECT id, status FROM local_media_files WHERE id = $1`,
      [id],
    );
    if (!file) {
      res.status(404).json({ error: "File not found." });
      return;
    }
    if (file.status === "ready") {
      res.status(409).json({ error: "Already ready; nothing to retry." });
      return;
    }

    const inputPath = await findOriginalPath(id);
    if (!inputPath) {
      res.status(409).json({ error: "Original upload is gone — re-upload the file instead." });
      return;
    }

    transcodeService.enqueue(id, inputPath);
    res.json({ message: "Re-queued." });
  });

  return router;
}
