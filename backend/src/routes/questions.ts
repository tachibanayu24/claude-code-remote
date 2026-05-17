// /v1/questions/* — AskUserQuestion 用エンドポイント群。
//
// 設計対称性: routes/approvals.ts と同じ流儀。違いは:
//   - hook が自身で long-poll する (/wait) — channel.mjs ではなく per-call の
//     hook script が answer を取りに来る
//   - 回答は behavior (allow|deny) ではなく answers map
//   - allowlist 概念なし

import { Hono } from 'hono'
import { nowSec, readJson } from '../db'
import { notifyQuestionRequest, notifyQuestionResolved } from '../push'
import {
  dismissQuestionById,
  encodeQuestionsBlob,
  parseQuestionsBlob,
  questionPushData,
} from '../questions'
import { readSettings } from '../settings'
import type {
  Bindings,
  QuestionCreateRequest,
  QuestionRespondRequest,
  QuestionWaitEvent,
} from '../types'

const app = new Hono<{ Bindings: Bindings }>()

// /wait の long-poll カデンス。 backend は Workers Free の wall-time 30s 制限が
// あるので 25s で頭打ち。 hook 側はこれを複数回叩いて hook timeout (120s 想定)
// 直前まで粘る。
const DEFAULT_WAIT_MS = 10_000
const MIN_WAIT_MS = 1_000
const MAX_WAIT_MS = 25_000
const D1_POLL_MS = 2_000

app.post('/', async (c) => {
  const body = await readJson<QuestionCreateRequest>(c.req.raw)
  if (
    !body?.session_id ||
    !body.project_name ||
    !Array.isArray(body.questions) ||
    body.questions.length === 0
  ) {
    return c.json({ error: 'session_id, project_name, questions[] required' }, 400)
  }
  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO questions (id, session_id, cwd, project_name, session_label, questions, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(
      id,
      body.session_id,
      body.cwd ?? '',
      body.project_name,
      body.session_label ?? null,
      encodeQuestionsBlob({ questions: body.questions }),
      nowSec()
    )
    .run()

  // 質問は承認とは別の delay 値 (question_ask_delay_ms) を使う。 承認は CLI
  // 即応答が前提で短め (default 10s)、 質問は CLI でじっくり選択肢を読む
  // 前提で長め (default 30s)。 「うるさい通知」 を防ぐ仕組み自体は同じで、
  // hook 側がこの notify_after_ms 経過後に /notify を遅延起動する。
  const settings = await readSettings(c.env)
  if (settings.question_ask_delay_ms > 0) {
    return c.json({
      id,
      status: 'pending',
      notified: 0,
      notify_after_ms: settings.question_ask_delay_ms,
    })
  }
  const notified = await notifyQuestionRequest(c.env, c.env.DB, questionPushData({
    id,
    session_id: body.session_id,
    project_name: body.project_name,
    session_label: body.session_label,
    questions: body.questions,
  }))
  await c.env.DB.prepare('UPDATE questions SET notified_at = ? WHERE id = ?')
    .bind(nowSec(), id).run()
  return c.json({ id, status: 'pending', notified, notify_after_ms: 0 })
})

interface QuestionNotifyRow {
  status: string
  session_id: string
  project_name: string
  session_label: string | null
  questions: string
}

app.post('/:id/notify', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare(
    `SELECT status, session_id, project_name, session_label, questions
     FROM questions WHERE id = ?`
  ).bind(id).first<QuestionNotifyRow>()
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.status !== 'pending') return c.json({ ok: true, skipped: row.status })
  const blob = parseQuestionsBlob(row.questions)
  const notified = await notifyQuestionRequest(c.env, c.env.DB, questionPushData({
    id,
    session_id: row.session_id,
    project_name: row.project_name,
    session_label: row.session_label,
    questions: blob.questions,
  }))
  await c.env.DB.prepare('UPDATE questions SET notified_at = ? WHERE id = ?')
    .bind(nowSec(), id).run()
  return c.json({ ok: true, notified })
})

app.post('/:id/dismiss', async (c) => {
  // channel.mjs path: JSONL で AskUserQuestion の tool_result を検出した
  // ときに「もう phone には不要」を伝えるための idempotent expire。
  const id = c.req.param('id')
  const dismissed = await dismissQuestionById(c.env.DB, c.env, id)
  return c.json({ ok: true, dismissed })
})

app.post('/:id/respond', async (c) => {
  const id = c.req.param('id')
  const body = await readJson<QuestionRespondRequest>(c.req.raw)
  if (!body || !body.answers || typeof body.answers !== 'object') {
    return c.json({ error: 'answers required' }, 400)
  }
  const result = await c.env.DB.prepare(
    `UPDATE questions
     SET status = 'resolved', resolved_at = ?, resolved_by = ?, answers = ?
     WHERE id = ? AND status = 'pending'`
  )
    .bind(nowSec(), body.device_id ?? null, JSON.stringify(body.answers), id)
    .run()

  if ((result.meta?.changes ?? 0) === 0) {
    const existing = await c.env.DB.prepare('SELECT status FROM questions WHERE id = ?')
      .bind(id).first<{ status: string }>()
    if (!existing) return c.json({ error: 'not found' }, 404)
    return c.json({ error: 'already resolved', status: existing.status }, 409)
  }

  // hook 側の /wait long-poll は status の遷移をポーリングで拾うので、
  // resolve push は phone 側の他の端末の UI を消す目的のみ (hook には影響なし)。
  await notifyQuestionResolved(c.env, c.env.DB, {
    request_id: id,
    decision: 'resolved',
    resolved_by: body.device_id ?? '',
  })
  return c.json({ ok: true, status: 'resolved' })
})

app.post('/:id/wait', async (c) => {
  // hook 側 long-poll。 status が pending を抜けるまでブロック。
  // 戻り値:
  //   { event: { type:'answers', answers } } — phone が応答
  //   { event: { type:'dismissed' } }         — CLI 早勝ちで expired 化
  //   { event: null }                         — timeout (hook は再 poll)
  const id = c.req.param('id')
  const maxMsRaw = Number(c.req.query('max_ms'))
  const maxMs = Number.isFinite(maxMsRaw)
    ? Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, maxMsRaw))
    : DEFAULT_WAIT_MS

  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const row = await c.env.DB.prepare(
      'SELECT status, answers FROM questions WHERE id = ?'
    ).bind(id).first<{ status: string; answers: string | null }>()
    if (!row) return c.json({ error: 'not found' }, 404)
    if (row.status === 'resolved') {
      let parsed: Record<string, string | string[]> = {}
      try { parsed = row.answers ? JSON.parse(row.answers) : {} } catch (_) {}
      const ev: QuestionWaitEvent = { type: 'answers', answers: parsed }
      return c.json({ event: ev })
    }
    if (row.status === 'expired') {
      const ev: QuestionWaitEvent = { type: 'dismissed' }
      return c.json({ event: ev })
    }
    const remaining = maxMs - (Date.now() - start)
    if (remaining <= 0) break
    await new Promise((r) => setTimeout(r, Math.min(D1_POLL_MS, remaining)))
  }
  return c.json({ event: null })
})

export default app
