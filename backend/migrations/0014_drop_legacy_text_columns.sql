-- 0013 で blocks 列に移行が完了したので、旧 (assistant_text, tool_calls,
-- current_assistant_text) は読み書きされなくなった。schema を綺麗に保つため
-- DROP する。
-- 旧 turn 行は assistant_text に残っていた値を失う代わりに blocks が NULL の
-- まま残る (アプリ側は assistant 部が空表示 / user_prompt と footer は健在)。

ALTER TABLE turns DROP COLUMN assistant_text;
ALTER TABLE turns DROP COLUMN tool_calls;
ALTER TABLE sessions DROP COLUMN current_assistant_text;
