// room.router.ts
import { Router, type Request, type Response } from "express";
import { RoomService, type ContentType } from "../services/room.service.js";
import type { RoomHub } from "../services/room-socket.service.js";
import { requireAuth } from "../auth/middleware.js";

const VALID_CONTENT_TYPES: ContentType[] = ["movie", "episode"];

function readCode(req: Request): string {
  const raw = req.params.code;
  return (Array.isArray(raw) ? raw[0] : raw).toUpperCase();
}

export function createRoomRouter(roomService: RoomService, roomHub: RoomHub): Router {
  const router = Router();
  router.use(requireAuth);

  // ── POST /api/rooms ─────────────────────────────────────────
  router.post("/", async (req: Request, res: Response) => {
    const { provider, show_id, episode_id, episode_label, content_type } = req.body;

    if (!provider || !show_id) {
      res.status(400).json({ error: "provider and show_id are required." });
      return;
    }

    const contentType: ContentType = VALID_CONTENT_TYPES.includes(content_type)
      ? content_type
      : "movie";

    const room = await roomService.createRoom(req.user!.sub, {
      provider: String(provider),
      showId: String(show_id),
      episodeId: episode_id ?? null,
      episodeLabel: episode_label ?? null,
      contentType,
    });
    roomHub.registerActivity(room.code);
    res.status(201).json(room);
  });

  // ── GET /api/rooms/mine ─────────────────────────────────────
  router.get("/mine", async (req: Request, res: Response) => {
    const rooms = await roomService.listMine(req.user!.sub);
    res.json(rooms);
  });

  // ── GET /api/rooms/:code ─────────────────────────────────────
  router.get("/:code", async (req: Request, res: Response) => {
    const room = await roomService.getRoomDetail(readCode(req), req.user!.sub);
    if (!room) {
      res.status(404).json({ error: "Room not found." });
      return;
    }
    res.json(room);
  });

  // ── POST /api/rooms/:code/join ───────────────────────────────
  router.post("/:code/join", async (req: Request, res: Response) => {
    const code = readCode(req);
    try {
      const room = await roomService.joinRoom(code, req.user!.sub);
      roomHub.registerActivity(room.code);
      roomHub.notifyMembersChanged(room.code, room.members, room.ownerId);
      res.json(room);
    } catch (err: any) {
      if (err.message === "ROOM_NOT_FOUND") {
        res.status(404).json({ error: "Room not found." });
        return;
      }
      throw err;
    }
  });

  // ── POST /api/rooms/:code/leave ──────────────────────────────
  router.post("/:code/leave", async (req: Request, res: Response) => {
    const code = readCode(req);
    try {
      const room = await roomService.leaveRoom(code, req.user!.sub);
      if (room) {
        roomHub.notifyMembersChanged(room.code, room.members, room.ownerId);
      } else {
        roomHub.closeRoom(code, "empty");
      }
      res.json({ message: "Left room." });
    } catch (err: any) {
      if (err.message === "ROOM_NOT_FOUND") {
        res.status(404).json({ error: "Room not found." });
        return;
      }
      throw err;
    }
  });

  // ── DELETE /api/rooms/:code ──────────────────────────────────
  router.delete("/:code", async (req: Request, res: Response) => {
    const code = readCode(req);
    try {
      await roomService.closeRoom(code, req.user!.sub);
      roomHub.closeRoom(code, "closed_by_owner");
      res.json({ message: "Room closed." });
    } catch (err: any) {
      if (err.message === "ROOM_NOT_FOUND") {
        res.status(404).json({ error: "Room not found." });
        return;
      }
      if (err.message === "FORBIDDEN") {
        res.status(403).json({ error: "Only the room owner can close it." });
        return;
      }
      throw err;
    }
  });

  return router;
}
