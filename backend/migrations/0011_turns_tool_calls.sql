-- Persist the per-turn sequence of tool_use calls (Edit/Bash/Read/...) so the
-- detail screen can render an inline accordion under the assistant narration.
-- Stored as a JSON-encoded array: [{"name":"Edit","input":{...}}, ...] where
-- `input` is the raw tool_use input from CC's jsonl. Existing turns predate
-- this column and remain NULL — narration only, no tool details surfaced.

ALTER TABLE turns ADD COLUMN tool_calls TEXT;
