-- Single-row table for user-tunable notification policy. id is fixed at 1 so
-- callers can blind-update without race-y upserts.
CREATE TABLE settings (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  ask_delay_ms      INTEGER NOT NULL DEFAULT 10000,
  stop_threshold_ms INTEGER NOT NULL DEFAULT 180000,
  updated_at        INTEGER NOT NULL
);

INSERT INTO settings (id, ask_delay_ms, stop_threshold_ms, updated_at)
VALUES (1, 10000, 180000, strftime('%s','now'));

-- Persisted so the delayed /notify endpoint can construct the same FCM
-- payload as the immediate path. Nullable for old rows.
ALTER TABLE approvals ADD COLUMN session_label TEXT;
