CREATE TABLE devices (
  id            TEXT PRIMARY KEY,
  fcm_token     TEXT NOT NULL,
  name          TEXT,
  registered_at INTEGER NOT NULL
);

CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  project_name  TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  tool_input    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK(status IN ('pending','allow','deny','ask','expired')),
  reason        TEXT,
  created_at    INTEGER NOT NULL,
  resolved_at   INTEGER,
  resolved_by   TEXT
);
CREATE INDEX idx_approvals_status ON approvals(status, created_at);

CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  cwd           TEXT NOT NULL,
  project_name  TEXT NOT NULL,
  kind          TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT,
  created_at    INTEGER NOT NULL
);
