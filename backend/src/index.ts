import { Hono } from 'hono'
import { notifyApprovalRequest, notifyApprovalResolved, notifyInfo } from './push'
import type {
  ApprovalCreateRequest,
  ApprovalRespondRequest,
  ApprovalRow,
  Bindings,
  DeviceRegisterRequest,
  NotificationCreateRequest,
} from './types'

const app = new Hono<{ Bindings: Bindings }>()

app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }))

app.use('/v1/*', async (c, next) => {
  if (c.req.header('Authorization') !== `Bearer ${c.env.SHARED_SECRET}`) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
})

const nowSec = () => Math.floor(Date.now() / 1000)

// ===== Devices =====

app.post('/v1/devices/register', async (c) => {
  const body = await c.req.json<DeviceRegisterRequest>()
  if (!body.device_id || !body.fcm_token) {
    return c.json({ error: 'device_id and fcm_token required' }, 400)
  }
  // Drop stale rows that share this token under a different device id (e.g.
  // after the user reset the app and DataStore generated a new UUID).
  await c.env.DB.prepare('DELETE FROM devices WHERE fcm_token = ? AND id != ?')
    .bind(body.fcm_token, body.device_id)
    .run()
  await c.env.DB.prepare(
    `INSERT INTO devices (id, fcm_token, name, registered_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET fcm_token = excluded.fcm_token,
                                    name = excluded.name,
                                    registered_at = excluded.registered_at`
  )
    .bind(body.device_id, body.fcm_token, body.name ?? null, nowSec())
    .run()
  return c.json({ ok: true })
})

// ===== Approvals =====

app.post('/v1/approvals', async (c) => {
  const body = await c.req.json<ApprovalCreateRequest>()
  const id = crypto.randomUUID()
  const toolInput = JSON.stringify({
    description: body.description ?? '',
    input_preview: body.input_preview ?? '',
    cc_request_id: body.cc_request_id ?? '',
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
    project: body.project_name,
    session_label: body.session_label ?? '',
    tool_name: body.tool_name,
    description: body.description ?? '',
    input_preview: body.input_preview ?? '',
  })
  return c.json({ id, status: 'pending', notified })
})

app.get('/v1/approvals/:id', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT id, status, reason, resolved_at, resolved_by, add_to_allowlist
     FROM approvals WHERE id = ?`
  )
    .bind(c.req.param('id'))
    .first<ApprovalRow>()
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.json({
    ...row,
    add_to_allowlist: row.add_to_allowlist === 1,
  })
})

app.post('/v1/approvals/:id/respond', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<ApprovalRespondRequest>()
  if (body.decision !== 'allow' && body.decision !== 'deny') {
    return c.json({ error: 'decision must be allow or deny' }, 400)
  }
  const allowlistFlag = body.decision === 'allow' && body.add_to_allowlist ? 1 : 0
  const result = await c.env.DB.prepare(
    `UPDATE approvals
     SET status = ?, reason = ?, resolved_at = ?, resolved_by = ?, add_to_allowlist = ?
     WHERE id = ? AND status = 'pending'`
  )
    .bind(body.decision, body.reason ?? null, nowSec(), body.device_id ?? null, allowlistFlag, id)
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

app.post('/v1/approvals/dismiss_pending', async (c) => {
  const body = (await c.req.json<{ cwd?: string }>().catch(() => ({}))) as { cwd?: string }
  const cwd = body.cwd
  const baseWhere = "status = 'pending'"
  const where = cwd ? `${baseWhere} AND cwd = ?` : baseWhere
  const filterArgs = cwd ? [cwd] : []

  const ids = await c.env.DB.prepare(`SELECT id FROM approvals WHERE ${where}`)
    .bind(...filterArgs)
    .all<{ id: string }>()
  const dismissed = (ids.results ?? []).map((r) => r.id)
  if (dismissed.length === 0) return c.json({ ok: true, dismissed: 0 })

  await c.env.DB.prepare(
    `UPDATE approvals SET status = 'expired', resolved_at = ? WHERE ${where}`
  )
    .bind(nowSec(), ...filterArgs)
    .run()

  for (const id of dismissed) {
    await notifyApprovalResolved(c.env, c.env.DB, {
      request_id: id,
      decision: 'expired',
      resolved_by: 'cli',
    })
  }
  return c.json({ ok: true, dismissed: dismissed.length })
})

// ===== Notifications =====

app.post('/v1/notifications', async (c) => {
  const body = await c.req.json<NotificationCreateRequest>()
  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO notifications (id, session_id, cwd, project_name, kind, title, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      body.session_id,
      body.cwd,
      body.project_name,
      body.kind,
      body.title,
      body.body ?? null,
      nowSec()
    )
    .run()

  const notified = await notifyInfo(c.env, c.env.DB, {
    kind: body.kind,
    project: body.project_name,
    session_label: body.session_label ?? '',
    title: body.title,
    body: body.body ?? '',
    session_id: body.session_id,
  })
  return c.json({ ok: true, id, notified })
})

export default app
