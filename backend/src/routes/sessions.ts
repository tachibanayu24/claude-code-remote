import { Hono } from 'hono'
import {
  cleanupOldTurns,
  cleanupStaleSessions,
  nowSec,
  readJson,
} from '../db'
import { basename } from '../format'
import type { Bindings, SessionHeartbeatRequest, SessionRow, TurnRow } from '../types'

const app = new Hono<{ Bindings: Bindings }>()

const SESSION_HEARTBEAT_TTL_SEC = 30
const SESSION_WORKING_TTL_MS = 5_000
const TURNS_DEFAULT_LIMIT = 20
const TURNS_MAX_LIMIT = 50
// Window during which delivered prompts are still surfaced to the detail
// screen, so the queued bubble doesn't flicker off in the gap between
// channel.mjs claim and the heartbeat that picks the prompt up as
// `current_prompt` (whether via `type:"user"` or `type:"attachment"`
// queued_command). One heartbeat (3s) + a couple of safety ticks is plenty;
// any longer and the bubble lingers as a duplicate of the in-flight one.
const RECENT_DELIVERED_TTL_SEC = 15

app.post('/heartbeat', async (c) => {
  const body = await readJson<SessionHeartbeatRequest>(c.req.raw)
  if (!body?.cwd) return c.json({ error: 'cwd required' }, 400)
  const project = basename(body.cwd) || 'unknown'
  const now = nowSec()
  await c.env.DB.prepare(
    `INSERT INTO sessions (cwd, session_id, project_name, ai_title, jsonl_mtime, last_heartbeat, updated_at, current_prompt, current_assistant_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cwd) DO UPDATE SET
       session_id = excluded.session_id,
       project_name = excluded.project_name,
       ai_title = COALESCE(excluded.ai_title, sessions.ai_title),
       jsonl_mtime = excluded.jsonl_mtime,
       last_heartbeat = excluded.last_heartbeat,
       updated_at = excluded.updated_at,
       current_prompt = excluded.current_prompt,
       current_assistant_text = excluded.current_assistant_text`
  )
    .bind(
      body.cwd,
      body.session_id ?? null,
      project,
      body.ai_title ?? null,
      body.jsonl_mtime ?? null,
      now,
      now,
      body.current_prompt ?? null,
      body.current_assistant_text ?? null,
    )
    .run()
  return c.json({ ok: true })
})

app.get('/', async (c) => {
  // Cleanup is fire-and-forget so the GET stays semantically read-only from
  // the caller's perspective. Cheap (range scan on indexed last_heartbeat).
  c.executionCtx.waitUntil(cleanupStaleSessions(c.env.DB))

  const batchRes = await c.env.DB.batch<{
    cwd?: string
    session_id?: string
    project_name?: string
    ai_title?: string
    jsonl_mtime?: number
    last_heartbeat?: number
    current_prompt?: string
    cnt?: number
  }>([
    c.env.DB.prepare(
      `SELECT cwd, session_id, project_name, ai_title, jsonl_mtime, last_heartbeat, current_prompt
       FROM sessions ORDER BY last_heartbeat DESC`
    ),
    c.env.DB.prepare(
      "SELECT cwd, COUNT(*) as cnt FROM approvals WHERE status='pending' GROUP BY cwd"
    ),
  ])
  const sessionsRes = batchRes[0]!
  const pendingRes = batchRes[1]!
  const pendingMap = new Map(
    (pendingRes.results ?? []).map((r) => [r.cwd as string, (r.cnt as number) ?? 0])
  )

  const nowMs = Date.now()
  const sessions = (sessionsRes.results ?? []).map((r) => {
    const row = r as unknown as SessionRow
    const pendingCount = pendingMap.get(row.cwd) ?? 0
    const heartbeatAgeSec = Math.floor(nowMs / 1000) - row.last_heartbeat
    // jsonl_mtime is a fractional ms epoch on macOS — floor before exposing
    // so JSON consumers (Android Long) don't fail to deserialize.
    const jsonlAgeMs = row.jsonl_mtime ? Math.floor(nowMs - row.jsonl_mtime) : null
    let state: 'working' | 'awaiting_approval' | 'idle' | 'closed'
    if (heartbeatAgeSec > SESSION_HEARTBEAT_TTL_SEC) state = 'closed'
    else if (pendingCount > 0) state = 'awaiting_approval'
    else if (jsonlAgeMs !== null && jsonlAgeMs < SESSION_WORKING_TTL_MS) state = 'working'
    else state = 'idle'
    return {
      cwd: row.cwd,
      session_id: row.session_id,
      project_name: row.project_name,
      ai_title: row.ai_title,
      current_prompt: row.current_prompt,
      state,
      pending_count: pendingCount,
      heartbeat_age_sec: heartbeatAgeSec,
      jsonl_age_ms: jsonlAgeMs,
    }
  })
  return c.json({ sessions })
})

app.get('/:cwd/turns', async (c) => {
  const cwd = decodeURIComponent(c.req.param('cwd'))
  if (!cwd) return c.json({ error: 'cwd required' }, 400)
  const limitParam = Number.parseInt(c.req.query('limit') ?? '', 10)
  const limit = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= TURNS_MAX_LIMIT
    ? limitParam
    : TURNS_DEFAULT_LIMIT

  c.executionCtx.waitUntil(cleanupOldTurns(c.env.DB))

  const session = await c.env.DB.prepare(
    `SELECT cwd, session_id, project_name, ai_title, jsonl_mtime, last_heartbeat, current_prompt, current_assistant_text
     FROM sessions WHERE cwd = ?`
  ).bind(cwd).first<SessionRow>()
  if (!session) return c.json({ error: 'not found' }, 404)

  const detailBatch = await c.env.DB.batch<unknown>([
    c.env.DB.prepare(
      `SELECT id, user_prompt, assistant_text, tool_summary, elapsed_ms, ended_at
       FROM turns WHERE cwd = ? ORDER BY ended_at DESC LIMIT ?`
    ).bind(cwd, limit),
    c.env.DB.prepare(
      `SELECT id, tool_name, tool_input, created_at
       FROM approvals WHERE cwd = ? AND status = 'pending' ORDER BY created_at ASC`
    ).bind(cwd),
    // Queued prompts (phone POST /prompts → channel.mjs drain pending). Surfaced
    // so the app can echo the user's just-sent message immediately, before
    // channel.mjs delivers and the heartbeat picks it up as `current_prompt`.
    //
    // Recently-delivered prompts are included too — there's a 2-3s gap between
    // channel.mjs marking `delivered` and CC actually writing the user entry
    // to jsonl (which is what heartbeat reads). Without this, the queued
    // bubble flickers off then the in-flight bubble flickers on. The Android
    // client de-duplicates by text against current_prompt so we don't render
    // both bubbles at once.
    c.env.DB.prepare(
      `SELECT id, text, created_at FROM prompts
       WHERE cwd = ? AND (
         status = 'queued'
         OR (status = 'delivered' AND delivered_at >= ?)
       ) ORDER BY created_at ASC`
    ).bind(cwd, nowSec() - RECENT_DELIVERED_TTL_SEC),
  ])
  const turnsRes = detailBatch[0]!
  const pendingRes = detailBatch[1]!
  const queuedRes = detailBatch[2]!

  const turns = ((turnsRes.results ?? []) as TurnRow[]).map((r) => ({
    id: r.id,
    user_prompt: r.user_prompt,
    assistant_text: r.assistant_text,
    tool_summary: r.tool_summary ? JSON.parse(r.tool_summary) : [],
    elapsed_ms: r.elapsed_ms,
    ended_at: r.ended_at,
  }))

  const pendingApprovals = ((pendingRes.results ?? []) as Array<{
    id: string; tool_name: string; tool_input: string; created_at: number
  }>).map((r) => {
    let parsed: { description?: string; input_preview?: string } = {}
    try {
      parsed = JSON.parse(r.tool_input)
    } catch (e) {
      console.warn(`failed to parse tool_input for approval ${r.id}: ${e}`)
    }
    return {
      id: r.id,
      tool_name: r.tool_name,
      description: parsed.description ?? '',
      input_preview: parsed.input_preview ?? '',
      created_at: r.created_at,
    }
  })

  const queuedPrompts = (queuedRes.results ?? []) as Array<{
    id: string; text: string; created_at: number
  }>

  return c.json({
    session: {
      cwd: session.cwd,
      session_id: session.session_id,
      project_name: session.project_name,
      ai_title: session.ai_title,
      current_prompt: session.current_prompt,
      current_assistant_text: session.current_assistant_text,
      last_heartbeat: session.last_heartbeat,
      // jsonl_mtime is a fractional ms epoch on macOS; floor for JSON Long
      // consumers (Android).
      jsonl_mtime: session.jsonl_mtime != null ? Math.floor(session.jsonl_mtime) : null,
    },
    turns,
    pending_approvals: pendingApprovals,
    queued_prompts: queuedPrompts,
  })
})

export default app
