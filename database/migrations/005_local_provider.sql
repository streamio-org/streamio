-- ============================================================
-- 005_local_provider.sql
--
-- The "local" provider: admin-uploaded movies/shows that live entirely in
-- this database + this server's own disk, rather than being scraped from a
-- third-party site. `local_media_files` tracks one uploaded video through
-- ffmpeg transcoding to HLS; both a movie (`local_titles.file_id`) and an
-- episode (`local_episodes.file_id`) point into it, since the pipeline is
-- identical either way.
-- ============================================================

CREATE TABLE IF NOT EXISTS local_media_files (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  original_filename  TEXT        NOT NULL,
  -- pending: uploaded, not yet handed to ffmpeg.
  -- transcoding: ffmpeg is running (or queued behind another job).
  -- ready: master.m3u8 exists and is playable.
  -- failed: ffmpeg exited non-zero; `error` carries a short diagnostic.
  status             TEXT        NOT NULL DEFAULT 'pending',
  error              TEXT,
  duration_seconds   INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT local_media_files_status_check
    CHECK (status IN ('pending', 'transcoding', 'ready', 'failed'))
);

CREATE TABLE IF NOT EXISTS local_titles (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  media_type  TEXT        NOT NULL,
  title       TEXT        NOT NULL,
  overview    TEXT,
  poster      TEXT,
  banner      TEXT,
  released    DATE,
  -- Movies only; a tv show's runtime is per-episode and isn't tracked here.
  runtime     INTEGER,
  genres      JSONB       NOT NULL DEFAULT '[]',
  imdb_id     TEXT,
  tmdb_id     INTEGER,
  -- Stored but not yet enforced anywhere (see core/providers/LocalProvider.ts)
  -- — every local title is visible to everyone regardless of 18+ prefs today.
  adult       BOOLEAN     NOT NULL DEFAULT false,
  -- Movies only; NULL for a tv show (its playable content lives on
  -- local_episodes instead).
  file_id     UUID        REFERENCES local_media_files(id) ON DELETE SET NULL,
  created_by  TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT local_titles_media_type_check CHECK (media_type IN ('movie', 'tv'))
);

CREATE TABLE IF NOT EXISTS local_seasons (
  id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title_id  UUID        NOT NULL REFERENCES local_titles(id) ON DELETE CASCADE,
  number    INTEGER     NOT NULL,
  name      TEXT,
  poster    TEXT,
  UNIQUE (title_id, number)
);

CREATE TABLE IF NOT EXISTS local_episodes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id  UUID        NOT NULL REFERENCES local_seasons(id) ON DELETE CASCADE,
  number     INTEGER     NOT NULL,
  title      TEXT,
  overview   TEXT,
  poster     TEXT,
  released   DATE,
  file_id    UUID        REFERENCES local_media_files(id) ON DELETE SET NULL,
  UNIQUE (season_id, number)
);

CREATE INDEX IF NOT EXISTS idx_local_titles_created_at ON local_titles (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_local_seasons_title_id ON local_seasons (title_id);
CREATE INDEX IF NOT EXISTS idx_local_episodes_season_id ON local_episodes (season_id);
