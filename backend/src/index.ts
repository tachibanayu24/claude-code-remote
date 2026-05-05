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
  SessionHeartbeatRequest,
  SessionRow,
  TurnRow,
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
    await c.env.DB.prepare(
      `INSERT INTO turns (id, cwd, session_id, user_prompt, assistant_text, tool_summary, elapsed_ms, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        turnId,
        cwd,
        body.session_id ?? '',
        userPrompt || null,
        fullMessage || null,
        toolSummary,
        elapsedMs,
        nowSec()
      )
      .run()
    // The Stop event ends an in-flight turn — clear the live prompt marker so
    // the detail screen stops showing it as "current".
    await c.env.DB.prepare('UPDATE sessions SET current_prompt = NULL WHERE cwd = ?')
      .bind(cwd).run()
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

app.post('/v1/hook/posttool', async (c) => {
  const body = await c.req.json<HookPosttoolRequest>().catch(() => null)
  // Reject empty cwd: dismissPendingApprovals('') would expire pending rows
  // for *every* session, which collapses the multi-session use case.
  if (!body?.cwd) return c.json({ error: 'cwd required' }, 400)
  const dismissed = await dismissPendingApprovals(c.env.DB, c.env, body.cwd)
  return c.json({ ok: true, dismissed })
})

// ===== Sessions =====

app.post('/v1/sessions/heartbeat', async (c) => {
  const body = await c.req.json<SessionHeartbeatRequest>().catch(() => null)
  if (!body?.cwd) return c.json({ error: 'cwd required' }, 400)
  const project = basename(body.cwd) || 'unknown'
  const now = nowSec()
  await c.env.DB.prepare(
    `INSERT INTO sessions (cwd, session_id, project_name, ai_title, jsonl_mtime, last_heartbeat, updated_at, current_prompt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cwd) DO UPDATE SET
       session_id = excluded.session_id,
       project_name = excluded.project_name,
       ai_title = COALESCE(excluded.ai_title, sessions.ai_title),
       jsonl_mtime = excluded.jsonl_mtime,
       last_heartbeat = excluded.last_heartbeat,
       updated_at = excluded.updated_at,
       current_prompt = excluded.current_prompt`
  )
    .bind(
      body.cwd,
      body.session_id ?? null,
      project,
      body.ai_title ?? null,
      body.jsonl_mtime ?? null,
      now,
      now,
      body.current_prompt ?? null
    )
    .run()
  return c.json({ ok: true })
})

const SESSION_HEARTBEAT_TTL_SEC = 30
const SESSION_WORKING_TTL_MS = 5_000

app.get('/v1/sessions', async (c) => {
  // Drop sessions we haven't heard from in days; keeps the list tidy when a
  // project has been retired. Tunable; 7 days is generous.
  const STALE_AFTER_SEC = 7 * 24 * 3600
  await c.env.DB.prepare('DELETE FROM sessions WHERE last_heartbeat < ?')
    .bind(nowSec() - STALE_AFTER_SEC)
    .run()

  const sessionsRes = await c.env.DB.prepare(
    `SELECT cwd, session_id, project_name, ai_title, jsonl_mtime, last_heartbeat, current_prompt
     FROM sessions ORDER BY last_heartbeat DESC`
  ).all<SessionRow>()
  const pendingRes = await c.env.DB.prepare(
    "SELECT cwd, COUNT(*) as cnt FROM approvals WHERE status='pending' GROUP BY cwd"
  ).all<{ cwd: string; cnt: number }>()
  const pendingMap = new Map((pendingRes.results ?? []).map((r) => [r.cwd, r.cnt]))

  const nowMs = Date.now()
  const sessions = (sessionsRes.results ?? []).map((r) => {
    const pendingCount = pendingMap.get(r.cwd) ?? 0
    const heartbeatAgeSec = Math.floor(nowMs / 1000) - r.last_heartbeat
    // jsonl_mtime is a fractional ms epoch on macOS — floor before exposing
    // so JSON consumers (Android Long) don't fail to deserialize.
    const jsonlAgeMs = r.jsonl_mtime ? Math.floor(nowMs - r.jsonl_mtime) : null
    let state: 'working' | 'awaiting_approval' | 'idle' | 'closed'
    if (heartbeatAgeSec > SESSION_HEARTBEAT_TTL_SEC) state = 'closed'
    else if (pendingCount > 0) state = 'awaiting_approval'
    else if (jsonlAgeMs !== null && jsonlAgeMs < SESSION_WORKING_TTL_MS) state = 'working'
    else state = 'idle'
    return {
      cwd: r.cwd,
      session_id: r.session_id,
      project_name: r.project_name,
      ai_title: r.ai_title,
      current_prompt: r.current_prompt,
      state,
      pending_count: pendingCount,
      heartbeat_age_sec: heartbeatAgeSec,
      jsonl_age_ms: jsonlAgeMs,
    }
  })
  return c.json({ sessions })
})

const TURNS_DEFAULT_LIMIT = 5
const TURNS_RETENTION_SEC = 30 * 24 * 3600

app.get('/v1/sessions/:cwd/turns', async (c) => {
  const cwd = decodeURIComponent(c.req.param('cwd'))
  if (!cwd) return c.json({ error: 'cwd required' }, 400)
  const limitParam = Number.parseInt(c.req.query('limit') ?? '', 10)
  const limit = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= 50
    ? limitParam
    : TURNS_DEFAULT_LIMIT

  // Cleanup-on-read: drop turns older than the retention window. Cheap; the
  // index on (cwd, ended_at) makes this a range scan.
  await c.env.DB.prepare('DELETE FROM turns WHERE ended_at < ?')
    .bind(nowSec() - TURNS_RETENTION_SEC)
    .run()

  const session = await c.env.DB.prepare(
    `SELECT cwd, session_id, project_name, ai_title, jsonl_mtime, last_heartbeat, current_prompt
     FROM sessions WHERE cwd = ?`
  ).bind(cwd).first<SessionRow>()
  if (!session) return c.json({ error: 'not found' }, 404)

  const turnsRes = await c.env.DB.prepare(
    `SELECT id, user_prompt, assistant_text, tool_summary, elapsed_ms, ended_at
     FROM turns WHERE cwd = ? ORDER BY ended_at DESC LIMIT ?`
  ).bind(cwd, limit).all<TurnRow>()

  const turns = (turnsRes.results ?? []).map((r) => ({
    id: r.id,
    user_prompt: r.user_prompt,
    assistant_text: r.assistant_text,
    tool_summary: r.tool_summary ? JSON.parse(r.tool_summary) : [],
    elapsed_ms: r.elapsed_ms,
    ended_at: r.ended_at,
  }))

  return c.json({
    session: {
      cwd: session.cwd,
      session_id: session.session_id,
      project_name: session.project_name,
      ai_title: session.ai_title,
      current_prompt: session.current_prompt,
      last_heartbeat: session.last_heartbeat,
      // jsonl_mtime is a fractional ms epoch on macOS; floor for JSON Long
      // consumers (Android).
      jsonl_mtime: session.jsonl_mtime != null ? Math.floor(session.jsonl_mtime) : null,
    },
    turns,
  })
})

export default app
