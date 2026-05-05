import { Hono } from 'hono'
import { nowSec, readJson } from '../db'
import { notifyApprovalRequest, notifyApprovalResolved } from '../push'
import type {
  ApprovalCreateRequest,
  ApprovalRespondRequest,
  ApprovalRow,
  Bindings,
} from '../types'

const app = new Hono<{ Bindings: Bindings }>()

app.post('/', async (c) => {
  const body = await readJson<ApprovalCreateRequest>(c.req.raw)
  if (!body?.project_name || !body.tool_name) {
    return c.json({ error: 'project_name and tool_name required' }, 400)
  }
  const id = crypto.randomUUID()
  // tool_input is preserved in D1 for the future history view (description +
  // input_preview, the same fields rendered in the notification body).
  const toolInput = JSON.stringify({
    description: body.description ?? '',
    input_preview: body.input_preview ?? '',
  })
  await c.env.DB.prepare(
    `INSERT INTO approvals (id, session_id, cwd, project_name, tool_name, tool_input, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(
      id,
      body.session_id ?? '',
      body.cwd ?? '',
      body.project_name,
      body.tool_name,
      toolInput,
      nowSec()
    )
    .run()

  const notified = await notifyApprovalRequest(c.env, c.env.DB, {
    request_id: id,
    cwd: body.cwd ?? '',
    project: body.project_name,
    session_label: body.session_label ?? '',
    tool_name: body.tool_name,
    description: body.description ?? '',
    input_preview: body.input_preview ?? '',
  })
  return c.json({ id, status: 'pending', notified })
})

app.get('/:id', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT id, status, resolved_at, resolved_by, add_to_allowlist
     FROM approvals WHERE id = ?`
  )
    .bind(c.req.param('id'))
    .first<ApprovalRow>()
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.json({
    ...row,
    // D1 may decode INTEGER as either number or boolean depending on driver
    // version. Normalize so downstream callers see a stable boolean.
    add_to_allowlist: Number(row.add_to_allowlist) === 1,
  })
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
