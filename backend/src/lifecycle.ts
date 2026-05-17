// 共通の lifecycle helper。 approval / question で同形の「pending → expired」
// 遷移 SQL を集約する。 個別の通知 push は呼び元 (approvals.ts / questions.ts)
// が行う — push の payload shape はドメインごとに違うので generic 化しない。
//
// 「PostToolUse hook の session-wide dismiss」 など全ドメイン横断のクリーン
// アップは `dismissAllPendingForSession` を 1 箇所で呼べば足りる構造。 ドメイン
// が増えても dismissAllPendingForSession の中だけ拡張すれば済む。

import { dismissPendingApprovals } from './approvals'
import { nowSec } from './db'
import { dismissPendingQuestionsBySession } from './questions'
import type { Bindings } from './types'

export type ExpiredId = { id: string }

/**
 * `UPDATE ... RETURNING id` で「pending → expired」 にし、 expire 化された
 * 行の id 一覧を返す。 SQL injection を避けるため `table` / `where` は
 * literal union で制約。
 */
export async function expirePendingBy(
  db: D1Database,
  table: 'approvals' | 'questions',
  where: 'session_id' | 'id',
  value: string,
): Promise<string[]> {
  if (!value) return []
  const res = await db.prepare(
    `UPDATE ${table} SET status = 'expired', resolved_at = ?
     WHERE status = 'pending' AND ${where} = ?
     RETURNING id`,
  ).bind(nowSec(), value).all<ExpiredId>()
  return (res.results ?? []).map((r) => r.id)
}

/**
 * PostToolUse / Stop hook 経路の全ドメイン横断クリーンアップ。 session_id
 * 単位で「未解決の interaction」 を全部 expire 化する。 新ドメインを足したら
 * この関数に追加すれば全 hook が自動で拾う。
 */
export async function dismissAllPendingForSession(
  db: D1Database,
  env: Bindings,
  sessionId: string,
): Promise<{ approvals: number; questions: number }> {
  if (!sessionId) return { approvals: 0, questions: 0 }
  const [approvals, questions] = await Promise.all([
    dismissPendingApprovals(db, env, sessionId),
    dismissPendingQuestionsBySession(db, env, sessionId),
  ])
  return { approvals, questions }
}
