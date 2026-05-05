-- In-flight assistant text snapshot, populated by channel.mjs heartbeat.
-- Cleared by /v1/hook/stop alongside current_prompt when the turn commits.
ALTER TABLE sessions ADD COLUMN current_assistant_text TEXT;
