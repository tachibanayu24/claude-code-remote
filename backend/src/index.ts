import { Hono } from 'hono'
import { sendFcm } from './fcm'

type Bindings = {
  DB: D1Database
  SHARED_SECRET: string
  FCM_SERVICE_ACCOUNT_JSON: string
  FCM_PROJECT_ID: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }))

app.use('/v1/*', async (c, next) => {
  const expected = `Bearer ${c.env.SHARED_SECRET}`
  if (c.req.header('Authorization') !== expected) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
})

// ===== Devices =====

app.post('/v1/devices/register', async (c) => {
  const body = await c.req.json<{ device_id: string; fcm_token: string; name?: string }>()
  if (!body.device_id || !body.fcm_token) {
    return c.json({ error: 'device_id and fcm_token required' }, 400)
  }
  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.prepare(
    `INSERT INTO devices (id, fcm_token, name, registered_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET fcm_token = excluded.fcm_token,
                                    name = excluded.name,
                                    registered_at = excluded.registered_at`
  )
    .bind(body.device_id, body.fcm_token, body.name ?? null, now)
    .run()
  return c.json({ ok: true })
})

// ===== Approvals =====

app.post('/v1/approvals', async (c) => {
  const body = await c.req.json<{
    session_id: string
    cwd: string
    project_name: string
    tool_name: string
    tool_input: unknown
  }>()
  const id = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.prepare(
    `INSERT INTO approvals (id, session_id, cwd, project_name, tool_name, tool_input, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(
      id,
      body.session_id,
      body.cwd,
      body.project_name,
      body.tool_name,
      JSON.stringify(body.tool_input),
      now
    )
    .run()

  const devices = await c.env.DB.prepare('SELECT fcm_token FROM devices').all<{ fcm_token: string }>()
  const tokens = (devices.results ?? []).map((d) => d.fcm_token)

  const sends = tokens.map((token) =>
    sendFcm(c.env, {
      token,
      data: {
        type: 'approval_request',
        request_id: id,
        project: body.project_name,
        tool_name: body.tool_name,
        tool_summary: summarize(body.tool_name, body.tool_input),
        session_id: body.session_id,
      },
    }).catch((e) => {
      console.error('FCM send failed (approval)', e instanceof Error ? e.message : e)
    })
  )
  await Promise.allSettled(sends)

  return c.json({ id, status: 'pending', notified: tokens.length })
})

app.get('/v1/approvals/:id', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare(
    `SELECT id, status, reason, resolved_at, resolved_by FROM approvals WHERE id = ?`
  )
    .bind(id)
    .first<{
      id: string
      status: string
      reason: string | null
      resolved_at: number | null
      resolved_by: string | null
    }>()
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.json(row)
})

app.post('/v1/approvals/:id/respond', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{
    decision: 'allow' | 'deny'
    reason?: string
    device_id?: string
  }>()
  if (body.decision !== 'allow' && body.decision !== 'deny') {
    return c.json({ error: 'decision must be allow or deny' }, 400)
  }
  const now = Math.floor(Date.now() / 1000)
  const result = await c.env.DB.prepare(
    `UPDATE approvals
     SET status = ?, reason = ?, resolved_at = ?, resolved_by = ?
     WHERE id = ? AND status = 'pending'`
  )
    .bind(body.decision, body.reason ?? null, now, body.device_id ?? null, id)
    .run()

  if ((result.meta?.changes ?? 0) === 0) {
    const existing = await c.env.DB.prepare('SELECT status FROM approvals WHERE id = ?')
      .bind(id)
      .first<{ status: string }>()
    if (!existing) return c.json({ error: 'not found' }, 404)
    return c.json({ error: 'already resolved', status: existing.status }, 409)
  }
  return c.json({ ok: true, status: body.decision })
})

// ===== Notifications =====

app.post('/v1/notifications', async (c) => {
  const body = await c.req.json<{
    session_id: string
    cwd: string
    project_name: string
    kind: string
    title: string
    body?: string
  }>()
  const id = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
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
      now
    )
    .run()

  const devices = await c.env.DB.prepare('SELECT fcm_token FROM devices').all<{ fcm_token: string }>()
  const tokens = (devices.results ?? []).map((d) => d.fcm_token)

  const sends = tokens.map((token) =>
    sendFcm(c.env, {
      token,
      data: {
        type: 'info',
        kind: body.kind,
        project: body.project_name,
        title: body.title,
        body: body.body ?? '',
        session_id: body.session_id,
      },
    }).catch((e) => {
      console.error('FCM send failed (notification)', e instanceof Error ? e.message : e)
    })
  )
  await Promise.allSettled(sends)

  return c.json({ ok: true, id, notified: tokens.length })
})

// ===== Helpers =====

function summarize(toolName: string, toolInput: unknown): string {
  if (typeof toolInput !== 'object' || toolInput === null) return ''
  const input = toolInput as Record<string, unknown>
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return input.command.slice(0, 200)
  }
  if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') &&
      typeof input.file_path === 'string') {
    return input.file_path
  }
  try {
    return JSON.stringify(toolInput).slice(0, 200)
  } catch {
    return ''
  }
}

export default app
