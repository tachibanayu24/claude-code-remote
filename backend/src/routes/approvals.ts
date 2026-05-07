import { Hono } from 'hono'
import { nowSec, readJson } from '../db'
import { notifyApprovalRequest, notifyApprovalResolved } from '../push'
import { readSettings } from '../settings'
import type {
  ApprovalCreateRequest,
  ApprovalRespondRequest,
  Bindings,
} from '../types'

const app = new Hono<{ Bindings: Bindings }>()

app.post('/', async (c) => {
  const body = await readJson<ApprovalCreateRequest>(c.req.raw)
  if (!body?.project_name || !body.tool_name || !body.session_id) {
    return c.json({ error: 'session_id, project_name, tool_name required' }, 400)
  }
  const id = crypto.randomUUID()
  // tool_input is preserved in D1 for the future history view (description +
  // input_preview, the same fields rendered in the notification body).
  const toolInput = JSON.stringify({
    description: body.description ?? '',
    input_preview: body.input_preview ?? '',
  })
  await c.env.DB.prepare(
    `INSERT INTO approvals (id, session_id, cwd, project_name, tool_name, tool_input, session_label, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(
      id,
      body.session_id,
      body.cwd ?? '',
      body.project_name,
      body.tool_name,
      toolInput,
      body.session_label ?? null,
      nowSec()
    )
    .run()

  // Ask-delay policy: skip the immediate FCM and let channel.mjs trigger
  // /notify after the delay. Local terminal answers within the window will
  // dismiss the row first, so the delayed call no-ops. ask_delay_ms = 0
  // preserves the legacy "push immediately" behavior.
  const settings = await readSettings(c.env)
  if (settings.ask_delay_ms > 0) {
    return c.json({
      id,
      status: 'pending',
      notified: 0,
      notify_after_ms: settings.ask_delay_ms,
    })
  }

  const notified = await notifyApprovalRequest(c.env, c.env.DB, {
    request_id: id,
    session_id: body.session_id,
    project: body.project_name,
    session_label: body.session_label ?? '',
    tool_name: body.tool_name,
    description: body.description ?? '',
    input_preview: body.input_preview ?? '',
  })
  return c.json({ id, status: 'pending', notified, notify_after_ms: 0 })
})

interface ApprovalNotifyRow {
  status: string
  session_id: string
  project_name: string
  tool_name: string
  tool_input: string
  session_label: string | null
}

app.post('/:id/notify', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare(
    `SELECT status, session_id, project_name, tool_name, tool_input, session_label
     FROM approvals WHERE id = ?`
  ).bind(id).first<ApprovalNotifyRow>()
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.status !== 'pending') {
    return c.json({ ok: true, skipped: row.status })
  }
  let parsedInput: { description?: string; input_preview?: string } = {}
  try {
    parsedInput = JSON.parse(row.tool_input) ?? {}
  } catch (_) {
    // tool_input from older rows might not be JSON; treat as opaque.
  }
  const notified = await notifyApprovalRequest(c.env, c.env.DB, {
    request_id: id,
    session_id: row.session_id,
    project: row.project_name,
    session_label: row.session_label ?? '',
    tool_name: row.tool_name,
    description: parsedInput.description ?? '',
    input_preview: parsedInput.input_preview ?? '',
  })
  return c.json({ ok: true, notified })
})

app.post('/:id/respond', async (c) => {
  const id = c.req.param('id')
  const body = await readJson<ApprovalRespondRequest>(c.req.raw)
  if (!body || (body.decision !== 'allow' && body.decision !== 'deny')) {
    return c.json({ error: 'decision must be allow or deny' }, 400)
  }
  const allowlistFlag = body.decision === 'allow' && body.add_to_allowlist ? 1 : 0
  const result = await c.env.DB.prepare(
    `UPDATE approvals
     SET status = ?, resolved_at = ?, resolved_by = ?, add_to_allowlist = ?
     WHERE id = ? AND status = 'pending'`
  )
    .bind(body.decision, nowSec(), body.device_id ?? null, allowlistFlag, id)
    .run()

  if ((result.meta?.changes ?? 0) === 0) {
    const existing = await c.env.DB.prepare('SELECT status FROM approvals WHERE id = ?')
      .bind(id)
      .first<{ status: string }>()
    if (!existing) return c.json({ error: 'not found' }, 404)
    return c.json({ error: 'already resolved', status: existing.status }, 409)
  }

  await notifyApprovalResolved(c.env, c.env.DB, {
    request_id: id,
    decision: body.decision,
    resolved_by: body.device_id ?? '',
  })
  return c.json({ ok: true, status: body.decision, add_to_allowlist: allowlistFlag === 1 })
})

export default app
