import { Hono } from 'hono'
import { parseToolInputBlob } from '../approvals'
import { cleanupOldTurns, cleanupStaleSessions, nowSec } from '../db'
import { parseQuestionsBlob } from '../questions'
import type { Bindings, SessionRow, TurnRow } from '../types'

const app = new Hono<{ Bindings: Bindings }>()

// channel.mjs は /v1/wait を 5–15s 周期で叩くが、 wait.ts は D1 Free の
// 書き込み枠節約のため「変化があったとき + 無変化なら 60s ごとの keepalive」
// しか last_heartbeat を書かない (wait.ts の throttle 定数を参照)。
// 180s = keepalive 60s + wait 1 round (≤15s) + エラー backoff 1 回 (≤30s)
// に余裕を載せた値。 これを超えたら channel は本当に死んでいるとみなす。
// graceful 終了はこの TTL を待たない — channel.mjs が終了時に /:sid/bye を
// POST して即 closed に落とす。
const SESSION_HEARTBEAT_TTL_SEC = 180
const TURNS_DEFAULT_LIMIT = 20
const TURNS_MAX_LIMIT = 50
// Window during which delivered prompts are still surfaced to the detail
// screen, so the queued bubble doesn't flicker off in the gap between
// channel.mjs claim and the next /v1/wait round (which carries the heartbeat
// upserting `current_prompt`). 15s ≈ 3 inflight wait cycles (5s) — long
// enough to outlast jitter, short enough not to leave a stale duplicate.
const RECENT_DELIVERED_TTL_SEC = 15

function parseJsonArray<T>(raw: string | null, label: string): T[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    console.warn(`failed to parse ${label}: ${e}`)
    return []
  }
}

app.get('/', async (c) => {
  // Cleanup is fire-and-forget so the GET stays semantically read-only from
  // the caller's perspective. Cheap (range scan on indexed last_heartbeat).
  c.executionCtx.waitUntil(cleanupStaleSessions(c.env.DB))

  const batchRes = await c.env.DB.batch<{
    session_id?: string
    cwd?: string
    project_name?: string
    ai_title?: string
    jsonl_mtime?: number
    last_heartbeat?: number
    current_prompt?: string
    cnt?: number
  }>([
    c.env.DB.prepare(
      `SELECT session_id, cwd, project_name, ai_title, jsonl_mtime, last_heartbeat, current_prompt
       FROM sessions ORDER BY last_heartbeat DESC`
    ),
    c.env.DB.prepare(
      "SELECT session_id, COUNT(*) as cnt FROM approvals WHERE status='pending' GROUP BY session_id"
    ),
  ])
  const sessionsRes = batchRes[0]!
  const pendingRes = batchRes[1]!
  const pendingMap = new Map(
    (pendingRes.results ?? []).map((r) => [r.session_id as string, (r.cnt as number) ?? 0])
  )

  const nowMs = Date.now()
  const sessions = (sessionsRes.results ?? []).map((r) => {
    const row = r as unknown as SessionRow
    const pendingCount = pendingMap.get(row.session_id) ?? 0
    const heartbeatAgeSec = Math.floor(nowMs / 1000) - row.last_heartbeat
    // jsonl_mtime is a fractional ms epoch on macOS — floor before exposing
    // so JSON consumers (Android Long) don't fail to deserialize.
    const jsonlAgeMs = row.jsonl_mtime ? Math.floor(nowMs - row.jsonl_mtime) : null
    // working = ターン処理中。channel.mjs が「最後の user prompt 以降に
    // end_turn が無い」ときだけ current_prompt を立て、Stop hook で NULL に
    // 戻すので、これが in-flight の正準シグナル。jsonl_mtime ベースの近似
    // (5s 以内に追記があるか) だと長い Bash や思考中に idle 誤判定が出る。
    let state: 'working' | 'awaiting_approval' | 'idle' | 'closed'
    if (heartbeatAgeSec > SESSION_HEARTBEAT_TTL_SEC) state = 'closed'
    else if (pendingCount > 0) state = 'awaiting_approval'
    else if (row.current_prompt) state = 'working'
    else state = 'idle'
    return {
      session_id: row.session_id,
      cwd: row.cwd,
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

app.get('/:sid/turns', async (c) => {
  const sid = c.req.param('sid')
  if (!sid) return c.json({ error: 'session_id required' }, 400)
  const limitParam = Number.parseInt(c.req.query('limit') ?? '', 10)
  const limit = Number.isFinite(limitParam) && limitParam > 0 && limitParam <= TURNS_MAX_LIMIT
    ? limitParam
    : TURNS_DEFAULT_LIMIT

  c.executionCtx.waitUntil(cleanupOldTurns(c.env.DB))

  const session = await c.env.DB.prepare(
    `SELECT session_id, cwd, project_name, ai_title, jsonl_mtime, last_heartbeat, current_prompt, current_blocks
     FROM sessions WHERE session_id = ?`
  ).bind(sid).first<SessionRow>()
  if (!session) return c.json({ error: 'not found' }, 404)

  const detailBatch = await c.env.DB.batch<unknown>([
    c.env.DB.prepare(
      `SELECT id, user_prompt, blocks, tool_summary, elapsed_ms, ended_at
       FROM turns WHERE session_id = ? ORDER BY ended_at DESC LIMIT ?`
    ).bind(sid, limit),
    c.env.DB.prepare(
      `SELECT id, tool_name, tool_input, created_at
       FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC`
    ).bind(sid),
    // Queued prompts (phone POST → channel.mjs drain pending). Surfaced so
    // the app can echo the user's just-sent message immediately, before
    // channel.mjs delivers and the heartbeat picks it up as `current_prompt`.
    // Recently-delivered prompts are kept for a short grace window so the
    // queued bubble doesn't flicker off; the Android client de-duplicates by
    // text against current_prompt and committed turn user_prompts.
    c.env.DB.prepare(
      `SELECT id, text, created_at FROM prompts
       WHERE session_id = ? AND (
         status = 'queued'
         OR (status = 'delivered' AND delivered_at >= ?)
       ) ORDER BY created_at ASC`
    ).bind(sid, nowSec() - RECENT_DELIVERED_TTL_SEC),
    // AskUserQuestion pending rows for this session — surfaced into the
    // chat-style detail screen so the user can answer in-place, mirroring
    // pending_approvals. resolved/expired rows are filtered out.
    c.env.DB.prepare(
      `SELECT id, questions, created_at
       FROM questions WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC`
    ).bind(sid),
  ])
  const turnsRes = detailBatch[0]!
  const pendingRes = detailBatch[1]!
  const queuedRes = detailBatch[2]!
  const questionsRes = detailBatch[3]!

  const turns = ((turnsRes.results ?? []) as TurnRow[]).map((r) => ({
    id: r.id,
    user_prompt: r.user_prompt,
    // Defensive parse: a corrupted JSON payload (manual DB tampering, half-
    // written rows from a previous version) shouldn't take the whole detail
    // endpoint down with a 500. Fall back to an empty list and warn — the
    // turn still renders, just without narration / tool info.
    blocks: parseJsonArray(r.blocks, `turn ${r.id} blocks`),
    tool_summary: parseJsonArray(r.tool_summary, `turn ${r.id} tool_summary`),
    elapsed_ms: r.elapsed_ms,
    ended_at: r.ended_at,
  }))

  const pendingApprovals = ((pendingRes.results ?? []) as Array<{
    id: string; tool_name: string; tool_input: string; created_at: number
  }>).map((r) => {
    const blob = parseToolInputBlob(r.tool_input)
    return {
      id: r.id,
      tool_name: r.tool_name,
      description: blob.description,
      input_preview: blob.input_preview,
      created_at: r.created_at,
      supports_always: blob.supports_always,
    }
  })

  const queuedPrompts = (queuedRes.results ?? []) as Array<{
    id: string; text: string; created_at: number
  }>

  const pendingQuestions = ((questionsRes.results ?? []) as Array<{
    id: string; questions: string; created_at: number
  }>).map((r) => ({
    id: r.id,
    questions: parseQuestionsBlob(r.questions).questions,
    created_at: r.created_at,
  }))

  return c.json({
    session: {
      session_id: session.session_id,
      cwd: session.cwd,
      project_name: session.project_name,
      ai_title: session.ai_title,
      current_prompt: session.current_prompt,
      current_blocks: parseJsonArray(session.current_blocks, `session ${session.session_id} current_blocks`),
      // Android detail 画面は「now - last_heartbeat < 30s」で入力バーの活性を
      // 判定する (SessionDetailScreen.kt の SESSION_LIVE_TTL_SEC)。 heartbeat
      // 書き込みが最長 60s 間隔に間引かれたため生値を返すと生存中でも 30s を
      // 超えてしまう。 生死判定はサーバ側 TTL に一本化し、 生きていれば now に
      // クランプして返す (= この field は「liveness シグナル」 に意味変更。
      // 端末とサーバの clock skew 依存も消える)。 死んでいれば生値のまま。
      last_heartbeat: nowSec() - session.last_heartbeat <= SESSION_HEARTBEAT_TTL_SEC
        ? nowSec()
        : session.last_heartbeat,
      // jsonl_mtime is a fractional ms epoch on macOS; floor for JSON Long
      // consumers (Android).
      jsonl_mtime: session.jsonl_mtime != null ? Math.floor(session.jsonl_mtime) : null,
    },
    turns,
    pending_approvals: pendingApprovals,
    queued_prompts: queuedPrompts,
    pending_questions: pendingQuestions,
  })
})

app.post('/:sid/bye', async (c) => {
  // channel.mjs の graceful shutdown 通知 (CC 終了 = stdin EOF / phone close の
  // SIGTERM 後)。 keepalive が最長 60s 間隔なので TTL 待ちだと閉じたセッション
  // が最長 3 分 「生存」 表示のまま残る。 last_heartbeat を TTL より過去に
  // 倒して即 closed に落とす。 close_requested_at も併せて掃除する — marker が
  // 立ったまま終了すると `claude --continue` 再開直後の初回 /v1/wait で close
  // が再発火して即死するため (終了するセッションに対する close 要求は moot)。
  // row が無い / 既に stale でも成功扱い (best-effort 通知、 冪等)。
  const sid = c.req.param('sid')
  if (!sid) return c.json({ error: 'session_id required' }, 400)
  await c.env.DB.prepare(
    `UPDATE sessions SET last_heartbeat = ?, close_requested_at = NULL
     WHERE session_id = ?`,
  ).bind(nowSec() - SESSION_HEARTBEAT_TTL_SEC - 1, sid).run()
  return c.json({ ok: true })
})

app.post('/:sid/close', async (c) => {
  // phone から「このセッションを閉じる」 要求。 D1 に marker を立てるだけで、
  // 実際の kill は channel.mjs が /v1/wait の events 経由で受け取り
  // process.kill(ppid, 'SIGTERM') する。 既に立っているなら no-op (idempotent)。
  const sid = c.req.param('sid')
  if (!sid) return c.json({ error: 'session_id required' }, 400)
  const result = await c.env.DB.prepare(
    `UPDATE sessions SET close_requested_at = ?
     WHERE session_id = ? AND close_requested_at IS NULL`,
  ).bind(nowSec(), sid).run()
  if ((result.meta?.changes ?? 0) === 0) {
    const existing = await c.env.DB.prepare(
      'SELECT session_id FROM sessions WHERE session_id = ?'
    ).bind(sid).first<{ session_id: string }>()
    if (!existing) return c.json({ error: 'not found' }, 404)
    return c.json({ ok: true, already_requested: true })
  }
  return c.json({ ok: true })
})

export default app
