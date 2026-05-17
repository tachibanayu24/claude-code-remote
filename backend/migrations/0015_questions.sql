-- AskUserQuestion 用テーブル。承認 (approvals) とは構造が大きく違う
-- (multi-question + multi-option) ので分離した。lifecycle と FCM push の流儀は
-- 承認と対称: pending → resolved (phone 応答) / expired (CLI 早勝ちで JSONL
-- 検出 → channel.mjs が /dismiss)。
--
-- `questions` 列は AskUserQuestion ツールの tool_input.questions[] をそのまま
-- JSON encode して保存。Android 側はこれを decode して UI に展開する。
-- `answers` 列は phone が submit した answers map (キー = question 文字列、
-- 値 = label or label[]) を JSON encode したもの。hook がこれを取り出して
-- updatedInput.answers として CC に返す。

CREATE TABLE questions (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  cwd           TEXT NOT NULL DEFAULT '',
  project_name  TEXT NOT NULL,
  session_label TEXT,
  questions     TEXT NOT NULL,
  status        TEXT NOT NULL,
  answers       TEXT,
  resolved_by   TEXT,
  created_at    INTEGER NOT NULL,
  notified_at   INTEGER,
  resolved_at   INTEGER
);

CREATE INDEX idx_questions_session_status ON questions(session_id, status);
CREATE INDEX idx_questions_cwd ON questions(cwd);
