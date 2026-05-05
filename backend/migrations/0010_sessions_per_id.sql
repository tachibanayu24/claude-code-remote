-- Switch to per-session modelling: previously the `sessions` table was keyed by
-- cwd, which collapsed concurrent CC instances in the same project into one
-- entity. Now session_id is the PK so each CC subprocess gets its own row,
-- own pending approvals view, own queued prompts, own current_prompt.
--
-- Existing sessions metadata (transient, repopulated by the next heartbeat)
-- and queued prompts (orphaned without a target session) are wiped. Turns and
-- approvals already store session_id so they survive — they just become
-- queryable per-session instead of per-cwd.

DROP TABLE IF EXISTS sessions;

CREATE TABLE sessions (
  session_id             TEXT PRIMARY KEY,
  cwd                    TEXT NOT NULL,
  project_name           TEXT NOT NULL,
  ai_title               TEXT,
  jsonl_mtime            INTEGER,
  last_heartbeat         INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  current_prompt         TEXT,
  current_assistant_text TEXT
);
CREATE INDEX idx_sessions_heartbeat ON sessions(last_heartbeat);
CREATE INDEX idx_sessions_cwd ON sessions(cwd);

-- Drop queued prompts that targeted the cwd-based table; channel.mjs of any
-- CC in the cwd would have claimed them. New schema requires explicit
-- session_id targeting, so old rows are meaningless.
DELETE FROM prompts;
ALTER TABLE prompts ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS idx_prompts_cwd_status;
CREATE INDEX idx_prompts_session_status ON prompts(session_id, status, created_at);

-- Per-session turn lookup for the detail screen.
CREATE INDEX IF NOT EXISTS idx_turns_session_ended ON turns(session_id, ended_at DESC);

-- Per-session pending approval lookup (replaces cwd-based grouping).
DROP INDEX IF EXISTS idx_approvals_cwd_status;
CREATE INDEX IF NOT EXISTS idx_approvals_session_status ON approvals(session_id, status);
