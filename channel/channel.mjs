#!/usr/bin/env node
// claude-code-remote channel server (MCP, 常駐).
//
// 役割:
//   ① Approval relay      : CC の permission_request を受け、 backend に POST、
//                           /v1/wait の long-poll で verdict を取り MCP notify で
//                           CC に返す。 JSONL 監視で「PC 早勝ち」 を検出して
//                           /v1/approvals/:id/dismiss も叩く。
//   ② Prompt inject       : phone が backend に積んだ queued prompt を /v1/wait の
//                           event 駆動で受け取り、 MCP notify で CC に流す。
//   ③ Heartbeat / 進捗    : /v1/wait body に jsonl から抽出した current_prompt /
//                           current_blocks を同梱して backend に upsert。
//
// AskUserQuestion (= question relay) は CC が MCP channel に流さないため
// 当 server は扱わない。 専用 PermissionRequest hook `hooks/ask-user-question.mjs`
// が per-call で処理する (詳細: docs/architecture.md)。
//
// CC の local dialog と phone notification は並列で生き、 先に答えた方が勝つ
// (first responder wins)。
//
// Submodules:
//   ./lib/api.mjs       — config (BACKEND, SECRET) + apiPost
//   ./lib/session.mjs   — readPpidSession, getSessionLabel, inspectSession
//   ./lib/allowlist.mjs — deriveAllowPattern, appendAllowPattern
//   ../hooks/lib/jsonl.mjs — shared JSONL parsers (with the Stop hook)

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import {
  findPendingToolUseInJsonl,
  hasToolResultFor,
  jsonlPath,
} from '../hooks/lib/jsonl.mjs'
import { apiPost, isConfigured } from './lib/api.mjs'
import { appendAllowPattern, deriveAllowPattern } from './lib/allowlist.mjs'
import {
  getSessionLabel,
  inspectSession,
  readPpidSession,
} from './lib/session.mjs'

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
// Long-poll cadence for /v1/wait. The same request also carries the
// heartbeat snapshot, so wait cadence == heartbeat cadence. Inflight uses a
// shorter hold so the phone sees `current_blocks` updates with ~5s lag;
// idle holds longer to keep request count down (CF Workers Free is 100k
// req/day).
const WAIT_INFLIGHT_MAX_MS = 5_000
const WAIT_IDLE_MAX_MS = 15_000
// Network-level timeout: server-side cap + slack for transit + retry hop.
const WAIT_REQUEST_TIMEOUT_BUFFER_MS = 5_000
const WAIT_BACKOFF_MAX_MS = 30_000

const log = (...args) => process.stderr.write(`[cc-remote] ${args.join(' ')}\n`)
const PROJECT = basename(process.cwd())

if (!isConfigured()) {
  log('config missing — channel will register with CC but no relay will happen')
}

// ---------- MCP server ----------

const mcp = new Server(
  { name: 'cc-remote', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
    },
    instructions:
      // Injected into CC's system prompt. The phone's added instructions reach
      // CC as channel notifications, which CC wraps as a <channel> tag — so we
      // must tell the model these are the user speaking, not background events.
      'cc-remote bridges this Claude Code session to the user\'s phone. ' +
      'Inbound messages arrive wrapped as <channel source="cc-remote" origin="phone"> ' +
      'and are instructions the user sent from their phone while away from the terminal. ' +
      'Treat each one as a direct instruction from the user and act on it exactly as if ' +
      'they had typed it into the terminal. There is no channel reply tool — the user ' +
      'follows your progress in a separate app, so just carry out the work. ' +
      'This server also relays tool-permission prompts to the phone; the local terminal ' +
      'dialog stays open in parallel and whichever responder answers first wins.',
  },
)

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string().optional().default(''),
    input_preview: z.string().optional().default(''),
  }),
})

// ---------- Pending approvals state ----------

/**
 * Pending permission requests this channel is waiting for verdicts on.
 * Keyed by backend approval id (what /v1/wait echoes back as `request_id`).
 * Entries are removed on successful verdict emit, JSONL-based early dismiss,
 * or APPROVAL_TIMEOUT_MS sweep so /v1/wait isn't asked to track ids forever.
 */
const pendingApprovals = new Map()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Cancel the deferred /notify timer (if any) and drop the entry. */
function clearPending(backendId) {
  const entry = pendingApprovals.get(backendId)
  if (!entry) return
  if (entry.notifyTimer) clearTimeout(entry.notifyTimer)
  pendingApprovals.delete(backendId)
}

function sweepExpiredPending() {
  const now = Date.now()
  for (const [backendId, entry] of pendingApprovals) {
    if (entry.expiresAt <= now) {
      log(`timeout ${entry.ccRequestId} — local dialog will handle`)
      clearPending(backendId)
    }
  }
}

/**
 * Check whether the CLI has already moved past this approval by inspecting
 * JSONL for a tool_result on the bound tool_use_id. If yes, expire the
 * backend row (which fans out a `decision:'expired'` resolve push so the
 * phone clears any in-flight UI) and drop the pending entry. Returns true
 * iff dismiss happened.
 *
 * Accepts pre-read `jsonl` so the wait loop can share one read across all
 * pending entries; the setTimeout fallback path reads it itself.
 */
async function maybeDismissFromJsonl(backendId, entry, jsonl) {
  if (jsonl == null) {
    try { jsonl = readFileSync(jsonlPath(entry.cwd, entry.sessionId), 'utf8') } catch (_) {}
  }
  if (!jsonl) return false
  if (!entry.toolUseId) {
    entry.toolUseId = findPendingToolUseInJsonl(jsonl, entry.toolName, entry.inputPreview)?.id ?? null
  }
  if (!entry.toolUseId) return false
  if (!hasToolResultFor(jsonl, entry.toolUseId)) return false
  try {
    const r = await apiPost(`/v1/approvals/${backendId}/dismiss`, {})
    if (!r.ok) log(`/dismiss HTTP ${r.status} for ${entry.ccRequestId}`)
  } catch (e) {
    log(`/dismiss error for ${entry.ccRequestId}: ${e.message ?? e}`)
  }
  clearPending(backendId)
  log(`dismissed ${entry.ccRequestId} (CLI answered before delay)`)
  return true
}

// ---------- Permission request handler ----------

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const { request_id, tool_name, description, input_preview } = params
  if (!isConfigured()) {
    log(`permission_request ${request_id} dropped (config missing)`)
    return
  }

  const sess = readPpidSession()
  const sessionId = sess?.sessionId
  const cwd = sess?.cwd ?? process.cwd()
  if (!sessionId) {
    // Without sessionId we can't route the approval to a specific CC instance
    // in the per-session backend. Older CC builds (no ppid file) hit this.
    log(`permission_request ${request_id} dropped (no sessionId — older CC?)`)
    return
  }

  // `supports_always` mirrors deriveAllowPattern's verdict so phone / backend
  // don't need their own copy of the Bash/WebFetch rule.
  const supportsAlways = deriveAllowPattern(tool_name, input_preview) != null

  let backendId
  let notifyAfterMs = 0
  try {
    const res = await apiPost('/v1/approvals', {
      session_id: sessionId,
      cwd,
      project_name: PROJECT,
      session_label: getSessionLabel(),
      tool_name,
      description,
      input_preview,
      supports_always: supportsAlways,
    })
    if (!res.ok) {
      log(`backend POST failed ${request_id}: HTTP ${res.status}`)
      return
    }
    const json = await res.json()
    backendId = json.id
    notifyAfterMs = Number(json.notify_after_ms) || 0
  } catch (e) {
    log(`backend POST error ${request_id}: ${e.message ?? e}`)
    return
  }

  // Bind this approval to the corresponding tool_use_id in JSONL. CC writes
  // the tool_use block before firing the permission notification, so it
  // should already be present — but defer (null) and retry from the wait
  // loop if buffering delays it. The id is what waitLoop tracks against
  // tool_result to detect "CC moved past this prompt" (allow → tool ran,
  // deny → error result written).
  let toolUseId = null
  try {
    const jsonl = readFileSync(jsonlPath(cwd, sessionId), 'utf8')
    toolUseId = findPendingToolUseInJsonl(jsonl, tool_name, input_preview)?.id ?? null
  } catch (_) {}

  // Backend creates the row in pending state but skips the FCM push when
  // ask_delay_ms > 0. We trigger /notify after the delay; if the wait loop's
  // tool_result check has already hit /dismiss, clearPending fired and this
  // branch never runs. Belt-and-suspenders: re-check JSONL inside the timer
  // too, to close the race between the wait loop's last poll and the timer
  // firing.
  const entry = {
    ccRequestId: request_id,
    toolName: tool_name,
    inputPreview: input_preview,
    cwd,
    sessionId,
    toolUseId,
    notifyTimer: null,
    expiresAt: Date.now() + APPROVAL_TIMEOUT_MS,
  }
  if (notifyAfterMs > 0) {
    entry.notifyTimer = setTimeout(async () => {
      if (await maybeDismissFromJsonl(backendId, entry)) return
      apiPost(`/v1/approvals/${backendId}/notify`, {})
        .then((r) => { if (!r.ok) log(`notify POST ${request_id}: HTTP ${r.status}`) })
        .catch((e) => log(`notify POST error ${request_id}: ${e.message ?? e}`))
    }, notifyAfterMs)
    entry.notifyTimer.unref()
  }
  pendingApprovals.set(backendId, entry)
})

// ---------- /v1/wait long-poll loop ----------

/**
 * Single long-poll loop replacing the old heartbeat + prompt-drain +
 * verdict-poll trio. Each /v1/wait round:
 *   1. Upserts the heartbeat snapshot (the request body == the heartbeat).
 *   2. Returns immediately if any queued prompt or pending verdict is ready.
 *   3. Otherwise holds for max_ms (server-side capped at 25s) and returns
 *      empty.
 * Inflight rounds use a shorter hold so the phone sees live progress with
 * ~5s lag; idle rounds hold longer to amortize request count over the
 * Workers Free 100k req/day budget.
 */
async function waitLoop() {
  let backoffMs = 1_000
  while (true) {
    if (!isConfigured()) {
      await sleep(WAIT_BACKOFF_MAX_MS)
      continue
    }
    sweepExpiredPending()
    const snapshot = inspectSession()
    if (!snapshot.session_id) {
      // Older CC builds without ppid file land here — nothing to do but wait.
      await sleep(2_000)
      continue
    }
    // Early-dismiss path (approval): JSONL の tool_result 出現で CLI 早勝ち
    // 判定。 AskUserQuestion 用の dismiss は PostToolUse hook の
    // dismissPendingQuestionsBySession に一任 (個別 tool_use_id binding が無
    // くても session-wide で expire できるので channel.mjs では扱わない)。
    if (pendingApprovals.size > 0) {
      let jsonl = null
      try { jsonl = readFileSync(jsonlPath(snapshot.cwd, snapshot.session_id), 'utf8') } catch (_) {}
      for (const [backendId, entry] of [...pendingApprovals]) {
        try { await maybeDismissFromJsonl(backendId, entry, jsonl) } catch (e) {
          log(`maybeDismiss error: ${e.message ?? e}`)
        }
      }
    }
    const inflight = snapshot.current_prompt != null
    const maxMs = inflight ? WAIT_INFLIGHT_MAX_MS : WAIT_IDLE_MAX_MS
    const body = {
      session_id: snapshot.session_id,
      cwd: snapshot.cwd,
      ai_title: snapshot.ai_title,
      jsonl_mtime: snapshot.jsonl_mtime,
      current_prompt: snapshot.current_prompt,
      current_blocks: snapshot.current_blocks,
      pending_request_ids: [...pendingApprovals.keys()],
    }
    let data
    try {
      const r = await apiPost(
        `/v1/wait?max_ms=${maxMs}`,
        body,
        AbortSignal.timeout(maxMs + WAIT_REQUEST_TIMEOUT_BUFFER_MS),
      )
      if (!r.ok) {
        log(`/v1/wait HTTP ${r.status}`)
        await sleep(backoffMs)
        backoffMs = Math.min(backoffMs * 2, WAIT_BACKOFF_MAX_MS)
        continue
      }
      data = await r.json()
      backoffMs = 1_000
    } catch (e) {
      log(`/v1/wait error: ${e.message ?? e}`)
      await sleep(backoffMs)
      backoffMs = Math.min(backoffMs * 2, WAIT_BACKOFF_MAX_MS)
      continue
    }
    for (const ev of data.events ?? []) {
      try {
        if (ev.type === 'prompt') await handlePromptEvent(ev)
        else if (ev.type === 'verdict') await handleVerdictEvent(ev)
        else if (ev.type === 'close') handleCloseEvent()
      } catch (e) {
        log(`event handler error: ${e.message ?? e}`)
      }
    }
  }
}

/**
 * Claim-then-emit so multi-CC-on-same-session races stay safe: only the
 * channel that wins `/v1/prompts/:id/delivered` actually injects. If we win
 * the claim but the MCP emit fails, the prompt is lost rather than
 * duplicated — log loudly so the user can resend.
 */
async function handlePromptEvent(ev) {
  let claimed = false
  try {
    const r = await apiPost(`/v1/prompts/${ev.id}/delivered`, {})
    claimed = r.ok
  } catch (e) {
    log(`prompt claim failed ${ev.id}: ${e.message ?? e}`)
    return
  }
  if (!claimed) return  // another channel got it; they'll emit
  try {
    await mcp.notification({
      method: 'notifications/claude/channel',
      // CC sets the `source` attribute from our server name ("cc-remote"), so we
      // use `origin` (not `source`) here to avoid a duplicate tag attribute. Both
      // keys must be identifier-safe — CC silently drops keys with hyphens etc.
      params: { content: ev.text, meta: { origin: 'phone', prompt_id: ev.id } },
    })
    // Echo full text — CC's banner truncates long prompts.
    log(`injected prompt ${ev.id}:\n${ev.text}`)
  } catch (e) {
    log(`prompt emit failed AFTER claim ${ev.id}: ${e.message ?? e}`)
  }
}

/**
 * Phone から「閉じる」 要求。 channel.mjs は CC の子プロセスなので、
 * parent (= CC 本体) に SIGTERM を送れば CC が gracefully 終了し、 結果として
 * channel.mjs (子) も stdin EOF で自然終了する。
 *
 * Backend 側の close_requested_at marker は wait.ts が close event を emit する
 * 同じ round で NULL に戻す (single-fire) ので、 この event は 1 セッションに
 * つき最大 1 回しか届かない。 `claude --continue` で同 session_id を再利用
 * しても過去 marker による即死は起きない。 再度閉じたい場合は phone が
 * POST /v1/sessions/:sid/close を再送して marker を立て直す。
 */
function handleCloseEvent() {
  log(`close requested — sending SIGTERM to parent CC (pid=${process.ppid})`)
  try {
    process.kill(process.ppid, 'SIGTERM')
  } catch (e) {
    log(`SIGTERM failed: ${e.message ?? e}`)
  }
}

/**
 * Verdict came back from the phone (via /v1/wait dispatch). Apply allowlist
 * side-effect first, then emit the permission notification, then forget the
 * pending entry. If the emit fails we keep it pending so the next /v1/wait
 * round redelivers the same verdict.
 */
async function handleVerdictEvent(ev) {
  const entry = pendingApprovals.get(ev.request_id)
  if (!entry) return  // unknown id (already handled or swept)
  if (ev.behavior !== 'allow' && ev.behavior !== 'deny') {
    log(`unexpected verdict behavior=${ev.behavior} for ${entry.ccRequestId}`)
    clearPending(ev.request_id)
    return
  }
  if (ev.behavior === 'allow' && ev.add_to_allowlist) {
    const pattern = deriveAllowPattern(entry.toolName, entry.inputPreview)
    if (pattern) {
      try {
        const added = appendAllowPattern(entry.cwd, pattern, log)
        log(added ? `allowlisted ${pattern}` : `allowlist already had ${pattern}`)
      } catch (e) {
        log(`allowlist write failed: ${e.message ?? e}`)
      }
    } else {
      log(`add_to_allowlist set but no pattern derivable for ${entry.toolName}`)
    }
  }
  try {
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: entry.ccRequestId, behavior: ev.behavior },
    })
    log(`emitted verdict ${entry.ccRequestId}=${ev.behavior}`)
    clearPending(ev.request_id)
  } catch (e) {
    // keep entry in pendingApprovals; next wait round will redeliver
    log(`emit failed ${entry.ccRequestId}: ${e.message ?? e}`)
  }
}

await mcp.connect(new StdioServerTransport())
log(`connected (backend=${isConfigured() ? 'configured' : 'missing'})`)

// When CC parent dies, stdin closes. Exit so we don't keep the long-poll
// fetch alive past our usefulness.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))

waitLoop().catch((e) => {
  log(`waitLoop fatal: ${e.message ?? e}`)
  process.exit(1)
})
