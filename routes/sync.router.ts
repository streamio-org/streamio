import { Router, type Request, type Response, type NextFunction } from "express";
import { SettingsService } from "../services/settings.service.js";
import { SyncService } from "../services/sync.service.js";
import type { Database } from "../database/db.js";
import type { Redis } from "../database/redis.js";

// Peer-facing sync endpoints, authenticated with the shared secret configured
// for the calling hosting point (not the JWT user auth used elsewhere).
export function createSyncRouter(db: Database, redis: Redis): Router {
  const router = Router();
  const settingsService = new SettingsService(db);
  const syncService = new SyncService(db, redis);

  const requireHostingPointSecret = async (req: Request, res: Response, next: NextFunction) => {
    const secret = req.header("X-Sync-Secret");
    if (!secret) {
      res.status(401).json({ error: "Unauthorized", message: "Missing X-Sync-Secret header." });
      return;
    }

    const peer = await settingsService.findHostingPointBySecret(secret);
    if (!peer) {
      res.status(401).json({ error: "Unauthorized", message: "Unknown hosting point secret." });
      return;
    }

    next();
  };

  router.get("/export", requireHostingPointSecret, async (req: Request, res: Response) => {
    const sinceParam = req.query.since;
    const since = typeof sinceParam === "string" && !isNaN(Date.parse(sinceParam))
      ? new Date(sinceParam)
      : new Date(0);

    const data = await syncService.exportChanges(since);
    res.json(data);
  });

  return router;
}
