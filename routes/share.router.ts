import { Router, type Request, type Response } from "express";
import { ALLOWED_REACTIONS, isAllowedReaction, ShareService } from "../services/share.service.js";
import { requireAuth } from "../auth/middleware.js";
import { shareLimiter } from "../auth/rateLimit.js";
import type { Redis } from "../database/redis.js";
import type { Database } from "../database/db.js";

function parsePagination(req: Request) {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const offset = parseInt(req.query.offset as string) || 0;
  return { limit, offset };
}

export function createShareRouter(db: Database, redis: Redis): Router {
  const router = Router();
  const service = new ShareService(db, redis);

  router.use(requireAuth);

  // ── POST /api/social/shares ────────────────────────────────
  router.post("/shares", shareLimiter(redis), async (req: Request, res: Response) => {
    const {
      provider,
      show_id,
      episode_id,
      episode_label,
      clip_start_seconds,
      clip_end_seconds,
      message,
      recipient_ids,
    } = req.body;

    if (!provider || !show_id) {
      res.status(400).json({ error: "provider and show_id are required." });
      return;
    }
    if (!Array.isArray(recipient_ids) || recipient_ids.length === 0) {
      res.status(400).json({ error: "recipient_ids must be a non-empty array." });
      return;
    }
    if (
      (clip_start_seconds !== undefined && clip_start_seconds !== null) !==
      (clip_end_seconds !== undefined && clip_end_seconds !== null)
    ) {
      res.status(400).json({ error: "clip_start_seconds and clip_end_seconds must be provided together." });
      return;
    }
    if (message !== undefined && message !== null && String(message).length > 500) {
      res.status(400).json({ error: "message must be at most 500 characters." });
      return;
    }

    try {
      const share = await service.createShare(req.user!.sub, {
        provider: String(provider),
        showId: String(show_id),
        episodeId: episode_id ?? null,
        episodeLabel: episode_label ?? null,
        clipStartSeconds: clip_start_seconds != null ? Number(clip_start_seconds) : null,
        clipEndSeconds: clip_end_seconds != null ? Number(clip_end_seconds) : null,
        message: message ?? null,
        recipientIds: recipient_ids.map(String),
      });
      res.status(201).json(share);
    } catch (err: any) {
      if (err.message === "NO_RECIPIENTS") {
        res.status(400).json({ error: "You must include at least one recipient other than yourself." });
        return;
      }
      if (err.message === "RECIPIENT_NOT_FOUND") {
        res.status(404).json({ error: "One or more recipients were not found." });
        return;
      }
      throw err;
    }
  });

  // ── GET /api/social/shares/inbox ───────────────────────────
  router.get("/shares/inbox", async (req: Request, res: Response) => {
    const { limit, offset } = parsePagination(req);
    const items = await service.listInbox(req.user!.sub, limit, offset);
    res.json(items);
  });

  // ── GET /api/social/shares/sent ────────────────────────────
  router.get("/shares/sent", async (req: Request, res: Response) => {
    const { limit, offset } = parsePagination(req);
    const items = await service.listSent(req.user!.sub, limit, offset);
    res.json(items);
  });

  // ── GET /api/social/shares/unread-count ────────────────────
  router.get("/shares/unread-count", async (req: Request, res: Response) => {
    const count = await service.countUnread(req.user!.sub);
    res.json({ count });
  });

  // ── GET /api/social/shares/:shareId ────────────────────────
  router.get("/shares/:shareId", async (req: Request, res: Response) => {
    const shareId = Array.isArray(req.params.shareId) ? req.params.shareId[0] : req.params.shareId;
    const share = await service.getShareById(shareId, req.user!.sub);
    if (!share) {
      res.status(404).json({ error: "Share not found." });
      return;
    }
    res.json(share);
  });

  // ── DELETE /api/social/shares/:shareId ─────────────────────
  router.delete("/shares/:shareId", async (req: Request, res: Response) => {
    const shareId = Array.isArray(req.params.shareId) ? req.params.shareId[0] : req.params.shareId;
    try {
      const result = await service.deleteShare(shareId, req.user!.sub);
      res.json({
        message: result === "deleted_all" ? "Share deleted." : "Removed from your inbox.",
      });
    } catch (err: any) {
      if (err.message === "FORBIDDEN") {
        res.status(403).json({ error: "You are not authorized to delete this share." });
        return;
      }
      throw err;
    }
  });

  // ── PATCH /api/social/shares/:shareId/read ─────────────────
  router.patch("/shares/:shareId/read", async (req: Request, res: Response) => {
    const shareId = Array.isArray(req.params.shareId) ? req.params.shareId[0] : req.params.shareId;
    await service.markRead(shareId, req.user!.sub);
    res.json({ message: "Marked as read." });
  });

  // ── PUT /api/social/shares/:shareId/reaction ───────────────
  router.put("/shares/:shareId/reaction", async (req: Request, res: Response) => {
    const shareId = Array.isArray(req.params.shareId) ? req.params.shareId[0] : req.params.shareId;
    const { emoji } = req.body;

    if (!isAllowedReaction(emoji)) {
      res.status(400).json({ error: `emoji must be one of: ${ALLOWED_REACTIONS.join(" ")}` });
      return;
    }

    try {
      const reaction = await service.setReaction(shareId, req.user!.sub, emoji);
      res.json(reaction);
    } catch (err: any) {
      if (err.message === "FORBIDDEN") {
        res.status(403).json({ error: "You are not authorized to react to this share." });
        return;
      }
      throw err;
    }
  });

  // ── DELETE /api/social/shares/:shareId/reaction ────────────
  router.delete("/shares/:shareId/reaction", async (req: Request, res: Response) => {
    const shareId = Array.isArray(req.params.shareId) ? req.params.shareId[0] : req.params.shareId;
    await service.removeReaction(shareId, req.user!.sub);
    res.json({ message: "Reaction removed." });
  });

  // ── GET /api/social/shares/:shareId/reactions ──────────────
  router.get("/shares/:shareId/reactions", async (req: Request, res: Response) => {
    const shareId = Array.isArray(req.params.shareId) ? req.params.shareId[0] : req.params.shareId;
    const reactions = await service.getReactions(shareId, req.user!.sub);
    if (reactions === null) {
      res.status(404).json({ error: "Share not found." });
      return;
    }
    res.json(reactions);
  });

  return router;
}
