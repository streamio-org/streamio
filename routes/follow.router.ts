import { Router, type Request, type Response } from "express";
import { FollowService } from "../services/follow.service.js";
import { requireAuth } from "../auth/middleware.js";
import type { Redis } from "../database/redis.js";
import type { Database } from "../database/db.js";

function parsePagination(req: Request) {
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const offset = parseInt(req.query.offset as string) || 0;
  return { limit, offset };
}

export function createFollowRouter(db: Database, redis: Redis): Router {
  const router = Router();
  const service = new FollowService(db, redis);

  router.use(requireAuth);

  // ── GET /api/social/users/search ──────────────────────────
  router.get("/users/search", async (req: Request, res: Response) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      res.status(400).json({ error: "q is required." });
      return;
    }

    const { limit, offset } = parsePagination(req);
    const users = await service.searchUsers(req.user!.sub, q, limit, offset);
    res.json(users);
  });

  // ── POST /api/social/follows/:userId ──────────────────────
  router.post("/follows/:userId", async (req: Request, res: Response) => {
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;

    try {
      await service.follow(req.user!.sub, userId);
      res.status(201).json({ message: "Followed." });
    } catch (err: any) {
      if (err.message === "CANNOT_FOLLOW_SELF") {
        res.status(400).json({ error: "You cannot follow yourself." });
        return;
      }
      if (err.message === "USER_NOT_FOUND") {
        res.status(404).json({ error: "User not found." });
        return;
      }
      throw err;
    }
  });

  // ── DELETE /api/social/follows/:userId ────────────────────
  router.delete("/follows/:userId", async (req: Request, res: Response) => {
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    await service.unfollow(req.user!.sub, userId);
    res.json({ message: "Unfollowed." });
  });

  // ── GET /api/social/follows/:userId/status ────────────────
  router.get("/follows/:userId/status", async (req: Request, res: Response) => {
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    const following = await service.isFollowing(req.user!.sub, userId);
    res.json({ following });
  });

  // ── GET /api/social/users/:userId/followers ───────────────
  router.get("/users/:userId/followers", async (req: Request, res: Response) => {
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    const { limit, offset } = parsePagination(req);
    const followers = await service.getFollowers(userId, limit, offset);
    res.json(followers);
  });

  // ── GET /api/social/users/:userId/following ───────────────
  router.get("/users/:userId/following", async (req: Request, res: Response) => {
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    const { limit, offset } = parsePagination(req);
    const following = await service.getFollowing(userId, limit, offset);
    res.json(following);
  });

  // ── GET /api/social/users/:userId/follow-counts ───────────
  router.get("/users/:userId/follow-counts", async (req: Request, res: Response) => {
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    const counts = await service.getFollowCounts(userId);
    res.json(counts);
  });

  // ── GET /api/social/me/follow-counts ──────────────────────
  router.get("/me/follow-counts", async (req: Request, res: Response) => {
    const counts = await service.getFollowCounts(req.user!.sub);
    res.json(counts);
  });

  return router;
}
