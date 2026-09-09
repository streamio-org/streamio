// badges.catalog.ts
//
// The badge catalogue: every badge a user can earn, and the stat threshold
// that earns it.
//
// This is deliberately code and not a table. A badge is a name, an icon and a
// number — all three are content, all three get reworded, and none of them are
// worth a migration. `database/migrations/003_stats_badges.sql` stores only the
// slug of what was earned and when.
//
// Adding a badge here awards it retroactively on the owner's next stats read,
// to everyone whose numbers already clear it. That is intended. Renaming a slug
// is not backwards compatible — it orphans every row already earned under the
// old one, so treat slugs as permanent and change the label instead.

import type { UserStats } from "./stats.service.js";

/** The stat families a badge can key off. Used to group the badge grid. */
export type BadgeCategory =
  | "time"
  | "episodes"
  | "movies"
  | "shows"
  | "streak"
  | "library"
  | "ratings"
  | "social"
  | "explorer";

export interface BadgeDefinition {
  /** Permanent slug, stored in user_badges.badge_id. Never reuse or rename. */
  id: string;
  name: string;
  description: string;
  icon: string;
  category: BadgeCategory;
  /**
   * Tier within its category, 1 upwards. Badges of the same category form a
   * ladder — the UI shows the next unearned tier as the goal to chase, so
   * thresholds inside a category must increase with tier.
   */
  tier: number;
  /** The stat this badge measures, and the value that earns it. */
  stat: keyof UserStats;
  threshold: number;
}

const HOUR = 3600;

export const BADGES: BadgeDefinition[] = [
  // ── Watch time ─────────────────────────────────────────────
  { id: "time-1h",    name: "First Hour",     description: "Watched for 1 hour in total.",       icon: "🌱", category: "time", tier: 1, stat: "total_watch_seconds", threshold: 1 * HOUR },
  { id: "time-10h",   name: "Regular",        description: "Watched for 10 hours in total.",     icon: "⏱️", category: "time", tier: 2, stat: "total_watch_seconds", threshold: 10 * HOUR },
  { id: "time-50h",   name: "Marathoner",     description: "Watched for 50 hours in total.",     icon: "🏃", category: "time", tier: 3, stat: "total_watch_seconds", threshold: 50 * HOUR },
  { id: "time-100h",  name: "Centurion",      description: "Watched for 100 hours in total.",    icon: "💯", category: "time", tier: 4, stat: "total_watch_seconds", threshold: 100 * HOUR },
  { id: "time-500h",  name: "Screen Veteran", description: "Watched for 500 hours in total.",    icon: "🎖️", category: "time", tier: 5, stat: "total_watch_seconds", threshold: 500 * HOUR },
  { id: "time-1000h", name: "Time Lord",      description: "Watched for 1,000 hours in total.",  icon: "⌛", category: "time", tier: 6, stat: "total_watch_seconds", threshold: 1000 * HOUR },

  // ── Episodes ───────────────────────────────────────────────
  { id: "eps-10",   name: "Getting Hooked", description: "Finished 10 episodes.",    icon: "📺", category: "episodes", tier: 1, stat: "episodes_completed", threshold: 10 },
  { id: "eps-100",  name: "Binge Watcher",  description: "Finished 100 episodes.",   icon: "🍿", category: "episodes", tier: 2, stat: "episodes_completed", threshold: 100 },
  { id: "eps-500",  name: "Serial Viewer",  description: "Finished 500 episodes.",   icon: "📼", category: "episodes", tier: 3, stat: "episodes_completed", threshold: 500 },
  { id: "eps-1000", name: "Episode Master", description: "Finished 1,000 episodes.", icon: "👑", category: "episodes", tier: 4, stat: "episodes_completed", threshold: 1000 },

  // ── Movies ─────────────────────────────────────────────────
  { id: "movies-5",   name: "Movie Night",  description: "Finished 5 movies.",   icon: "🎬", category: "movies", tier: 1, stat: "movies_completed", threshold: 5 },
  { id: "movies-25",  name: "Film Buff",    description: "Finished 25 movies.",  icon: "🎞️", category: "movies", tier: 2, stat: "movies_completed", threshold: 25 },
  { id: "movies-100", name: "Cinephile",    description: "Finished 100 movies.", icon: "🏆", category: "movies", tier: 3, stat: "movies_completed", threshold: 100 },

  // ── Shows finished ─────────────────────────────────────────
  { id: "shows-1",  name: "The End",       description: "Finished every episode you started of a show.", icon: "✅", category: "shows", tier: 1, stat: "shows_completed", threshold: 1 },
  { id: "shows-10", name: "Completionist", description: "Finished 10 shows.",                            icon: "📚", category: "shows", tier: 2, stat: "shows_completed", threshold: 10 },
  { id: "shows-50", name: "Archivist",     description: "Finished 50 shows.",                            icon: "🗃️", category: "shows", tier: 3, stat: "shows_completed", threshold: 50 },

  // ── Streaks ────────────────────────────────────────────────
  { id: "streak-3",   name: "Three in a Row", description: "Watched something 3 days running.",   icon: "🔗", category: "streak", tier: 1, stat: "longest_streak_days", threshold: 3 },
  { id: "streak-7",   name: "Week Streak",    description: "Watched something 7 days running.",   icon: "🔥", category: "streak", tier: 2, stat: "longest_streak_days", threshold: 7 },
  { id: "streak-30",  name: "Month Streak",   description: "Watched something 30 days running.",  icon: "☄️", category: "streak", tier: 3, stat: "longest_streak_days", threshold: 30 },
  { id: "streak-100", name: "Unbroken",       description: "Watched something 100 days running.", icon: "💎", category: "streak", tier: 4, stat: "longest_streak_days", threshold: 100 },

  // ── Library ────────────────────────────────────────────────
  { id: "watchlist-10", name: "Planner",   description: "Kept 10 titles in your watchlist.", icon: "🔖", category: "library", tier: 1, stat: "watchlist_count", threshold: 10 },
  { id: "watchlist-50", name: "Hoarder",   description: "Kept 50 titles in your watchlist.", icon: "🗂️", category: "library", tier: 2, stat: "watchlist_count", threshold: 50 },
  { id: "favorites-10", name: "Curator",   description: "Marked 10 titles as favorites.",    icon: "⭐", category: "library", tier: 3, stat: "favorites_count", threshold: 10 },
  { id: "favorites-50", name: "Tastemaker", description: "Marked 50 titles as favorites.",   icon: "🌟", category: "library", tier: 4, stat: "favorites_count", threshold: 50 },

  // ── Ratings ────────────────────────────────────────────────
  { id: "ratings-1",   name: "First Verdict", description: "Rated a title.",     icon: "✍️", category: "ratings", tier: 1, stat: "ratings_count", threshold: 1 },
  { id: "ratings-25",  name: "Critic",        description: "Rated 25 titles.",   icon: "📝", category: "ratings", tier: 2, stat: "ratings_count", threshold: 25 },
  { id: "ratings-100", name: "Chief Critic",  description: "Rated 100 titles.",  icon: "🧑‍⚖️", category: "ratings", tier: 3, stat: "ratings_count", threshold: 100 },

  // ── Social ─────────────────────────────────────────────────
  { id: "shares-1",     name: "Passed It On",  description: "Shared something with a friend.", icon: "📤", category: "social", tier: 1, stat: "shares_sent",       threshold: 1 },
  { id: "shares-25",    name: "Broadcaster",   description: "Sent 25 shares.",                 icon: "📡", category: "social", tier: 2, stat: "shares_sent",       threshold: 25 },
  { id: "followers-1",  name: "Noticed",       description: "Gained your first follower.",     icon: "👋", category: "social", tier: 3, stat: "followers_count",   threshold: 1 },
  { id: "followers-10", name: "Popular",       description: "Gained 10 followers.",            icon: "🎉", category: "social", tier: 4, stat: "followers_count",   threshold: 10 },
  { id: "reactions-25", name: "Crowd Pleaser", description: "Got 25 reactions on your shares.", icon: "❤️", category: "social", tier: 5, stat: "reactions_received", threshold: 25 },

  // ── Explorer ───────────────────────────────────────────────
  { id: "providers-3", name: "Explorer",  description: "Watched from 3 different providers.", icon: "🧭", category: "explorer", tier: 1, stat: "providers_used", threshold: 3 },
  { id: "providers-6", name: "Globetrotter", description: "Watched from 6 different providers.", icon: "🌍", category: "explorer", tier: 2, stat: "providers_used", threshold: 6 },
];

export const CATEGORY_LABELS: Record<BadgeCategory, string> = {
  time:     "Watch time",
  episodes: "Episodes",
  movies:   "Movies",
  shows:    "Shows",
  streak:   "Streaks",
  library:  "Library",
  ratings:  "Ratings",
  social:   "Social",
  explorer: "Discovery",
};

/** The value a badge measures, read off a stats snapshot. */
export function badgeProgress(badge: BadgeDefinition, stats: UserStats): number {
  const value = stats[badge.stat];
  return typeof value === "number" ? value : 0;
}

export function isEarned(badge: BadgeDefinition, stats: UserStats): boolean {
  return badgeProgress(badge, stats) >= badge.threshold;
}
