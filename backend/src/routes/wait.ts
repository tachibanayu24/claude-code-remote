import { Hono } from 'hono'
import { nowSec, readJson } from '../db'
import { basename } from '../format'
import type { Bindings, WaitEvent, WaitRequest } from '../types'

const app = new Hono<{ Bindings: Bindings }>()

// channel.mjs caps its own request at WAIT_IDLE_MAX_MS + buffer; we keep the
// server-side cap below the Workers Free wall-time limit (30s) with margin.
const DEFAULT_WAIT_MS = 10_000
const MIN_WAIT_MS = 1_000
const MAX_WAIT_MS = 25_000
const D1_POLL_MS = 2_000

app.post('/', async (c) => {
  const body = await readJson<WaitRequest>(c.req.raw)
  if (!body?.session_id || !body.cwd) {
    return c.json({ error: 'session_id and cwd required' }, 400)
  }
  const sid = body.session_id
  const project = basename(body.cwd) || 'unknown'
  const pendingIds = (body.pending_request_ids ?? []).filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  )

  const maxMsRaw = Number(c.req.query('max_ms'))
  const maxMs = Number.isFinite(maxMsRaw)
    ? Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, maxMsRaw))
    : DEFAULT_WAIT_MS

  // Fold heartbeat into the same request: every /v1/wait round refreshes
  // last_heartbeat + the in-flight snapshot fields, removing the need for a
  // separate /v1/sessions/heartbeat call.
  const now = nowSec()
  const currentBlocksJson = body.current_blocks && body.current_blocks.length > 0
    ? JSON.stringify(body.current_blocks)
    : null
  await c.env.DB.prepare(
    `INSERT INTO sessions (session_id, cwd, project_name, ai_title, jsonl_mtime, last_heartbeat, updated_at, current_prompt, current_blocks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       cwd = excluded.cwd,
       project_name = excluded.project_name,
       ai_title = COALESCE(excluded.ai_title, sessions.ai_title),
       jsonl_mtime = excluded.jsonl_mtime,
       last_heartbeat = excluded.last_heartbeat,
       updated_at = excluded.updated_at,
       current_prompt = excluded.current_prompt,
       current_blocks = excluded.current_blocks`
  )
    .bind(
      sid,
      body.cwd,
      project,
      body.ai_title ?? null,
      body.jsonl_mtime ?? null,
      now,
      now,
      body.current_prompt ?? null,
      currentBlocksJson,
    )
    .run()

  const start = Date.now()
  while (true) {
    const elapsed = Date.now() - start
    if (elapsed >= maxMs) break

    const promptsRes = await c.env.DB.prepare(
      `SELECT id, text FROM prompts
       WHERE session_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 10`
    ).bind(sid).all<{ id: string; text: string }>()
    const prompts = promptsRes.results ?? []

    let verdicts: Array<{ id: string; status: string; add_to_allowlist: number }> = []
    if (pendingIds.length > 0) {
      const placeholders = pendingIds.map(() => '?').join(',')
      const verdictsRes = await c.env.DB.prepare(
        `SELECT id, status, add_to_allowlist FROM approvals
         WHERE id IN (${placeholders}) AND status IN ('allow', 'deny')`
      )
        .bind(...pendingIds)
        .all<{ id: string; status: string; add_to_allowlist: number }>()
      verdicts = verdictsRes.results ?? []
    }

    if (prompts.length > 0 || verdicts.length > 0) {
      const events: WaitEvent[] = []
      for (const p of prompts) events.push({ type: 'prompt', id: p.id, text: p.text })
      for (const v of verdicts) {
        events.push({
          type: 'verdict',
          request_id: v.id,
          behavior: v.status as 'allow' | 'deny',
          add_to_allowlist: Number(v.add_to_allowlist) === 1,
        })
      }
      return c.json({ events })
    }

    // Clamp sleep so the total hold respects max_ms — without this the last
    // iteration can overshoot by D1_POLL_MS - 1 (≈2s) and inflate latency.
    const remaining = maxMs - (Date.now() - start)
    if (remaining <= 0) break
    await new Promise((r) => setTimeout(r, Math.min(D1_POLL_MS, remaining)))
  }
  return c.json({ events: [] })
})

export default app
