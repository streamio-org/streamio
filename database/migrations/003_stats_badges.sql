-- ============================================================
-- 003_stats_badges.sql
--
-- Per-account statistics and the badges they earn.
--
-- Almost every stat is *derived* at read time from tables that already exist
-- (watch_history, watchlist, favorites, ratings, follows, shares) — nothing is
-- duplicated here that a query can answer. The two exceptions are the two
-- things those tables structurally cannot answer, because watch_history keeps
-- one upserted row per title/episode rather than an event log:
--
--   * total watch time — a row only remembers the furthest point reached, so a
--     rewatch, or watching an episode twice, adds nothing to a SUM. The counter
--     below accumulates the *delta* of each progress report instead.
--   * which days were watched on — a row carries one watched_at, overwritten on
--     every later report, so a day's activity disappears as soon as the same
--     episode is touched again. Streaks need the day set kept separately.
--
-- Both are written from the same statement that records watch progress
-- (AccountService.upsertWatchProgress), so they cannot drift from it, and both
-- deliberately survive "clear history" — deleting the log of *what* was watched
-- shouldn't retroactively un-earn the time spent watching it.
-- ============================================================

-- ── Accumulated counters ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_stats (
  user_id             UUID        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  total_watch_seconds BIGINT      NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Existing installs have watch history but no counter. Seed each user with the
-- progress already recorded so nobody starts back at zero; from here on the
-- counter only ever moves by deltas.
INSERT INTO user_stats (user_id, total_watch_seconds)
SELECT user_id, LEAST(SUM(GREATEST(progress_seconds, 0)), 100000000)
FROM watch_history
GROUP BY user_id
ON CONFLICT (user_id) DO NOTHING;

-- ── Days with viewing activity ───────────────────────────────
-- One row per (user, calendar day). Written on every progress report; the day
-- is UTC, matching every other timestamp in this schema.
CREATE TABLE IF NOT EXISTS user_watch_days (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day     DATE NOT NULL,
  PRIMARY KEY (user_id, day)
);

-- Seed from whatever watched_at values survive today. This undercounts history
-- (a row remembers only its most recent view), but it means a long-standing
-- account doesn't look brand new on the day this ships.
INSERT INTO user_watch_days (user_id, day)
SELECT DISTINCT user_id, (watched_at AT TIME ZONE 'UTC')::date
FROM watch_history
ON CONFLICT DO NOTHING;

-- ── Earned badges ────────────────────────────────────────────
-- `badge_id` is a slug from the catalogue in services/badges.catalog.ts, not a
-- foreign key: the catalogue is code, so it can gain badges and reword them
-- without a migration. A row is written the first time a threshold is crossed
-- and never removed — earned_at is a fact about the past, so a badge does not
-- un-earn if the underlying stat later drops.
CREATE TABLE IF NOT EXISTS user_badges (
  user_id   UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  badge_id  TEXT        NOT NULL,
  earned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, badge_id)
);

CREATE INDEX IF NOT EXISTS user_badges_user_idx ON user_badges (user_id, earned_at DESC);
