#!/usr/bin/env node
// claude-code-remote channel server.
// Receives Claude Code permission_request notifications, forwards them to the
// Cloudflare Workers backend (which fans out FCM pushes to registered Android
// devices), and long-polls `/v1/wait` for verdicts + queued prompts. The
// same `/v1/wait` request body doubles as the heartbeat upsert (session
// state snapshot), so one round-trip covers all three flows: permission
// relay, prompt inject, and live progress.
//
// The local terminal dialog stays open in parallel with the phone push;
// whichever side answers first wins (Channels protocol applies the first
// verdict and drops the rest). When the phone responds with
// `add_to_allowlist`, the matching tool pattern is appended to the
// project-level `.claude/settings.local.json` so future invocations skip
// the prompt.
//
// All jsonl parsing lives in `../hooks/lib/jsonl.mjs`, shared with the Stop
// hook so both layers stay in sync.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CLAUDE_HOME, loadEnv } from '../hooks/lib/env.mjs'
import {
  aiTitleFromJsonl,
  assistantBlocksAfterFromJsonl,
  findPendingToolUseInJsonl,
  hasEndTurnAfter,
  hasToolResultFor,
  jsonlPath,
  lastUserPromptFromJsonl,
} from '../hooks/lib/jsonl.mjs'

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
const SESSION_LABEL_TTL_MS = 5_000
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

// Make sure relative imports work even when this file is invoked via symlink.
// (Not strictly needed today since we use `import` paths, but useful guard.)
void fileURLToPath(import.meta.url)

const log = (...args) => process.stderr.write(`[cc-remote] ${args.join(' ')}\n`)

// ---------- Config ----------

const env = loadEnv(log) ?? {}
const BACKEND = env.CC_REMOTE_BACKEND_URL?.replace(/\/$/, '') ?? ''
const SECRET = env.CC_REMOTE_SHARED_SECRET ?? ''
const PROJECT = basename(process.cwd())

if (!BACKEND || !SECRET) {
  log('config missing — channel will register with CC but no relay will happen')
}

// ---------- Backend HTTP ----------

const apiHeaders = {
  'Authorization': `Bearer ${SECRET}`,
  'Content-Type': 'application/json',
}

async function apiPost(path, payload, signal) {
  return fetch(`${BACKEND}${path}`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify(payload),
    signal,
  })
}

// ---------- Session lookup (sessionId / ai-title / jsonl mtime) ----------

/**
 * Resolve our parent CC's sessionId via `~/.claude/sessions/<ppid>.json`.
 * CC writes this file at startup with `{sessionId, cwd}`. Returns null if
 * the file doesn't exist or can't be parsed (e.g. CC is too old to write it).
 */
function readPpidSession() {
  try {
    const sess = JSON.parse(
      readFileSync(join(CLAUDE_HOME, 'sessions', `${process.ppid}.json`), 'utf8'),
    )
    if (sess.sessionId && sess.cwd) return sess
  } catch (_) {}
  return null
}

let labelCache = { value: '', ts: 0 }

function getSessionLabel() {
  const now = Date.now()
  if (now - labelCache.ts < SESSION_LABEL_TTL_MS) return labelCache.value
  const sess = readPpidSession()
  let label = ''
  if (sess) {
    try { label = aiTitleFromJsonl(readFileSync(jsonlPath(sess.cwd, sess.sessionId), 'utf8')) }
    catch (_) {}
  }
  labelCache = { value: label, ts: now }
  return label
}

/**
 * Snapshot of session state, sent to backend once per heartbeat tick.
 *
 * `current_prompt` and `current_blocks` are populated only while a turn is
 * in flight (latest user prompt has no `end_turn` after it). Both are
 * nulled out on the Stop hook by the backend, so we don't have to race
 * against it here. Backend derives `working` vs `idle` from current_prompt
 * — jsonl_mtime is exposed to clients as a freshness hint only.
 */
function inspectSession() {
  const sess = readPpidSession()
  const cwd = sess?.cwd ?? process.cwd()
  const sessionId = sess?.sessionId ?? null
  let jsonl_mtime = null
  let ai_title = ''
  let current_prompt = null
  let current_blocks = null
  if (sessionId) {
    const path = jsonlPath(cwd, sessionId)
    try { jsonl_mtime = statSync(path).mtimeMs } catch (_) {}
    try {
      const jsonl = readFileSync(path, 'utf8')
      ai_title = aiTitleFromJsonl(jsonl)
      const lastPrompt = lastUserPromptFromJsonl(jsonl)
      if (lastPrompt && !hasEndTurnAfter(jsonl, lastPrompt.lineIndex)) {
        current_prompt = lastPrompt.text || null
        const partial = assistantBlocksAfterFromJsonl(jsonl, lastPrompt.lineIndex)
        current_blocks = partial.length > 0 ? partial : null
      }
    } catch (_) {}
  }
  return { cwd, session_id: sessionId, ai_title, jsonl_mtime, current_prompt, current_blocks }
}

// ---------- Allowlist file management ----------

function deriveAllowPattern(toolName, inputPreview) {
  let parsed
  try {
    parsed = JSON.parse(inputPreview)
  } catch (_) {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  if (toolName === 'Bash' && typeof parsed.command === 'string') {
    const firstWord = parsed.command.trim().split(/\s+/)[0]
    if (!firstWord) return null
    // Strip path prefix so /usr/bin/jq → jq.
    const base = firstWord.split('/').pop() ?? firstWord
    return `Bash(${base}:*)`
  }
  // Edit/Write/MultiEdit deliberately omitted: CC's allowlist matcher takes
  // glob patterns, not literal file paths, so `Edit(/exact/file.kt)` would
  // only ever match that one file — the user wants tool-wide always-allow,
  // and we don't have enough context here to build a sensible glob. Better
  // to keep prompting than to silently lock the allowlist to a single path.
  if (toolName === 'WebFetch' && typeof parsed.url === 'string') {
    try {
      const host = new URL(parsed.url).host
      return `WebFetch(domain:${host})`
    } catch (_) {
      return null
    }
  }
  return null
}

function appendAllowPattern(cwd, pattern) {
  const settingsPath = join(cwd, '.claude/settings.local.json')
  let json = { permissions: { allow: [] } }
  if (existsSync(settingsPath)) {
    try {
      json = JSON.parse(readFileSync(settingsPath, 'utf8')) ?? json
    } catch (e) {
      log(`failed to parse ${settingsPath}, will overwrite: ${e.message}`)
      json = { permissions: { allow: [] } }
    }
  }
  json.permissions ??= {}
  json.permissions.allow ??= []
  if (json.permissions.allow.includes(pattern)) return false
  json.permissions.allow.push(pattern)
  mkdirSync(dirname(settingsPath), { recursive: true })
  // Atomic write: tmp + rename. CC itself also writes this file (e.g. on
  // /permissions add), so a non-atomic write can race and lose entries.
  // Rename-into-place is atomic on POSIX; collisions degrade to "last
  // writer wins" rather than "file truncated mid-write".
  const tmpPath = `${settingsPath}.cc-remote.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmpPath, JSON.stringify(json, null, 2) + '\n')
  renameSync(tmpPath, settingsPath)
  return true
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
      'cc-remote relays permission prompts to a phone via Cloudflare Workers + FCM. ' +
      'The local terminal dialog stays open; first responder wins.',
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

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const { request_id, tool_name, description, input_preview } = params
  if (!BACKEND || !SECRET) {
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

  // Compute "does Always have a meaningful effect for this tool?" here, so
  // backend / phone don't need their own copy of the Bash/WebFetch rule.
  // deriveAllowPattern is the single source of truth — if it returns a
  // pattern now, the phone's Always tap will produce the same one later.
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
  // ask_delay_ms > 0. We trigger /notify after the delay; if the local
  // terminal answered first, the wait loop's tool_result check has already
  // hit /dismiss and cleared notifyTimer, so this branch never fires.
  // Belt-and-suspenders: re-check JSONL inside the timer too, to close the
  // race between the wait loop's last poll and the timer firing.
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
 * Pending permission requests this channel is waiting for verdicts on.
 * Keyed by backend approval id (what /v1/wait echoes back as `request_id`).
 * Entries are removed on successful verdict emit, or swept after
 * APPROVAL_TIMEOUT_MS so /v1/wait isn't asked to track ids forever.
 */
const pendingApprovals = new Map()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sweepExpiredPending() {
  const now = Date.now()
  for (const [backendId, entry] of pendingApprovals) {
    if (entry.expiresAt <= now) {
      log(`timeout ${entry.ccRequestId} — local dialog will handle`)
      if (entry.notifyTimer) clearTimeout(entry.notifyTimer)
      pendingApprovals.delete(backendId)
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
 * Called from both the wait loop (early dismiss, runs every ~5s) and from
 * inside the /notify setTimeout (final guard before the FCM fires).
 */
async function maybeDismissFromJsonl(backendId, entry) {
  let jsonl = null
  try { jsonl = readFileSync(jsonlPath(entry.cwd, entry.sessionId), 'utf8') } catch (_) {}
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
  if (entry.notifyTimer) clearTimeout(entry.notifyTimer)
  pendingApprovals.delete(backendId)
  log(`dismissed ${entry.ccRequestId} (CLI answered before delay)`)
  return true
}

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
    if (!BACKEND || !SECRET) {
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
    // Early-dismiss path: if the user answered locally, the JSONL already
    // shows a tool_result on the bound tool_use_id. Drop these *before* we
    // commit the heartbeat so phone state and backend state stay aligned.
    for (const [backendId, entry] of [...pendingApprovals]) {
      try { await maybeDismissFromJsonl(backendId, entry) } catch (e) {
        log(`maybeDismiss error: ${e.message ?? e}`)
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
      params: { content: ev.text, meta: { source: 'phone', prompt_id: ev.id } },
    })
    // Echo full text — CC's banner truncates long prompts.
    log(`injected prompt ${ev.id}:\n${ev.text}`)
  } catch (e) {
    log(`prompt emit failed AFTER claim ${ev.id}: ${e.message ?? e}`)
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
    pendingApprovals.delete(ev.request_id)
    return
  }
  if (ev.behavior === 'allow' && ev.add_to_allowlist) {
    const pattern = deriveAllowPattern(entry.toolName, entry.inputPreview)
    if (pattern) {
      try {
        const added = appendAllowPattern(entry.cwd, pattern)
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
    if (entry.notifyTimer) clearTimeout(entry.notifyTimer)
    pendingApprovals.delete(ev.request_id)
  } catch (e) {
    // keep entry in pendingApprovals; next wait round will redeliver
    log(`emit failed ${entry.ccRequestId}: ${e.message ?? e}`)
  }
}

await mcp.connect(new StdioServerTransport())
log(`connected (backend=${BACKEND ? 'configured' : 'missing'})`)

// When CC parent dies, stdin closes. Exit so we don't keep the long-poll
// fetch alive past our usefulness.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))

waitLoop().catch((e) => {
  log(`waitLoop fatal: ${e.message ?? e}`)
  process.exit(1)
})
