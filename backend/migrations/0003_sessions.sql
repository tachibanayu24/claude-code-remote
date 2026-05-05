-- Tracks live + recently-seen Claude Code sessions, fed by channel.mjs's
-- heartbeat. cwd is the natural primary key (one CC instance per cwd at a
-- time in practice). State is derived at read time from last_heartbeat,
-- jsonl_mtime, and pending approvals — no scheduled job needed.
CREATE TABLE sessions (
  cwd            TEXT PRIMARY KEY,
  session_id     TEXT,
  project_name   TEXT NOT NULL,
  ai_title       TEXT,
  jsonl_mtime    INTEGER,        -- ms epoch of last transcript write
  last_heartbeat INTEGER NOT NULL, -- sec epoch of last channel ping
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_sessions_heartbeat ON sessions(last_heartbeat);
