-- D1 は本体 + secondary index それぞれへの書き込みを rows_written 1 行と
-- 数えるため、 sessions への heartbeat UPSERT 1 回が 3 行課金されていた
-- (Free plan: account 全体で書き込み 10 万行/日。 実測でこの UPSERT が
-- 直近 7 日の書き込み 56 万行のうち 56.4 万行 = ほぼ全部)。
--
-- sessions は「生きているセッション + stale cleanup までの 7 日分の残骸」
-- しか持たず高々数十 row。 idx_sessions_heartbeat が支えていた ORDER BY /
-- range-scan cleanup は full scan で十分速く、 idx_sessions_cwd に至っては
-- 0010 の per-session 化以降 cwd で引く query 自体が残っていない
-- (prompts.ts などは全て PK の session_id 引き)。 index を落として
-- 書き込みコストを 1/3 にする。
DROP INDEX IF EXISTS idx_sessions_heartbeat;
DROP INDEX IF EXISTS idx_sessions_cwd;
