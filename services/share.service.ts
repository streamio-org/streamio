// share.service.ts
import type pg from "pg";
import { Database } from "../database/db.js";
import { Redis } from "../database/redis.js";
import type { UserSummary } from "./follow.service.js";

// ── Reactions ────────────────────────────────────────────────

export const ALLOWED_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥"] as const;
export type ReactionEmoji = (typeof ALLOWED_REACTIONS)[number];

export function isAllowedReaction(value: unknown): value is ReactionEmoji {
  return typeof value === "string" && (ALLOWED_REACTIONS as readonly string[]).includes(value);
}

// ── Types ────────────────────────────────────────────────────

export interface CreateShareParams {
  provider: string;
  showId: string;
  episodeId?: string | null;
  episodeLabel?: string | null;
  clipStartSeconds?: number | null;
  clipEndSeconds?: number | null;
  message?: string | null;
  recipientIds: string[];
}

interface ShareRow {
  id: string;
  sender_id: string;
  provider: string;
  show_id: string;
  episode_id: string | null;
  episode_label: string | null;
  clip_start_seconds: number | null;
  clip_end_seconds: number | null;
  message: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ReactionSummary {
  user: UserSummary;
  emoji: ReactionEmoji;
  created_at: Date;
}

export interface ShareRecipientSummary extends UserSummary {
  read_at: Date | null;
}

export interface ShareDetail {
  id: string;
  sender: UserSummary;
  provider: string;
  show_id: string;
  episode_id: string | null;
  episode_label: string | null;
  clip_start_seconds: number | null;
  clip_end_seconds: number | null;
  message: string | null;
  created_at: Date;
  recipients: ShareRecipientSummary[];
  reactions: ReactionSummary[];
}

export interface ShareSummary extends ShareRow {
  sender: UserSummary;
  recipients: ShareRecipientSummary[];
  reaction_count: number;
  read_at?: Date | null;
}

// ── ShareService ─────────────────────────────────────────────

export class ShareService {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis
  ) {}

  private async assertParticipant(shareId: string, userId: string): Promise<boolean> {
    const row = await this.db.one(
      `SELECT 1
       FROM shares s
       WHERE s.id = $1
         AND (
           s.sender_id = $2
           OR EXISTS (
             SELECT 1 FROM share_recipients sr
             WHERE sr.share_id = s.id AND sr.recipient_id = $2
           )
         )`,
      [shareId, userId]
    );
    return row !== null;
  }

  private userSummary(id: string, displayName: string | null, avatarUrl: string | null): UserSummary {
    return { id, display_name: displayName, avatar_url: avatarUrl };
  }

  async createShare(senderId: string, params: CreateShareParams): Promise<ShareDetail> {
    const recipientIds = Array.from(new Set(params.recipientIds)).filter((id) => id !== senderId);

    if (recipientIds.length === 0) {
      throw new Error("NO_RECIPIENTS");
    }

    const existing = await this.db.all<{ id: string }>(
      `SELECT id FROM users WHERE id = ANY($1::uuid[])`,
      [recipientIds]
    );
    if (existing.length !== recipientIds.length) {
      throw new Error("RECIPIENT_NOT_FOUND");
    }

    const shareId = await this.db.transaction(async (client: pg.PoolClient) => {
      const shareResult = await client.query<ShareRow>(
        `INSERT INTO shares (
           sender_id, provider, show_id, episode_id, episode_label,
           clip_start_seconds, clip_end_seconds, message
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          senderId,
          params.provider,
          params.showId,
          params.episodeId ?? null,
          params.episodeLabel ?? null,
          params.clipStartSeconds ?? null,
          params.clipEndSeconds ?? null,
          params.message ?? null,
        ]
      );
      const newShareId = shareResult.rows[0].id;

      await client.query(
        `INSERT INTO share_recipients (share_id, recipient_id)
         SELECT $1, unnest($2::uuid[])
         ON CONFLICT DO NOTHING`,
        [newShareId, recipientIds]
      );

      return newShareId;
    });

    const detail = await this.getShareById(shareId, senderId);
    return detail!;
  }

  async getShareById(shareId: string, requestingUserId: string): Promise<ShareDetail | null> {
    const isParticipant = await this.assertParticipant(shareId, requestingUserId);
    if (!isParticipant) return null;

    const share = await this.db.one<ShareRow & { sender_display_name: string | null; sender_avatar_url: string | null }>(
      `SELECT s.*, u.display_name AS sender_display_name, u.avatar_url AS sender_avatar_url
       FROM shares s
       JOIN users u ON u.id = s.sender_id
       WHERE s.id = $1`,
      [shareId]
    );
    if (!share) return null;

    const recipients = await this.db.all<{
      id: string;
      display_name: string | null;
      avatar_url: string | null;
      read_at: Date | null;
    }>(
      `SELECT u.id, u.display_name, u.avatar_url, sr.read_at
       FROM share_recipients sr
       JOIN users u ON u.id = sr.recipient_id
       WHERE sr.share_id = $1
       ORDER BY sr.created_at ASC`,
      [shareId]
    );

    const reactions = await this.db.all<{
      id: string;
      display_name: string | null;
      avatar_url: string | null;
      emoji: ReactionEmoji;
      created_at: Date;
    }>(
      `SELECT u.id, u.display_name, u.avatar_url, r.emoji, r.created_at
       FROM share_reactions r
       JOIN users u ON u.id = r.user_id
       WHERE r.share_id = $1
       ORDER BY r.created_at ASC`,
      [shareId]
    );

    return {
      id: share.id,
      sender: this.userSummary(share.sender_id, share.sender_display_name, share.sender_avatar_url),
      provider: share.provider,
      show_id: share.show_id,
      episode_id: share.episode_id,
      episode_label: share.episode_label,
      clip_start_seconds: share.clip_start_seconds,
      clip_end_seconds: share.clip_end_seconds,
      message: share.message,
      created_at: share.created_at,
      recipients: recipients.map((r) => ({
        id: r.id,
        display_name: r.display_name,
        avatar_url: r.avatar_url,
        read_at: r.read_at,
      })),
      reactions: reactions.map((r) => ({
        user: this.userSummary(r.id, r.display_name, r.avatar_url),
        emoji: r.emoji,
        created_at: r.created_at,
      })),
    };
  }

  async listInbox(userId: string, limit: number, offset: number): Promise<ShareSummary[]> {
    return this.db.all<ShareSummary>(
      `SELECT
         s.id, s.sender_id, s.provider, s.show_id, s.episode_id, s.episode_label,
         s.clip_start_seconds, s.clip_end_seconds, s.message, s.created_at, s.updated_at,
         sr.read_at,
         json_build_object('id', u.id, 'display_name', u.display_name, 'avatar_url', u.avatar_url) AS sender,
         COALESCE(
           (SELECT COUNT(*) FROM share_reactions rc WHERE rc.share_id = s.id), 0
         ) AS reaction_count
       FROM shares s
       JOIN share_recipients sr ON sr.share_id = s.id
       JOIN users u ON u.id = s.sender_id
       WHERE sr.recipient_id = $1
       ORDER BY s.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
  }

  async listSent(userId: string, limit: number, offset: number): Promise<ShareSummary[]> {
    return this.db.all<ShareSummary>(
      `SELECT
         s.id, s.sender_id, s.provider, s.show_id, s.episode_id, s.episode_label,
         s.clip_start_seconds, s.clip_end_seconds, s.message, s.created_at, s.updated_at,
         COALESCE(
           (SELECT json_agg(json_build_object('id', ru.id, 'display_name', ru.display_name, 'avatar_url', ru.avatar_url, 'read_at', sr.read_at))
            FROM share_recipients sr
            JOIN users ru ON ru.id = sr.recipient_id
            WHERE sr.share_id = s.id), '[]'
         ) AS recipients,
         COALESCE(
           (SELECT COUNT(*) FROM share_reactions rc WHERE rc.share_id = s.id), 0
         ) AS reaction_count
       FROM shares s
       WHERE s.sender_id = $1
       ORDER BY s.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
  }

  async markRead(shareId: string, recipientId: string): Promise<void> {
    await this.db.query(
      `UPDATE share_recipients
       SET read_at = NOW()
       WHERE share_id = $1 AND recipient_id = $2 AND read_at IS NULL`,
      [shareId, recipientId]
    );
  }

  async countUnread(recipientId: string): Promise<number> {
    const row = await this.db.one<{ count: string }>(
      `SELECT COUNT(*) AS count FROM share_recipients WHERE recipient_id = $1 AND read_at IS NULL`,
      [recipientId]
    );
    return parseInt(row?.count ?? "0", 10);
  }

  async deleteShare(shareId: string, userId: string): Promise<"deleted_all" | "deleted_own_copy"> {
    const share = await this.db.one<{ sender_id: string }>(
      `SELECT sender_id FROM shares WHERE id = $1`,
      [shareId]
    );
    if (!share) {
      throw new Error("FORBIDDEN");
    }

    if (share.sender_id === userId) {
      await this.db.query(`DELETE FROM shares WHERE id = $1`, [shareId]);
      return "deleted_all";
    }

    const isRecipient = await this.db.one(
      `SELECT 1 FROM share_recipients WHERE share_id = $1 AND recipient_id = $2`,
      [shareId, userId]
    );
    if (!isRecipient) {
      throw new Error("FORBIDDEN");
    }

    await this.db.query(
      `DELETE FROM share_recipients WHERE share_id = $1 AND recipient_id = $2`,
      [shareId, userId]
    );
    await this.db.query(
      `DELETE FROM share_reactions WHERE share_id = $1 AND user_id = $2`,
      [shareId, userId]
    );
    return "deleted_own_copy";
  }

  async setReaction(shareId: string, userId: string, emoji: ReactionEmoji): Promise<ReactionSummary> {
    const isParticipant = await this.assertParticipant(shareId, userId);
    if (!isParticipant) {
      throw new Error("FORBIDDEN");
    }
    if (!isAllowedReaction(emoji)) {
      throw new Error("INVALID_EMOJI");
    }

    await this.db.query(
      `INSERT INTO share_reactions (share_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT (share_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji, updated_at = NOW()`,
      [shareId, userId, emoji]
    );

    const user = await this.db.one<{ id: string; display_name: string | null; avatar_url: string | null }>(
      `SELECT id, display_name, avatar_url FROM users WHERE id = $1`,
      [userId]
    );

    return {
      user: this.userSummary(user!.id, user!.display_name, user!.avatar_url),
      emoji,
      created_at: new Date(),
    };
  }

  async removeReaction(shareId: string, userId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM share_reactions WHERE share_id = $1 AND user_id = $2`,
      [shareId, userId]
    );
  }

  async getReactions(shareId: string, requestingUserId: string): Promise<ReactionSummary[] | null> {
    const isParticipant = await this.assertParticipant(shareId, requestingUserId);
    if (!isParticipant) return null;

    const rows = await this.db.all<{
      id: string;
      display_name: string | null;
      avatar_url: string | null;
      emoji: ReactionEmoji;
      created_at: Date;
    }>(
      `SELECT u.id, u.display_name, u.avatar_url, r.emoji, r.created_at
       FROM share_reactions r
       JOIN users u ON u.id = r.user_id
       WHERE r.share_id = $1
       ORDER BY r.created_at ASC`,
      [shareId]
    );

    return rows.map((r) => ({
      user: this.userSummary(r.id, r.display_name, r.avatar_url),
      emoji: r.emoji,
      created_at: r.created_at,
    }));
  }
}
