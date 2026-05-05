-- Cleanup-on-read deletes turns by `ended_at` alone. The existing composite
-- index `(cwd, ended_at DESC)` requires `cwd` as the lead column, so the
-- DELETE falls back to a full scan. A single-column index lets the cleanup
-- become a cheap range scan.
CREATE INDEX IF NOT EXISTS idx_turns_ended ON turns(ended_at);
