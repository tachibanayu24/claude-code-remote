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
  //
  // jsonl_mtime が null = jsonl ファイルがまだ存在しない (CC 起動直後で
  // 一度も会話していない、 または ppid session 情報が読めない) 状態。 この
  // タイミングで row を作ると、 そのまま SIGTERM などで CC が即死した場合
  // に「ai_title 空 + jsonl_mtime null」 のゴミ row が残るので skip する。
  // jsonl が書かれた次の poll で UPSERT が走るので、 正常なセッションは
  // 1 ラウンド遅れて登録される (実害なし)。 prompt poll / verdict / close
  // marker の処理は続行する (jsonl がまだ無くても close 要求は届けるべき)。
  const now = nowSec()
  const currentBlocksJson = body.current_blocks && body.current_blocks.length > 0
    ? JSON.stringify(body.current_blocks)
    : null
  if (body.jsonl_mtime != null) {
    await c.env.DB.prepare(
      // ai_title は inspectSession() が「jsonl はあるが aiTitleFromJsonl が
      // 失敗」 のケースで '' を送ってくる。 NULLIF で '' を NULL 扱いに
      // 寄せてから COALESCE することで、 既存の有効な ai_title を空文字で
      // 上書きしてしまうのを防ぐ。
      `INSERT INTO sessions (session_id, cwd, project_name, ai_title, jsonl_mtime, last_heartbeat, updated_at, current_prompt, current_blocks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         cwd = excluded.cwd,
         project_name = excluded.project_name,
         ai_title = COALESCE(NULLIF(excluded.ai_title, ''), sessions.ai_title),
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
        body.jsonl_mtime,
        now,
        now,
        body.current_prompt ?? null,
        currentBlocksJson,
      )
      .run()
  }

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

    // phone から POST /v1/sessions/:sid/close で立った marker を検出。
    // SELECT 1 列だけの軽い問い合わせ。 marker が立っていたら events に流す。
    const closeRow = await c.env.DB.prepare(
      'SELECT close_requested_at FROM sessions WHERE session_id = ?'
    ).bind(sid).first<{ close_requested_at: number | null }>()
    const closeRequested = closeRow?.close_requested_at != null

    if (prompts.length > 0 || verdicts.length > 0 || closeRequested) {
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
      if (closeRequested) {
        events.push({ type: 'close' })
        // marker を single-fire 化: ここで NULL に戻さないと `claude --continue`
        // で同じ session_id を再利用したとき、新 channel.mjs の初回 /v1/wait で
        // 過去の marker が再 emit されて即 SIGTERM → CC 即死する。 再度閉じたい
        // 場合は phone が POST /v1/sessions/:sid/close を再送すれば marker が
        // 立て直る (idempotent)。
        await c.env.DB.prepare(
          'UPDATE sessions SET close_requested_at = NULL WHERE session_id = ?'
        ).bind(sid).run()
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
