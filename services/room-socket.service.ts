// room-socket.service.ts
//
// In-memory registry of live WebSocket connections per room, keyed by room
// code. Room membership/ownership/state persistence lives in RoomService
// (Postgres) — this class only fans a state/presence change out to whoever
// is currently connected to that room on *this* server process. Rooms are
// single-server (no cross-instance pub/sub); that's fine for the expected
// scale (a handful of friends watching together).
import type { WebSocket } from "ws";
import type { JwtPayload } from "../auth/jwt.js";
import type { RoomDetail, RoomMemberSummary, RoomState, RoomStatePatch } from "./room.service.js";
import { RoomService } from "./room.service.js";

interface ClientMeta {
  userId: string;
  displayName: string | null;
}

type ServerMessage =
  | { type: "state"; state: RoomState; members: RoomMemberSummary[]; ownerId: string }
  | { type: "state_update"; state: RoomState; from: { id: string; display_name: string | null } }
  | { type: "presence"; members: RoomMemberSummary[]; ownerId: string }
  | { type: "closed"; reason: string }
  | { type: "error"; message: string }
  | { type: "pong" };

// A room with zero live WebSocket connections for this long gets deleted —
// nobody is actually watching, so there's no reason for it to keep showing
// up as an active watch party. Long enough to survive a page refresh /
// brief reconnect blip (room-sync.js's own backoff tops out at 15s).
const EMPTY_ROOM_GRACE_MS = 2 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;

export class RoomHub {
  private rooms = new Map<string, Map<WebSocket, ClientMeta>>();
  // Room code -> timestamp it was last observed with zero live connections.
  // Seeded at room creation and whenever the last socket in a room closes;
  // cleared as soon as any socket (re)connects. Swept on a timer below.
  private emptySince = new Map<string, number>();

  constructor(private readonly roomService: RoomService) {}

  /** Start the idle-room reaper. Also re-seeds every room that currently
   * exists in the DB so a restart doesn't leave abandoned rooms stranded
   * forever (this in-memory map has no state to go on right after boot). */
  async init() {
    try {
      const codes = await this.roomService.listAllCodes();
      const now = Date.now();
      for (const code of codes) this.emptySince.set(code.toUpperCase(), now);
    } catch (err) {
      console.error("RoomHub: failed to seed empty-room timers on startup:", err);
    }
    setInterval(() => this.sweepEmptyRooms(), SWEEP_INTERVAL_MS);
  }

  private async sweepEmptyRooms() {
    const now = Date.now();
    for (const [code, since] of this.emptySince) {
      if ((this.rooms.get(code)?.size ?? 0) > 0) {
        this.emptySince.delete(code);
        continue;
      }
      if (now - since < EMPTY_ROOM_GRACE_MS) continue;

      this.emptySince.delete(code);
      this.rooms.delete(code);
      try {
        await this.roomService.deleteRoomByCode(code);
      } catch (err) {
        console.error(`RoomHub: failed to delete idle room ${code}:`, err);
      }
    }
  }

  /** Called by room.router.ts right after a room is created or REST-joined,
   * so the empty-room clock starts fresh even before a socket connects. */
  registerActivity(code: string) {
    this.emptySince.set(code.toUpperCase(), Date.now());
  }

  async handleConnection(ws: WebSocket, room: RoomDetail, user: JwtPayload) {
    const member = room.members.find((m) => m.id === user.sub);
    const meta: ClientMeta = { userId: user.sub, displayName: member?.display_name ?? null };

    let clients = this.rooms.get(room.code);
    if (!clients) {
      clients = new Map();
      this.rooms.set(room.code, clients);
    }
    clients.set(ws, meta);
    this.emptySince.delete(room.code);

    this.send(ws, { type: "state", state: room.state, members: room.members, ownerId: room.ownerId });
    this.broadcastToRoom(room.code, { type: "presence", members: room.members, ownerId: room.ownerId }, ws);

    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg?.type === "state") {
        try {
          const patch = readStatePatch(msg.payload);
          const state = await this.roomService.updateState(room.code, user.sub, patch);
          if (state) {
            this.broadcastToRoom(
              room.code,
              { type: "state_update", state, from: { id: meta.userId, display_name: meta.displayName } },
              ws
            );
          }
        } catch (err: any) {
          this.send(ws, { type: "error", message: err?.message === "FORBIDDEN" ? "Not a room member." : "Could not update room state." });
        }
      } else if (msg?.type === "ping") {
        this.send(ws, { type: "pong" });
      }
    });

    ws.on("close", () => {
      const set = this.rooms.get(room.code);
      if (!set) return;
      set.delete(ws);
      if (set.size === 0) {
        this.rooms.delete(room.code);
        this.emptySince.set(room.code, Date.now());
      }
    });
  }

  private send(ws: WebSocket, data: ServerMessage) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
  }

  private broadcastToRoom(code: string, data: ServerMessage, exclude?: WebSocket) {
    const clients = this.rooms.get(code);
    if (!clients) return;
    for (const ws of clients.keys()) {
      if (ws === exclude) continue;
      this.send(ws, data);
    }
  }

  /** Called by room.router.ts after a REST join/leave changes membership. */
  notifyMembersChanged(code: string, members: RoomMemberSummary[], ownerId: string) {
    this.broadcastToRoom(code, { type: "presence", members, ownerId });
  }

  /** Called by room.router.ts when the owner closes the room or the last member leaves. */
  closeRoom(code: string, reason: string) {
    const upper = code.toUpperCase();
    const clients = this.rooms.get(upper);
    if (clients) {
      for (const ws of clients.keys()) {
        this.send(ws, { type: "closed", reason });
        ws.close();
      }
    }
    this.rooms.delete(upper);
    this.emptySince.delete(upper);
  }
}

function readStatePatch(payload: unknown): RoomStatePatch {
  if (!payload || typeof payload !== "object") return {};
  const p = payload as Record<string, unknown>;
  const patch: RoomStatePatch = {};

  if (typeof p.provider === "string") patch.provider = p.provider;
  if (typeof p.showId === "string") patch.showId = p.showId;
  if (p.episodeId === null) patch.episodeId = null;
  else if (typeof p.episodeId === "string") patch.episodeId = p.episodeId;
  if (p.episodeLabel === null) patch.episodeLabel = null;
  else if (typeof p.episodeLabel === "string") patch.episodeLabel = p.episodeLabel;
  if (p.contentType === "movie" || p.contentType === "episode") patch.contentType = p.contentType;
  if (typeof p.playing === "boolean") patch.playing = p.playing;
  if (typeof p.positionSeconds === "number" && Number.isFinite(p.positionSeconds)) {
    patch.positionSeconds = Math.max(0, p.positionSeconds);
  }

  return patch;
}
