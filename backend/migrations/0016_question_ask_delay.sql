-- AskUserQuestion は承認と違って「user が CLI でじっくり考える」 時間が長い
-- (構造化選択肢を読む + 選ぶ + Other を考える 等)。 承認用の ask_delay_ms を
-- そのまま流用すると、 5 秒経過後に phone 通知が出てしまい「うるさい」。
-- 別フィールドにして default 30s で持つ。 mobile Settings 画面から個別に
-- 変更可能。

ALTER TABLE settings ADD COLUMN question_ask_delay_ms INTEGER NOT NULL DEFAULT 30000;
