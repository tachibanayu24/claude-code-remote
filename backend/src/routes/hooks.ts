import { Hono } from 'hono'
import { dismissPendingApprovals, nowSec, readJson } from '../db'
import { basename, formatElapsed, previewLine } from '../format'
import { notifyInfo } from '../push'
import type { Bindings, HookPosttoolRequest, HookStopRequest } from '../types'

const app = new Hono<{ Bindings: Bindings }>()

app.post('/stop', async (c) => {
  const body = await readJson<HookStopRequest>(c.req.raw)
  if (!body) return c.json({ error: 'invalid body' }, 400)
  const cwd = body.cwd ?? ''
  const project = basename(cwd) || 'unknown'
  const elapsedMs = body.elapsed_ms ?? null
  const fullMessage = body.full_message ?? ''
  const aiTitle = body.ai_title ?? ''
  const userPrompt = body.user_prompt ?? ''
  const toolSummary = body.tool_summary && body.tool_summary.length > 0
    ? JSON.stringify(body.tool_summary)
    : null
  const dryRun = body.dry_run === true

  const dismissed = dryRun ? 0 : await dismissPendingApprovals(c.env.DB, c.env, cwd)

  // Persist the turn snapshot regardless of FCM threshold — the detail screen
  // wants every turn, not just the long ones.
  const turnId = crypto.randomUUID()
  if (!dryRun && cwd) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO turns (id, cwd, session_id, user_prompt, assistant_text, tool_summary, elapsed_ms, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        turnId,
        cwd,
        body.session_id ?? '',
        userPrompt || null,
        fullMessage || null,
        toolSummary,
        elapsedMs,
        nowSec(),
      ),
      // The Stop event ends an in-flight turn — clear both the live prompt
      // marker and the partial assistant text so the detail screen stops
      // showing them as "current".
      c.env.DB.prepare(
        'UPDATE sessions SET current_prompt = NULL, current_assistant_text = NULL WHERE cwd = ?'
      ).bind(cwd),
    ])
  }

  // Threshold gate: skip the FCM push for short turns. Backend-side so the PC
  // hook doesn't need its own env knob.
  const threshold = Number.parseInt(c.env.STOP_THRESHOLD_MS ?? '180000', 10)
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
    .bind(id, body.session_id ?? '', cwd, project, title, summary || null, nowSec())
    .run()

  const notified = await notifyInfo(c.env, c.env.DB, {
    kind: 'completed',
    cwd,
    project,
    session_label: aiTitle,
    title,
    body: summary,
    session_id: body.session_id ?? '',
    elapsed_ms: elapsedMs != null ? String(elapsedMs) : '',
    full_message: fullMessage,
  })
  return c.json({ ok: true, id, dismissed, notified, turn_id: turnId })
})

app.post('/posttool', async (c) => {
  const body = await readJson<HookPosttoolRequest>(c.req.raw)
  // Reject empty cwd: dismissPendingApprovals('') would expire pending rows
  // for *every* session, which collapses the multi-session use case.
  if (!body?.cwd) return c.json({ error: 'cwd required' }, 400)
  const dismissed = await dismissPendingApprovals(c.env.DB, c.env, body.cwd)
  return c.json({ ok: true, dismissed })
})

export default app
