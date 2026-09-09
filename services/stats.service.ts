// stats.service.ts
//
// Per-account statistics, and the badges they earn.
//
// Everything here is private to the account it describes: the routes that
// expose it are all `requireAuth` and always read `req.user.sub`, never an id
// from the request. Nothing in this service takes a "whose stats" parameter
// from outside.
//
// Reads are cheap enough to do live (a dozen indexed aggregates, run in
// parallel) and are deliberately not cached — the same read awards badges, and
// a user who just crossed a threshold should see the badge on the page that
// made them cross it, not a minute later.

import type { Database } from "../database/db.js";
import { BADGES, isEarned, type BadgeDefinition } from "./badges.catalog.js";

/**
 * A snapshot of one account's numbers.
 *
 * Two of these are accumulated counters (`total_watch_seconds`, the streak
 * fields, which read `user_watch_days`); the rest are derived live from the
 * library tables. See database/migrations/003_stats_badges.sql for why those
 * two can't be derived.
 */
export interface UserStats {
  /** Lifetime seconds of playback, accumulated per progress report. */
  total_watch_seconds: number;

  /** Episodes marked completed. Movies are counted separately. */
  episodes_completed: number;
  /** Movies marked completed (history rows with no episode id). */
  movies_completed: number;
  /** Episodes started but not finished. */
  episodes_in_progress: number;
  /** Distinct (provider, show) pairs ever played. */
  titles_started: number;
  /**
   * Shows where every episode in your history is completed (at least one).
   *
   * Deliberately not "watched all episodes that exist" — the true episode count
   * lives upstream and would cost a provider fetch per show to learn, and for a
   * running series it changes under you. This measures the honest local fact:
   * you left nothing you started unfinished.
   */
  shows_completed: number;

  watchlist_count: number;
  favorites_count: number;
  ratings_count: number;
  /** Mean of your own 1–10 ratings, or null if you haven't rated anything. */
  average_rating: number | null;

  /** Distinct provider slugs you've watched from. */
  providers_used: number;
  /** The provider slug you've watched most, or null. */
  top_provider: string | null;

  /** Distinct days with any viewing activity. */
  active_days: number;
  /** Consecutive days up to today (or yesterday, mid-day) with activity. */
  current_streak_days: number;
  /** The longest such run ever. */
  longest_streak_days: number;

  followers_count: number;
  following_count: number;
  shares_sent: number;
  shares_received: number;
  /** Reactions other people left on things you shared. */
  reactions_received: number;

  member_since: string | null;
  first_watch_at: string | null;
  last_watch_at: string | null;
}

/** A badge as the account page sees it: definition + where you stand on it. */
export interface BadgeStatus {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: BadgeDefinition["category"];
  tier: number;
  threshold: number;
  /** Your current value of the stat this badge measures. */
  progress: number;
  earned: boolean;
  /** When it was first earned, ISO — null while unearned. */
  earned_at: string | null;
}

export class StatsService {
  constructor(private db: Database) {}

  async getStats(userId: string): Promise<UserStats> {
    const [counters, history, shows, library, providers, streaks, social] = await Promise.all([
      this.counters(userId),
      this.historyTotals(userId),
      this.showsCompleted(userId),
      this.libraryTotals(userId),
      this.providerTotals(userId),
      this.streaks(userId),
      this.socialTotals(userId),
    ]);

    return {
      total_watch_seconds: counters.total_watch_seconds,
      member_since:        counters.member_since,

      episodes_completed:   history.episodes_completed,
      movies_completed:     history.movies_completed,
      episodes_in_progress: history.episodes_in_progress,
      titles_started:       history.titles_started,
      first_watch_at:       history.first_watch_at,
      last_watch_at:        history.last_watch_at,

      shows_completed: shows,

      watchlist_count: library.watchlist_count,
      favorites_count: library.favorites_count,
      ratings_count:   library.ratings_count,
      average_rating:  library.average_rating,

      providers_used: providers.providers_used,
      top_provider:   providers.top_provider,

      active_days:         streaks.active_days,
      current_streak_days: streaks.current_streak_days,
      longest_streak_days: streaks.longest_streak_days,

      followers_count:    social.followers_count,
      following_count:    social.following_count,
      shares_sent:        social.shares_sent,
      shares_received:    social.shares_received,
      reactions_received: social.reactions_received,
    };
  }

  /**
   * Stats plus every badge, with the ones newly earned by these stats recorded
   * first — so `earned_at` is set the moment a threshold is crossed rather than
   * whenever the page next happens to load.
   */
  async getStatsWithBadges(userId: string): Promise<{ stats: UserStats; badges: BadgeStatus[] }> {
    const stats = await this.getStats(userId);
    const badges = await this.syncBadges(userId, stats);
    return { stats, badges };
  }

  /**
   * Awards any badge whose threshold these stats now clear, then reports the
   * whole catalogue.
   *
   * Awarding is `ON CONFLICT DO NOTHING`, so a badge keeps the timestamp of the
   * first time it was earned however many times this runs. Nothing is ever
   * revoked: a badge already in the table is reported earned even if the stat
   * behind it has since dropped (history cleared, a follower lost).
   */
  private async syncBadges(userId: string, stats: UserStats): Promise<BadgeStatus[]> {
    const nowEarned = BADGES.filter((b) => isEarned(b, stats)).map((b) => b.id);

    if (nowEarned.length) {
      await this.db.query(
        `INSERT INTO user_badges (user_id, badge_id)
        SELECT $1, badge_id FROM UNNEST($2::text[]) AS badge_id
        ON CONFLICT (user_id, badge_id) DO NOTHING`,
        [userId, nowEarned]
      );
    }

    const rows = await this.db.all<{ badge_id: string; earned_at: Date }>(
      `SELECT badge_id, earned_at FROM user_badges WHERE user_id = $1`,
      [userId]
    );
    const earnedAt = new Map<string, string>(
      rows.map((r) => [r.badge_id, r.earned_at.toISOString()] as const)
    );

    return BADGES.map((badge) => ({
      id:          badge.id,
      name:        badge.name,
      description: badge.description,
      icon:        badge.icon,
      category:    badge.category,
      tier:        badge.tier,
      threshold:   badge.threshold,
      progress:    Math.min(numeric(stats[badge.stat]), badge.threshold),
      earned:      earnedAt.has(badge.id),
      earned_at:   earnedAt.get(badge.id) ?? null,
    }));
  }

  // ── Individual aggregates ──────────────────────────────────

  private async counters(userId: string) {
    const row = await this.db.one<{ total_watch_seconds: string; created_at: Date }>(
      `SELECT COALESCE(s.total_watch_seconds, 0) AS total_watch_seconds, u.created_at
      FROM users u
      LEFT JOIN user_stats s ON s.user_id = u.id
      WHERE u.id = $1`,
      [userId]
    );
    return {
      // BIGINT arrives as a string from pg — Number() it here, not at the edge.
      total_watch_seconds: numeric(row?.total_watch_seconds),
      member_since: row?.created_at ? row.created_at.toISOString() : null,
    };
  }

  private async historyTotals(userId: string) {
    const row = await this.db.one(
      `SELECT
        COUNT(*) FILTER (WHERE completed AND episode_id IS NOT NULL)         AS episodes_completed,
        COUNT(*) FILTER (WHERE completed AND episode_id IS NULL)             AS movies_completed,
        COUNT(*) FILTER (WHERE NOT completed AND progress_seconds > 60)      AS episodes_in_progress,
        COUNT(DISTINCT (provider, show_id))                                  AS titles_started,
        MIN(watched_at)                                                      AS first_watch_at,
        MAX(watched_at)                                                      AS last_watch_at
      FROM watch_history
      WHERE user_id = $1`,
      [userId]
    );
    return {
      episodes_completed:   numeric(row?.episodes_completed),
      movies_completed:     numeric(row?.movies_completed),
      episodes_in_progress: numeric(row?.episodes_in_progress),
      titles_started:       numeric(row?.titles_started),
      first_watch_at:       row?.first_watch_at ? row.first_watch_at.toISOString() : null,
      last_watch_at:        row?.last_watch_at ? row.last_watch_at.toISOString() : null,
    };
  }

  private async showsCompleted(userId: string) {
    const row = await this.db.one(
      `SELECT COUNT(*) AS n FROM (
        SELECT provider, show_id
        FROM watch_history
        WHERE user_id = $1 AND episode_id IS NOT NULL
        GROUP BY provider, show_id
        HAVING COUNT(*) FILTER (WHERE NOT completed) = 0
      ) finished`,
      [userId]
    );
    return numeric(row?.n);
  }

  private async libraryTotals(userId: string) {
    const row = await this.db.one(
      `SELECT
        (SELECT COUNT(*) FROM watchlist WHERE user_id = $1) AS watchlist_count,
        (SELECT COUNT(*) FROM favorites WHERE user_id = $1) AS favorites_count,
        (SELECT COUNT(*) FROM ratings   WHERE user_id = $1) AS ratings_count,
        (SELECT AVG(rating) FROM ratings WHERE user_id = $1) AS average_rating`,
      [userId]
    );
    return {
      watchlist_count: numeric(row?.watchlist_count),
      favorites_count: numeric(row?.favorites_count),
      ratings_count:   numeric(row?.ratings_count),
      average_rating:
        row?.average_rating != null ? Math.round(Number(row.average_rating) * 10) / 10 : null,
    };
  }

  private async providerTotals(userId: string) {
    const rows = await this.db.all<{ provider: string; n: string }>(
      `SELECT provider, COUNT(*) AS n
      FROM watch_history
      WHERE user_id = $1
      GROUP BY provider
      ORDER BY n DESC`,
      [userId]
    );
    return {
      providers_used: rows.length,
      top_provider:   rows[0]?.provider ?? null,
    };
  }

  /**
   * Streaks over `user_watch_days`, by the gaps-and-islands trick: for
   * consecutive dates, `day - row_number()` is constant, so it groups each
   * unbroken run.
   *
   * The current streak allows the run to end *yesterday* as well as today —
   * otherwise every streak in the world reads as broken until its owner presses
   * play, which is exactly when they'd most want to see it standing.
   */
  private async streaks(userId: string) {
    const row = await this.db.one(
      `WITH days AS (
        SELECT day, (day - (ROW_NUMBER() OVER (ORDER BY day))::int) AS grp
        FROM user_watch_days
        WHERE user_id = $1
      ),
      islands AS (
        SELECT grp, COUNT(*)::int AS length, MAX(day) AS last_day
        FROM days GROUP BY grp
      )
      SELECT
        (SELECT COUNT(*) FROM user_watch_days WHERE user_id = $1) AS active_days,
        COALESCE(MAX(length), 0) AS longest_streak_days,
        COALESCE(
          MAX(length) FILTER (WHERE last_day >= (NOW() AT TIME ZONE 'UTC')::date - 1),
          0
        ) AS current_streak_days
      FROM islands`,
      [userId]
    );
    return {
      active_days:         numeric(row?.active_days),
      current_streak_days: numeric(row?.current_streak_days),
      longest_streak_days: numeric(row?.longest_streak_days),
    };
  }

  private async socialTotals(userId: string) {
    const row = await this.db.one(
      `SELECT
        (SELECT COUNT(*) FROM follows WHERE followee_id = $1) AS followers_count,
        (SELECT COUNT(*) FROM follows WHERE follower_id = $1) AS following_count,
        (SELECT COUNT(*) FROM shares  WHERE sender_id  = $1)  AS shares_sent,
        (SELECT COUNT(*) FROM share_recipients WHERE recipient_id = $1) AS shares_received,
        (SELECT COUNT(*)
         FROM share_reactions r
         JOIN shares s ON s.id = r.share_id
         WHERE s.sender_id = $1 AND r.user_id <> $1) AS reactions_received`,
      [userId]
    );
    return {
      followers_count:    numeric(row?.followers_count),
      following_count:    numeric(row?.following_count),
      shares_sent:        numeric(row?.shares_sent),
      shares_received:    numeric(row?.shares_received),
      reactions_received: numeric(row?.reactions_received),
    };
  }
}

/** COUNT() and BIGINT come back as strings from pg; nulls come back as null. */
function numeric(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
