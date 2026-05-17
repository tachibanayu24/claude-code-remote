-- セッション closeリモート要求のための marker 列。 phone から POST /v1/sessions/:sid/close
-- が来たらここに `nowSec()` を立てる。 channel.mjs は /v1/wait の events で
-- type=close を受け取って process.kill(ppid, 'SIGTERM') する。
--
-- NULL = close 未要求。 SET された後 /v1/wait が type=close を 1 回 emit すると
-- 同 transaction 内で marker を NULL に戻す (single-fire)。 これをやらないと
-- `claude --continue` で同じ session_id を再利用したとき、 新 channel.mjs が
-- 過去の marker を読んで即 SIGTERM → 即死するため。 再 close したい場合は
-- phone が再 POST すれば marker は立て直る (idempotent)。
--
-- Row 自体は SESSION_STALE_AFTER_SEC 経由の stale 削除に任せて残す。

ALTER TABLE sessions ADD COLUMN close_requested_at INTEGER;
