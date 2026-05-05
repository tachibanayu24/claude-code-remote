-- User-typed prompts queued from the Android app, drained by channel.mjs
-- which emits them as `notifications/claude/channel` events into the
-- running CC session so Claude treats them as the next user turn.
CREATE TABLE prompts (
  id           TEXT PRIMARY KEY,
  cwd          TEXT NOT NULL,
  text         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK(status IN ('queued','delivered')),
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX idx_prompts_cwd_status ON prompts(cwd, status, created_at);
