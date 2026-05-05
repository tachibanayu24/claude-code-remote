#!/usr/bin/env node
// claude-code-remote channel server.
// Receives Claude Code permission_request notifications, forwards them to the
// Cloudflare Workers backend (which fans out FCM pushes to registered Android
// devices), polls for the verdict, and emits permission notifications back to
// Claude Code. The local terminal dialog stays open in parallel; whichever
// side answers first wins (Channels protocol applies the first verdict and
// drops the rest). When the phone responds with `add_to_allowlist`, the
// matching tool pattern is appended to the project-level
// `.claude/settings.local.json` so future invocations skip the prompt.
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
  assistantTextsAfterFromJsonl,
  hasEndTurnAfter,
  jsonlPath,
  lastUserPromptFromJsonl,
} from '../hooks/lib/jsonl.mjs'

const POLL_INTERVAL_MS = 1000
const POLL_TIMEOUT_MS = 5 * 60 * 1000
const SESSION_LABEL_TTL_MS = 5_000
// Heartbeat cadence is adaptive: tight while a turn is in flight (so the
// phone's chat stream feels live), relaxed while idle (no new data anyway,
// just liveness). At idle we only need to refresh `last_heartbeat` inside
// SESSION_HEARTBEAT_TTL_SEC (30s on backend) to avoid being marked closed.
const HEARTBEAT_INFLIGHT_MS = 1_500
const HEARTBEAT_IDLE_MS = 5_000
const PROMPT_POLL_INTERVAL_MS = 2_000

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

async function apiGet(path, signal) {
  return fetch(`${BACKEND}${path}`, { headers: apiHeaders, signal })
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
 * `current_prompt` and `current_assistant_text` are populated only while a
 * turn is in flight (latest user prompt has no `end_turn` after it). Both
 * are nulled out on the Stop hook by the backend, so we don't have to race
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
  let current_assistant_text = null
  if (sessionId) {
    const path = jsonlPath(cwd, sessionId)
    try { jsonl_mtime = statSync(path).mtimeMs } catch (_) {}
    try {
      const jsonl = readFileSync(path, 'utf8')
      ai_title = aiTitleFromJsonl(jsonl)
      const lastPrompt = lastUserPromptFromJsonl(jsonl)
      if (lastPrompt && !hasEndTurnAfter(jsonl, lastPrompt.lineIndex)) {
        current_prompt = lastPrompt.text || null
        const partial = assistantTextsAfterFromJsonl(jsonl, lastPrompt.lineIndex)
        current_assistant_text = partial || null
      }
    } catch (_) {}
  }
  return { cwd, session_id: sessionId, ai_title, jsonl_mtime, current_prompt, current_assistant_text }
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

  let backendId
  try {
    const res = await apiPost('/v1/approvals', {
      session_id: sessionId,
      cwd,
      project_name: PROJECT,
      session_label: getSessionLabel(),
      tool_name,
      description,
      input_preview,
    })
    if (!res.ok) {
      log(`backend POST failed ${request_id}: HTTP ${res.status}`)
      return
    }
    backendId = (await res.json()).id
  } catch (e) {
    log(`backend POST error ${request_id}: ${e.message ?? e}`)
    return
  }

  pollAndEmit(backendId, request_id, tool_name, input_preview, cwd).catch((e) =>
    log(`poll error ${request_id}: ${e.message ?? e}`),
  )
})

async function pollAndEmit(backendId, ccRequestId, toolName, inputPreview, cwd) {
  const start = Date.now()
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    let data
    try {
      // Cap each poll to slightly less than the interval so a hung connection
      // can't stack up waiting requests across iterations.
      const r = await apiGet(`/v1/approvals/${backendId}`, AbortSignal.timeout(POLL_INTERVAL_MS - 100))
      if (!r.ok) continue
      data = await r.json()
    } catch (_) {
      continue
    }
    if (!data || data.status === 'pending') continue

    if (data.status !== 'allow' && data.status !== 'deny') {
      log(`stopped polling ${ccRequestId} (status=${data.status})`)
      return
    }

    if (data.status === 'allow' && data.add_to_allowlist) {
      const pattern = deriveAllowPattern(toolName, inputPreview)
      if (pattern) {
        try {
          const added = appendAllowPattern(cwd, pattern)
          log(added ? `allowlisted ${pattern}` : `allowlist already had ${pattern}`)
        } catch (e) {
          log(`allowlist write failed: ${e.message ?? e}`)
        }
      } else {
        log(`add_to_allowlist set but no pattern derivable for ${toolName}`)
      }
    }

    try {
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: ccRequestId, behavior: data.status },
      })
      log(`emitted verdict ${ccRequestId}=${data.status}`)
    } catch (e) {
      log(`emit failed ${ccRequestId}: ${e.message ?? e}`)
    }
    return
  }
  log(`timeout ${ccRequestId} — local dialog will handle`)
}

// ---------- Session heartbeat ----------

/**
 * Tell backend we're alive. Backend derives `working` / `idle` / `closed`
 * from `last_heartbeat` + `jsonl_mtime`, so the only state we have to
 * publish is "I exist + here is my latest jsonl mtime". When CC dies, this
 * subprocess dies with it and the next `GET /v1/sessions` will see a stale
 * heartbeat and mark us closed.
 *
 * Returns true when a turn is in flight (current_prompt != null) so the
 * scheduler knows whether to follow up at the inflight or idle cadence.
 */
async function sendHeartbeat() {
  if (!BACKEND || !SECRET) return false
  const snapshot = inspectSession()
  // Backend's sessions table is keyed by session_id now; without one there's
  // nothing to upsert. Skip silently — channel.mjs spawned by older CC that
  // doesn't write the ppid file would otherwise spam 400s.
  if (!snapshot.session_id) return false
  try {
    await apiPost('/v1/sessions/heartbeat', snapshot)
  } catch (e) {
    log(`heartbeat failed: ${e.message ?? e}`)
  }
  return snapshot.current_prompt != null
}

/**
 * Self-rescheduling heartbeat loop. setTimeout instead of setInterval so the
 * next interval can be picked based on whether we're in-flight or idle —
 * D1 writes scale with cadence, and being tight only when it matters keeps
 * us comfortably under the free-tier write budget.
 */
function scheduleHeartbeat(delay) {
  setTimeout(async () => {
    const inflight = await sendHeartbeat()
    scheduleHeartbeat(inflight ? HEARTBEAT_INFLIGHT_MS : HEARTBEAT_IDLE_MS)
  }, delay).unref()
}

// ---------- Prompt drain (phone → CC injection) ----------

/**
 * Drain queued prompts the user enqueued from the Android app and emit them
 * into the running CC session as `notifications/claude/channel` events —
 * Claude treats these as the next user turn.
 *
 * Claim-then-emit ordering: the `delivered` endpoint conditionally updates
 * `WHERE status = 'queued'`, so it returns 200 only for the channel that
 * wins the race when multiple CC sessions share a cwd. We only emit after
 * winning the claim, which prevents double-injection in the rare
 * multi-session case.
 */
async function drainPrompts() {
  if (!BACKEND || !SECRET) return
  const sess = readPpidSession()
  if (!sess?.sessionId) return  // queue is keyed by session_id
  const path = `/v1/sessions/${encodeURIComponent(sess.sessionId)}/prompts/queued`
  let prompts = []
  try {
    const r = await apiGet(path)
    if (!r.ok) return
    prompts = (await r.json()).prompts ?? []
  } catch (e) {
    log(`prompt drain fetch failed: ${e.message ?? e}`)
    return
  }
  for (const p of prompts) {
    let claimed = false
    try {
      const r = await apiPost(`/v1/prompts/${p.id}/delivered`, {})
      claimed = r.ok
    } catch (e) {
      log(`prompt claim failed ${p.id}: ${e.message ?? e}`)
      continue
    }
    if (!claimed) continue  // another channel won the race; let them emit it
    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: p.text, meta: { source: 'phone', prompt_id: p.id } },
      })
      // Echo the full prompt text on stderr so the CLI surfaces the entire
      // content (CC's own channel-banner display truncates long prompts).
      log(`injected prompt ${p.id}:\n${p.text}`)
    } catch (e) {
      // We've already acked: the prompt is lost rather than duplicated. Log
      // loudly so the user can retry from the app.
      log(`prompt emit failed AFTER claim ${p.id}: ${e.message ?? e}`)
    }
  }
}

await mcp.connect(new StdioServerTransport())
log(`connected (backend=${BACKEND ? 'configured' : 'missing'})`)

// Kick off immediately; the loop self-paces from the first response.
sendHeartbeat().then((inflight) =>
  scheduleHeartbeat(inflight ? HEARTBEAT_INFLIGHT_MS : HEARTBEAT_IDLE_MS),
)
// .unref() so an exiting CC parent isn't kept alive by these timers.
setInterval(drainPrompts, PROMPT_POLL_INTERVAL_MS).unref()
