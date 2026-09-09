-- ============================================================
-- 001_accounts.sql
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Users ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email              TEXT        NOT NULL UNIQUE,
  display_name       TEXT,
  avatar_url         TEXT,
  password_hash      TEXT,                        -- NULL for OAuth-only accounts
  email_verified     BOOLEAN     NOT NULL DEFAULT FALSE,
  verification_token TEXT,
  reset_token        TEXT,
  reset_token_exp    TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);

-- ── OAuth accounts ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oauth_accounts (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider         TEXT        NOT NULL,   -- 'google' | 'discord'
  provider_user_id TEXT        NOT NULL,
  access_token     TEXT,
  refresh_token    TEXT,
  token_exp        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS oauth_accounts_user_idx ON oauth_accounts (user_id);

-- ── Refresh tokens ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT        NOT NULL UNIQUE,   -- SHA-256 of the raw token
  expires_at TIMESTAMPTZ NOT NULL,
  revoked    BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx  ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_token_idx ON refresh_tokens (token_hash);

-- ── Watchlist ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watchlist (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider   TEXT        NOT NULL,
  show_id    TEXT        NOT NULL,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider, show_id)
);

CREATE INDEX IF NOT EXISTS watchlist_user_idx ON watchlist (user_id);

-- ── Watch history ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS watch_history (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider         TEXT        NOT NULL,
  show_id          TEXT        NOT NULL,
  episode_id       TEXT,
  episode_label    TEXT,
  progress_seconds INT         NOT NULL DEFAULT 0,
  duration_seconds INT,
  completed        BOOLEAN     NOT NULL DEFAULT FALSE,
  watched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS watch_history_user_idx ON watch_history (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS watch_history_episode_unique
  ON watch_history (user_id, show_id, episode_id)
  WHERE episode_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS watch_history_movie_unique
  ON watch_history (user_id, show_id)
  WHERE episode_id IS NULL;

-- ── Favorites ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS favorites (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider   TEXT        NOT NULL,
  show_id    TEXT        NOT NULL,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider, show_id)
);

CREATE INDEX IF NOT EXISTS favorites_user_idx ON favorites (user_id);

-- ── Ratings ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ratings (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider   TEXT        NOT NULL,
  show_id    TEXT        NOT NULL,
  rating     INT       NOT NULL CHECK (rating >= 1 AND rating <= 10),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, provider, show_id)
);

CREATE INDEX IF NOT EXISTS ratings_user_idx ON ratings (user_id);

-- ── User preferences ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id    UUID  NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key        TEXT  NOT NULL,
  value      JSONB NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- ── Search logs ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS search_logs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider   TEXT        NOT NULL,
  query      TEXT        NOT NULL,
  page       INT         NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS search_logs_provider_idx   ON search_logs (provider);
CREATE INDEX IF NOT EXISTS search_logs_created_at_idx ON search_logs (created_at);

-- ── Follows ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS follows (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  follower_id  UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  followee_id  UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (follower_id, followee_id),
  CHECK (follower_id != followee_id)
);

CREATE INDEX IF NOT EXISTS follows_follower_idx ON follows (follower_id);
CREATE INDEX IF NOT EXISTS follows_followee_idx ON follows (followee_id);

-- ── Shares ───────────────────────────────────────────────────
-- One row per share event, created by the sender. Content ref follows the
-- same (provider, show_id, episode_id) triple used by watchlist/favorites/
-- ratings/watch_history, plus optional clip start/end seconds.
CREATE TABLE IF NOT EXISTS shares (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id          UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider           TEXT        NOT NULL,
  show_id            TEXT        NOT NULL,
  episode_id         TEXT,
  episode_label      TEXT,
  clip_start_seconds INT,
  clip_end_seconds   INT,
  message            TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (clip_start_seconds IS NULL AND clip_end_seconds IS NULL)
    OR (clip_start_seconds IS NOT NULL AND clip_end_seconds IS NOT NULL
        AND clip_end_seconds > clip_start_seconds AND clip_start_seconds >= 0)
  ),
  CHECK (message IS NULL OR char_length(message) <= 500)
);

CREATE INDEX IF NOT EXISTS shares_sender_idx  ON shares (sender_id);
CREATE INDEX IF NOT EXISTS shares_content_idx ON shares (provider, show_id, episode_id);

-- ── Share recipients ─────────────────────────────────────────
-- One row per (share, recipient) — lets a recipient delete their own copy
-- independently of the sender/other recipients, and tracks read state.
CREATE TABLE IF NOT EXISTS share_recipients (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id     UUID        NOT NULL REFERENCES shares (id) ON DELETE CASCADE,
  recipient_id UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  read_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (share_id, recipient_id)
);

CREATE INDEX IF NOT EXISTS share_recipients_share_idx     ON share_recipients (share_id);
CREATE INDEX IF NOT EXISTS share_recipients_recipient_idx ON share_recipients (recipient_id);

-- ── Share reactions ──────────────────────────────────────────
-- Scoped to share_id (not the per-recipient row) so the sender can react to
-- their own share too. One active reaction per user per share via UNIQUE +
-- upsert (ON CONFLICT DO UPDATE).
CREATE TABLE IF NOT EXISTS share_reactions (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id   UUID        NOT NULL REFERENCES shares (id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  emoji      TEXT        NOT NULL CHECK (emoji IN ('👍', '❤️', '😂', '😮', '😢', '🔥')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (share_id, user_id)
);

CREATE INDEX IF NOT EXISTS share_reactions_share_idx ON share_reactions (share_id);
CREATE INDEX IF NOT EXISTS share_reactions_user_idx  ON share_reactions (user_id);

-- ── updated_at trigger ───────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER oauth_accounts_updated_at
  BEFORE UPDATE ON oauth_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER shares_updated_at
  BEFORE UPDATE ON shares
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER share_reactions_updated_at
  BEFORE UPDATE ON share_reactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── App settings ─────────────────────────────────────────────
-- Server-wide (not per-user) key/value settings, e.g. sync.enabled / sync.intervalMinutes.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER app_settings_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Hosting points ───────────────────────────────────────────
-- Other Streamio server instances this server exchanges library data with.
-- shared_secret must be configured identically on both sides (this server's
-- entry for the peer, and the peer's entry for this server) — it doubles as
-- the bearer credential the peer uses to call this server's /api/sync/export.
CREATE TABLE IF NOT EXISTS hosting_points (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL,
  url               TEXT        NOT NULL UNIQUE,
  shared_secret     TEXT        NOT NULL UNIQUE,
  enabled           BOOLEAN     NOT NULL DEFAULT TRUE,
  last_synced_at    TIMESTAMPTZ,
  last_sync_status  TEXT,
  last_sync_error   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER hosting_points_updated_at
  BEFORE UPDATE ON hosting_points
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Rooms (watch parties) ────────────────────────────────────
-- A room ties a group of users to one piece of content and a shared
-- playback position, kept current by services/room.service.ts and
-- broadcast over WebSocket by services/room-socket.service.ts. `code` is
-- the short human-shareable join code. Deleting the row (owner closes it,
-- or the last member leaves) cascades room_members.
CREATE TABLE IF NOT EXISTS rooms (
  id                UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  code              TEXT             NOT NULL UNIQUE,
  owner_id          UUID             NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider          TEXT             NOT NULL,
  show_id           TEXT             NOT NULL,
  episode_id        TEXT,
  episode_label     TEXT,
  content_type      TEXT             NOT NULL DEFAULT 'movie' CHECK (content_type IN ('movie', 'episode')),
  playing           BOOLEAN          NOT NULL DEFAULT FALSE,
  position_seconds  DOUBLE PRECISION NOT NULL DEFAULT 0,
  state_updated_at  TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  created_at        TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rooms_code_idx  ON rooms (code);
CREATE INDEX IF NOT EXISTS rooms_owner_idx ON rooms (owner_id);

CREATE TRIGGER rooms_updated_at
  BEFORE UPDATE ON rooms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Room members ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS room_members (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id    UUID        NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS room_members_room_idx ON room_members (room_id);
CREATE INDEX IF NOT EXISTS room_members_user_idx ON room_members (user_id);