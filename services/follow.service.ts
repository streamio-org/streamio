// follow.service.ts
import { Database } from "../database/db.js";
import { Redis } from "../database/redis.js";

// ── Types ────────────────────────────────────────────────────

export interface UserSummary {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
}

export interface FollowSummary extends UserSummary {
  followed_at: Date;
}

export interface FollowCounts {
  followers: number;
  following: number;
}

// ── FollowService ─────────────────────────────────────────────

export class FollowService {
  constructor(
    private readonly db: Database,
    private readonly redis: Redis
  ) {}

  async follow(followerId: string, followeeId: string): Promise<void> {
    if (followerId === followeeId) {
      throw new Error("CANNOT_FOLLOW_SELF");
    }

    const target = await this.db.one<{ id: string }>(
      `SELECT id FROM users WHERE id = $1`,
      [followeeId]
    );
    if (!target) {
      throw new Error("USER_NOT_FOUND");
    }

    await this.db.query(
      `INSERT INTO follows (follower_id, followee_id)
       VALUES ($1, $2)
       ON CONFLICT (follower_id, followee_id) DO NOTHING`,
      [followerId, followeeId]
    );
  }

  async unfollow(followerId: string, followeeId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2`,
      [followerId, followeeId]
    );
  }

  async isFollowing(followerId: string, followeeId: string): Promise<boolean> {
    const row = await this.db.one(
      `SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2`,
      [followerId, followeeId]
    );
    return row !== null;
  }

  async getFollowers(userId: string, limit: number, offset: number): Promise<FollowSummary[]> {
    return this.db.all<FollowSummary>(
      `SELECT u.id, u.display_name, u.avatar_url, f.created_at AS followed_at
       FROM follows f
       JOIN users u ON u.id = f.follower_id
       WHERE f.followee_id = $1
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
  }

  async getFollowing(userId: string, limit: number, offset: number): Promise<FollowSummary[]> {
    return this.db.all<FollowSummary>(
      `SELECT u.id, u.display_name, u.avatar_url, f.created_at AS followed_at
       FROM follows f
       JOIN users u ON u.id = f.followee_id
       WHERE f.follower_id = $1
       ORDER BY f.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset]
    );
  }

  async getFollowCounts(userId: string): Promise<FollowCounts> {
    const row = await this.db.one<{ followers: string; following: string }>(
      `SELECT
         (SELECT COUNT(*) FROM follows WHERE followee_id = $1) AS followers,
         (SELECT COUNT(*) FROM follows WHERE follower_id = $1) AS following`,
      [userId]
    );
    return {
      followers: parseInt(row?.followers ?? "0", 10),
      following: parseInt(row?.following ?? "0", 10),
    };
  }

  async searchUsers(
    currentUserId: string,
    query: string,
    limit: number,
    offset: number
  ): Promise<UserSummary[]> {
    const escaped = query.replace(/[%_\\]/g, (ch) => `\\${ch}`);
    return this.db.all<UserSummary>(
      `SELECT id, display_name, avatar_url
       FROM users
       WHERE id != $1 AND display_name ILIKE $2 ESCAPE '\\'
       ORDER BY display_name ASC
       LIMIT $3 OFFSET $4`,
      [currentUserId, `%${escaped}%`, limit, offset]
    );
  }
}
