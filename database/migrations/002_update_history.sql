-- ============================================================
-- 002_update_history.sql
--
-- Audit trail for the self-update flow: one row per update the host-side
-- updater/ process carried out (or failed to). Written when the updater
-- acks, before it restarts the stack, so a failed rebuild still leaves a
-- record of what was attempted.
-- ============================================================

CREATE TABLE IF NOT EXISTS update_history (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_version  TEXT        NOT NULL,          -- version running before the update
  to_version    TEXT        NOT NULL,          -- target release tag
  trigger       TEXT        NOT NULL,          -- 'manual' | 'auto'
  requested_by  TEXT,                          -- admin email for 'manual', NULL for 'auto'
  status        TEXT        NOT NULL,          -- 'started' | 'ok' | 'error'
  error         TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS update_history_started_idx ON update_history (started_at DESC);
