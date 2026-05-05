import { Hono } from 'hono'
import { basename, formatElapsed, previewLine } from './format'
import { notifyApprovalRequest, notifyApprovalResolved, notifyInfo } from './push'
import type {
  ApprovalCreateRequest,
  ApprovalRespondRequest,
  ApprovalRow,
  Bindings,
  DeviceRegisterRequest,
  HookPosttoolRequest,
  HookStopRequest,
} from './types'

const app = new Hono<{ Bindings: Bindings }>()

app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }))

async function timingSafeBearerEqual(provided: string | undefined, expected: string): Promise<boolean> {
  if (!provided) return false
  // Hash both sides to a fixed length, then compare byte-by-byte. Avoids
  // length and prefix-time leaks from a naive string compare.
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(provided)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ])
  const av = new Uint8Array(a)
  const bv = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < av.length; i++) diff |= av[i]! ^ bv[i]!
  return diff === 0
}

app.use('/v1/*', async (c, next) => {
  const header = c.req.header('Authorization') ?? ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!(await timingSafeBearerEqual(provided, c.env.SHARED_SECRET))) {
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
  // tool_input is preserved in D1 for a future history view (description +
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
    `SELECT id, status, resolved_at, resolved_by, add_to_allowlist
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

async function dismissPendingApprovals(db: D1Database, env: Bindings, cwd: string): Promise<number> {
  // cwd is required — '' would match every row. Callers must validate.
  if (!cwd) return 0
  const ids = await db.prepare("SELECT id FROM approvals WHERE status = 'pending' AND cwd = ?")
    .bind(cwd)
    .all<{ id: string }>()
  const dismissed = (ids.results ?? []).map((r) => r.id)
  if (dismissed.length === 0) return 0
  await db.prepare("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE status = 'pending' AND cwd = ?")
    .bind(nowSec(), cwd)
    .run()
  await Promise.all(dismissed.map((id) =>
    notifyApprovalResolved(env, db, {
      request_id: id,
      decision: 'expired',
      resolved_by: 'cli',
    })
  ))
  return dismissed.length
}

// ===== Hook =====

app.post('/v1/hook/stop', async (c) => {
  const body = await c.req.json<HookStopRequest>()
  const cwd = body.cwd ?? ''
  const project = basename(cwd) || 'unknown'
  const elapsedMs = body.elapsed_ms ?? null
  const fullMessage = body.full_message ?? ''
  const aiTitle = body.ai_title ?? ''
  const dryRun = body.dry_run === true

  const dismissed = dryRun ? 0 : await dismissPendingApprovals(c.env.DB, c.env, cwd)

  // Threshold gate: skip the FCM push for short turns. Backend-side so the PC
  // hook doesn't need its own env knob.
  const threshold = Number.parseInt(c.env.STOP_THRESHOLD_MS ?? '180000', 10)
  if (elapsedMs !== null && elapsedMs < threshold) {
    return c.json({ ok: true, dismissed, notified: 0, skipped: 'below_threshold', dry_run: dryRun })
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
    project,
    session_label: aiTitle,
    title,
    body: summary,
    session_id: body.session_id ?? '',
    elapsed_ms: elapsedMs != null ? String(elapsedMs) : '',
    full_message: fullMessage,
  })
  return c.json({ ok: true, id, dismissed, notified })
})

app.post('/v1/hook/posttool', async (c) => {
  const body = await c.req.json<HookPosttoolRequest>().catch(() => null)
  // Reject empty cwd: dismissPendingApprovals('') would expire pending rows
  // for *every* session, which collapses the multi-session use case.
  if (!body?.cwd) return c.json({ error: 'cwd required' }, 400)
  const dismissed = await dismissPendingApprovals(c.env.DB, c.env, body.cwd)
  return c.json({ ok: true, dismissed })
})

export default app
