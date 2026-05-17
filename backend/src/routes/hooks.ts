import { Hono } from 'hono'
import { dismissPendingApprovals } from '../approvals'
import { dismissPendingQuestionsBySession } from '../questions'
import { nowSec, readJson } from '../db'
import { basename, formatElapsed, previewLine } from '../format'
import { notifyInfo } from '../push'
import { readSettings } from '../settings'
import type { Bindings, HookPosttoolRequest, HookStopRequest } from '../types'

const app = new Hono<{ Bindings: Bindings }>()

app.post('/stop', async (c) => {
  const body = await readJson<HookStopRequest>(c.req.raw)
  if (!body) return c.json({ error: 'invalid body' }, 400)
  const cwd = body.cwd ?? ''
  const sessionId = body.session_id ?? ''
  const project = basename(cwd) || 'unknown'
  const elapsedMs = body.elapsed_ms ?? null
  const blocks = body.blocks ?? []
  const blocksJson = blocks.length > 0 ? JSON.stringify(blocks) : null
  // Plain text rolled out of the blocks — only used for the FCM notification
  // body (preview line). The turn payload itself is stored as ordered blocks.
  const fullMessage = blocks
    .filter((b): b is { kind: 'text'; text: string } => b.kind === 'text')
    .map((b) => b.text)
    .join('\n\n')
  const aiTitle = body.ai_title ?? ''
  const userPrompt = body.user_prompt ?? ''
  const toolSummary = body.tool_summary && body.tool_summary.length > 0
    ? JSON.stringify(body.tool_summary)
    : null
  const dryRun = body.dry_run === true

  // Dismiss only this session's pending approvals + questions — leave
  // concurrent CCs in the same cwd untouched. Skips when sessionId is empty
  // (very old hook payload) so we don't accidentally expire every row.
  const [dismissed, dismissedQuestions] = dryRun
    ? [0, 0]
    : await Promise.all([
        dismissPendingApprovals(c.env.DB, c.env, sessionId),
        dismissPendingQuestionsBySession(c.env.DB, c.env, sessionId),
      ])
  void dismissedQuestions  // 数値は response に乗せないが no-op 防止のため await

  // Persist the turn snapshot regardless of FCM threshold — the detail screen
  // wants every turn, not just the long ones.
  const turnId = crypto.randomUUID()
  if (!dryRun && cwd && sessionId) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO turns (id, cwd, session_id, user_prompt, blocks, tool_summary, elapsed_ms, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        turnId,
        cwd,
        sessionId,
        userPrompt || null,
        blocksJson,
        toolSummary,
        elapsedMs,
        nowSec(),
      ),
      // The Stop event ends an in-flight turn — clear both the live prompt
      // marker and the partial blocks so the detail screen stops showing
      // them as "current". Scoped to session_id so concurrent CC in the
      // same cwd aren't nulled out.
      c.env.DB.prepare(
        'UPDATE sessions SET current_prompt = NULL, current_blocks = NULL WHERE session_id = ?'
      ).bind(sessionId),
    ])
  }

  // Threshold gate: skip the FCM push for short turns. Sourced from D1
  // settings so the phone can tune it. readSettings falls back to env then
  // built-in default when the table is missing.
  const { stop_threshold_ms: threshold } = await readSettings(c.env)
  if (elapsedMs !== null && elapsedMs < threshold) {
    return c.json({ ok: true, dismissed, notified: 0, skipped: 'below_threshold', dry_run: dryRun, turn_id: dryRun ? null : turnId })
  }

  const titleHead = aiTitle || project
  const title = `✅ ${titleHead}`
  const summary = [formatElapsed(elapsedMs), previewLine(fullMessage)].filter(Boolean).join(' · ')

  if (dryRun) {
    return c.json({ ok: true, dry_run: true, would: { title, body: summary } })
  }

  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO notifications (id, session_id, cwd, project_name, kind, title, body, created_at)
     VALUES (?, ?, ?, ?, 'completed', ?, ?, ?)`
  )
    .bind(id, sessionId, cwd, project, title, summary || null, nowSec())
    .run()

  const notified = await notifyInfo(c.env, c.env.DB, {
    kind: 'completed',
    cwd,
    project,
    session_label: aiTitle,
    title,
    body: summary,
    session_id: sessionId,
    elapsed_ms: elapsedMs != null ? String(elapsedMs) : '',
  })
  return c.json({ ok: true, id, dismissed, notified, turn_id: turnId })
})

app.post('/posttool', async (c) => {
  const body = await readJson<HookPosttoolRequest>(c.req.raw)
  // Reject empty session_id: dismissPendingApprovals('') would expire pending
  // rows for *every* session, which collapses the multi-session use case.
  if (!body?.session_id) return c.json({ error: 'session_id required' }, 400)
  const [dismissed, dismissedQuestions] = await Promise.all([
    dismissPendingApprovals(c.env.DB, c.env, body.session_id),
    dismissPendingQuestionsBySession(c.env.DB, c.env, body.session_id),
  ])
  return c.json({ ok: true, dismissed, dismissed_questions: dismissedQuestions })
})

export default app
