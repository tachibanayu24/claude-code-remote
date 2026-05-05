-- Per-turn snapshot, populated by the Stop hook for every assistant turn
-- (regardless of FCM threshold). Serves the session detail screen which
-- shows the last N turns of conversation.
CREATE TABLE turns (
  id             TEXT PRIMARY KEY,
  cwd            TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  user_prompt    TEXT,
  assistant_text TEXT,
  tool_summary   TEXT,           -- JSON array: [{name, count}]
  elapsed_ms     INTEGER,
  ended_at       INTEGER NOT NULL
);
CREATE INDEX idx_turns_cwd_ended ON turns(cwd, ended_at DESC);

-- Holds the in-flight user prompt (the latest user message that has not yet
-- been answered with an assistant final reply). Set by channel.mjs heartbeat.
ALTER TABLE sessions ADD COLUMN current_prompt TEXT;
