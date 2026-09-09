// room.service.ts
import crypto from "node:crypto";
import type pg from "pg";
import { Database } from "../database/db.js";

// Ambiguous characters (0/O, 1/I/L) dropped so codes are easy to read aloud
// or type from a screen.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export type ContentType = "movie" | "episode";

export interface CreateRoomParams {
  provider: string;
  showId: string;
  episodeId?: string | null;
  episodeLabel?: string | null;
  contentType: ContentType;
}

export interface RoomStatePatch {
  provider?: string;
  showId?: string;
  episodeId?: string | null;
  episodeLabel?: string | null;
  contentType?: ContentType;
  playing?: boolean;
  positionSeconds?: number;
}

export interface RoomState {
  provider: string;
  showId: string;
  episodeId: string | null;
  episodeLabel: string | null;
  contentType: ContentType;
  playing: boolean;
  positionSeconds: number;
  updatedAt: string;
}

export interface RoomMemberSummary {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  is_owner: boolean;
}

export interface RoomDetail {
  id: string;
  code: string;
  ownerId: string;
  createdAt: string;
  state: RoomState;
  members: RoomMemberSummary[];
  isMember: boolean;
}

interface RoomRow {
  id: string;
  code: string;
  owner_id: string;
  provider: string;
  show_id: string;
  episode_id: string | null;
  episode_label: string | null;
  content_type: ContentType;
  playing: boolean;
  position_seconds: number;
  state_updated_at: Date;
  created_at: Date;
}

export class RoomService {
  constructor(private readonly db: Database) {}

  private toState(row: RoomRow): RoomState {
    return {
      provider: row.provider,
      showId: row.show_id,
      episodeId: row.episode_id,
      episodeLabel: row.episode_label,
      contentType: row.content_type,
      playing: row.playing,
      positionSeconds: Number(row.position_seconds),
      updatedAt: row.state_updated_at.toISOString(),
    };
  }

  private async getMembers(roomId: string, ownerId: string): Promise<RoomMemberSummary[]> {
    const rows = await this.db.all<{
      id: string;
      display_name: string | null;
      avatar_url: string | null;
    }>(
      `SELECT u.id, u.display_name, u.avatar_url
       FROM room_members rm
       JOIN users u ON u.id = rm.user_id
       WHERE rm.room_id = $1
       ORDER BY rm.joined_at ASC`,
      [roomId]
    );
    return rows.map((r) => ({
      id: r.id,
      display_name: r.display_name,
      avatar_url: r.avatar_url,
      is_owner: r.id === ownerId,
    }));
  }

  private async toDetail(row: RoomRow, requestingUserId?: string): Promise<RoomDetail> {
    const members = await this.getMembers(row.id, row.owner_id);
    return {
      id: row.id,
      code: row.code,
      ownerId: row.owner_id,
      createdAt: row.created_at.toISOString(),
      state: this.toState(row),
      members,
      isMember: requestingUserId ? members.some((m) => m.id === requestingUserId) : false,
    };
  }

  async createRoom(ownerId: string, params: CreateRoomParams): Promise<RoomDetail> {
    // The SELECT-then-INSERT below isn't atomic, so two concurrent creates
    // could in principle pick the same free code and race on the UNIQUE
    // constraint. That's a ~1-in-9e8 shot per pair of requests, but retry a
    // couple of times on the unique-violation (23505) rather than surfacing
    // a raw DB error.
    for (let outerAttempt = 0; outerAttempt < 3; outerAttempt++) {
      try {
        const row = await this.db.transaction(async (client: pg.PoolClient) => {
          let code = "";
          for (let attempt = 0; attempt < 8; attempt++) {
            const candidate = generateCode();
            const existing = await client.query(`SELECT 1 FROM rooms WHERE code = $1`, [candidate]);
            if (existing.rowCount === 0) {
              code = candidate;
              break;
            }
          }
          if (!code) throw new Error("CODE_GENERATION_FAILED");

          const result = await client.query<RoomRow>(
            `INSERT INTO rooms (code, owner_id, provider, show_id, episode_id, episode_label, content_type)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
              code,
              ownerId,
              params.provider,
              params.showId,
              params.episodeId ?? null,
              params.episodeLabel ?? null,
              params.contentType,
            ]
          );
          const newRoom = result.rows[0];

          await client.query(`INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)`, [
            newRoom.id,
            ownerId,
          ]);

          return newRoom;
        });

        return this.toDetail(row, ownerId);
      } catch (err: any) {
        if (err?.code !== "23505" || outerAttempt === 2) throw err;
      }
    }
    throw new Error("CODE_GENERATION_FAILED");
  }

  /**
   * Removes userId from every room they're in, applying the same
   * ownership-transfer-or-close rules as leaveRoom() for each one. Used by
   * account deletion so a deleted owner's rooms are handed off to another
   * member (or closed) instead of being cascade-deleted out from under
   * everyone else still in them.
   */
  async leaveAllRooms(userId: string): Promise<Array<{ code: string; room: RoomDetail | null }>> {
    const rooms = await this.listMine(userId);
    const results: Array<{ code: string; room: RoomDetail | null }> = [];
    for (const r of rooms) {
      results.push({ code: r.code, room: await this.leaveRoom(r.code, userId) });
    }
    return results;
  }

  async getRoomByCode(code: string): Promise<RoomRow | null> {
    return this.db.one<RoomRow>(`SELECT * FROM rooms WHERE code = $1`, [code.toUpperCase()]);
  }

  async getRoomDetail(code: string, requestingUserId?: string): Promise<RoomDetail | null> {
    const row = await this.getRoomByCode(code);
    if (!row) return null;
    return this.toDetail(row, requestingUserId);
  }

  async joinRoom(code: string, userId: string): Promise<RoomDetail> {
    const row = await this.getRoomByCode(code);
    if (!row) throw new Error("ROOM_NOT_FOUND");

    await this.db.query(
      `INSERT INTO room_members (room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [row.id, userId]
    );

    return this.toDetail(row, userId);
  }

  /** Returns null if the room was closed as a side effect (no members left). */
  async leaveRoom(code: string, userId: string): Promise<RoomDetail | null> {
    const row = await this.getRoomByCode(code);
    if (!row) throw new Error("ROOM_NOT_FOUND");

    await this.db.query(`DELETE FROM room_members WHERE room_id = $1 AND user_id = $2`, [
      row.id,
      userId,
    ]);

    const remaining = await this.db.all<{ user_id: string }>(
      `SELECT user_id FROM room_members WHERE room_id = $1 ORDER BY joined_at ASC`,
      [row.id]
    );

    if (remaining.length === 0) {
      await this.db.query(`DELETE FROM rooms WHERE id = $1`, [row.id]);
      return null;
    }

    let ownerId = row.owner_id;
    if (ownerId === userId) {
      ownerId = remaining[0].user_id;
      await this.db.query(`UPDATE rooms SET owner_id = $1 WHERE id = $2`, [ownerId, row.id]);
    }

    return this.toDetail({ ...row, owner_id: ownerId });
  }

  async closeRoom(code: string, requestingUserId: string): Promise<void> {
    const row = await this.getRoomByCode(code);
    if (!row) throw new Error("ROOM_NOT_FOUND");
    if (row.owner_id !== requestingUserId) throw new Error("FORBIDDEN");
    await this.db.query(`DELETE FROM rooms WHERE id = $1`, [row.id]);
  }

  /** System cleanup (no owner check) for rooms nobody is actively connected to. */
  async deleteRoomByCode(code: string): Promise<boolean> {
    const result = await this.db.query(`DELETE FROM rooms WHERE code = $1`, [code.toUpperCase()]);
    return (result.rowCount ?? 0) > 0;
  }

  async listAllCodes(): Promise<string[]> {
    const rows = await this.db.all<{ code: string }>(`SELECT code FROM rooms`);
    return rows.map((r) => r.code);
  }

  async listMine(userId: string): Promise<RoomDetail[]> {
    const rows = await this.db.all<RoomRow>(
      `SELECT r.* FROM rooms r
       JOIN room_members rm ON rm.room_id = r.id
       WHERE rm.user_id = $1
       ORDER BY r.updated_at DESC`,
      [userId]
    );
    return Promise.all(rows.map((r) => this.toDetail(r, userId)));
  }

  async isMember(code: string, userId: string): Promise<boolean> {
    const row = await this.db.one(
      `SELECT 1 FROM rooms r
       JOIN room_members rm ON rm.room_id = r.id
       WHERE r.code = $1 AND rm.user_id = $2`,
      [code.toUpperCase(), userId]
    );
    return row !== null;
  }

  async updateState(code: string, userId: string, patch: RoomStatePatch): Promise<RoomState | null> {
    const row = await this.getRoomByCode(code);
    if (!row) return null;

    const member = await this.db.one(
      `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
      [row.id, userId]
    );
    if (!member) throw new Error("FORBIDDEN");

    const next = {
      provider: patch.provider ?? row.provider,
      show_id: patch.showId ?? row.show_id,
      episode_id: patch.episodeId !== undefined ? patch.episodeId : row.episode_id,
      episode_label: patch.episodeLabel !== undefined ? patch.episodeLabel : row.episode_label,
      content_type: patch.contentType ?? row.content_type,
      playing: patch.playing !== undefined ? patch.playing : row.playing,
      position_seconds:
        patch.positionSeconds !== undefined ? patch.positionSeconds : row.position_seconds,
    };

    const updated = await this.db.one<RoomRow>(
      `UPDATE rooms
       SET provider = $1, show_id = $2, episode_id = $3, episode_label = $4,
           content_type = $5, playing = $6, position_seconds = $7, state_updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [
        next.provider,
        next.show_id,
        next.episode_id,
        next.episode_label,
        next.content_type,
        next.playing,
        next.position_seconds,
        row.id,
      ]
    );

    return this.toState(updated!);
  }
}
