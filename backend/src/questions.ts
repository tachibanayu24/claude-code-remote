// Question-domain helpers shared by the routes layer. Mirrors approvals.ts.
//
// AskUserQuestion 用の集約モジュール。承認 (approvals.ts) と対称な構造で:
//   - `questions.questions` JSON blob の parse / encode
//   - FCM push の payload shape (`question_request`)
//   - bulk + single dismiss SQL with resolve push
// を提供する。
//
// 承認との違いは: 承認の `tool_input` は (description, input_preview,
// supports_always) という 3 個の薄い blob だったが、こちらは AskQuestion[] を
// そのまま JSON で詰める。Android がこれを decode して UI を組み立てる。

import { nowSec } from './db'
import { notifyQuestionResolved } from './push'
import type { AskQuestion, Bindings } from './types'

export interface QuestionsBlob {
  questions: AskQuestion[]
}

export function parseQuestionsBlob(raw: string | null | undefined): QuestionsBlob {
  let parsed: Partial<QuestionsBlob> = {}
  try { if (raw) parsed = JSON.parse(raw) ?? {} } catch (_) {}
  return { questions: Array.isArray(parsed.questions) ? parsed.questions : [] }
}

export function encodeQuestionsBlob(b: QuestionsBlob): string {
  return JSON.stringify(b)
}

/**
 * FCM data payload for a `question_request` push. Called from both the
 * immediate path (ask_delay = 0) and the deferred /notify endpoint.
 * `questions` は JSON 文字列としてそのまま data に詰める (FCM data は string
 * map なのでネスト構造は serialize して渡す)。Android が parse して展開。
 */
export function questionPushData(args: {
  id: string
  session_id: string
  project_name: string
  session_label?: string | null
  questions: AskQuestion[]
}): Record<string, string> {
  return {
    request_id: args.id,
    session_id: args.session_id,
    project: args.project_name,
    session_label: args.session_label ?? '',
    questions: JSON.stringify(args.questions),
  }
}

async function expirePendingQuestions(
  db: D1Database,
  env: Bindings,
  where: 'session_id' | 'id',
  value: string,
): Promise<string[]> {
  if (!value) return []
  const res = await db.prepare(
    `UPDATE questions SET status = 'expired', resolved_at = ?
     WHERE status = 'pending' AND ${where} = ?
     RETURNING id`,
  ).bind(nowSec(), value).all<{ id: string }>()
  const ids = (res.results ?? []).map((r) => r.id)
  if (ids.length === 0) return ids
  await Promise.all(ids.map((id) =>
    notifyQuestionResolved(env, db, {
      request_id: id,
      decision: 'expired',
      resolved_by: 'cli',
    })
  ))
  return ids
}

/** PostToolUse hook path equivalent: expire every pending question for this session. */
export async function dismissPendingQuestionsBySession(
  db: D1Database,
  env: Bindings,
  sessionId: string,
): Promise<number> {
  return (await expirePendingQuestions(db, env, 'session_id', sessionId)).length
}

/** channel.mjs path: JSONL shows CC has answered this specific question locally. */
export async function dismissQuestionById(
  db: D1Database,
  env: Bindings,
  id: string,
): Promise<boolean> {
  return (await expirePendingQuestions(db, env, 'id', id)).length > 0
}

/**
 * channel.mjs が JSONL 上で AskUserQuestion の tool_result 増加を検出した時、
 * 「session の最古 pending を N 個 expire してくれ」を投げてくる。 backend が
 * atomic に oldest first で確定する (= 同時に複数 hook が走ってる場合の race
 * fix)。 expire 数 (実際に消えた数) を返す。
 */
export async function dismissOldestPendingQuestions(
  db: D1Database,
  env: Bindings,
  sessionId: string,
  count: number,
): Promise<number> {
  if (!sessionId || count <= 0) return 0
  // 最も古い pending N 件を 1 SQL で取得し、 status を expired にする。
  const oldestRes = await db.prepare(
    `SELECT id FROM questions WHERE session_id = ? AND status = 'pending'
     ORDER BY created_at ASC LIMIT ?`
  ).bind(sessionId, count).all<{ id: string }>()
  const ids = (oldestRes.results ?? []).map((r) => r.id)
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(',')
  await db.prepare(
    `UPDATE questions SET status = 'expired', resolved_at = ?
     WHERE status = 'pending' AND id IN (${placeholders})`
  ).bind(nowSec(), ...ids).run()
  await Promise.all(ids.map((id) =>
    notifyQuestionResolved(env, db, {
      request_id: id,
      decision: 'expired',
      resolved_by: 'cli',
    })
  ))
  return ids.length
}
