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

/**
 * Idempotent expire by id. 残してあるのは将来 channel.mjs が tool_use_id 個別
 * binding で個別 dismiss する余地のため (現状 AskUserQuestion の dismiss は
 * PostToolUse hook の session-wide path に一任しているので呼ばれない)。
 */
export async function dismissQuestionById(
  db: D1Database,
  env: Bindings,
  id: string,
): Promise<boolean> {
  return (await expirePendingQuestions(db, env, 'id', id)).length > 0
}
