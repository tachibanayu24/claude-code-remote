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

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const CLAUDE_HOME = join(homedir(), '.claude')
const ENV_PATH = process.env.CC_REMOTE_ENV ?? join(CLAUDE_HOME, 'hooks/.env')
const POLL_INTERVAL_MS = 1000
const POLL_TIMEOUT_MS = 5 * 60 * 1000
const SESSION_LABEL_TTL_MS = 5_000
// Heartbeat is also the cadence at which the phone's detail screen sees
// in-flight assistant text updates, so keep it tight. D1 writes are cheap
// (<$0 at this volume) and 3s is "live enough" for the chat-stream UX.
const HEARTBEAT_INTERVAL_MS = 3_000
const PROMPT_POLL_INTERVAL_MS = 2_000

const log = (...args) => process.stderr.write(`[cc-remote] ${args.join(' ')}\n`)

// ---------- Config ----------

function loadEnv() {
  let text
  try {
    text = readFileSync(ENV_PATH, 'utf8')
  } catch (e) {
    log(`cannot read ${ENV_PATH}: ${e.message}`)
    return null
  }
  const env = {}
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('#')) continue
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) env[m[1]] = m[2].replace(/^["'](.*)["']$/, '$1')
  }
  return env
}

const env = loadEnv() ?? {}
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

async function apiPost(path, payload) {
  return fetch(`${BACKEND}${path}`, {
    method: 'POST',
    headers: apiHeaders,
    body: JSON.stringify(payload),
  })
}

async function apiGet(path, signal) {
  return fetch(`${BACKEND}${path}`, { headers: apiHeaders, signal })
}

// ---------- Session lookup (sessionId / ai-title / jsonl mtime) ----------

const encodeCwd = (cwd) => cwd.replace(/[\/.]/g, '-')

/**
 * Resolve our parent CC's sessionId via `~/.claude/sessions/<ppid>.json`.
 * CC writes this file at startup with `{sessionId, cwd}`. Returns null if
 * the file doesn't exist or can't be parsed (e.g. CC is too old to write it).
 */
function readPpidSession() {
  try {
    const sess = JSON.parse(
      readFileSync(join(CLAUDE_HOME, 'sessions', `${process.ppid}.json`), 'utf8')
    )
    if (sess.sessionId && sess.cwd) return sess
  } catch (_) {}
  return null
}

function jsonlPath(cwd, sessionId) {
  return join(CLAUDE_HOME, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`)
}

function aiTitleFromJsonl(jsonl) {
  const lines = jsonl.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"ai-title"')) continue
    try {
      const parsed = JSON.parse(lines[i])
      if (parsed.type === 'ai-title' && parsed.aiTitle) return parsed.aiTitle
    } catch (_) {}
  }
  return ''
}

// Synthetic wrappers CC injects as `user` entries — slash command echoes,
// bash-mode IO, system reminders, etc. Skip them when looking for the
// "most recent external user prompt": they aren't what the human typed.
const SYNTHETIC_USER_WRAPPERS = [
  '<command-name>', '<command-message>', '<command-args>',
  '<local-command-stdout>', '<local-command-caveat>',
  '<bash-input>', '<bash-stdout>',
  '<persisted-output>', '<system-reminder>', '<task-notification>',
]

const CHANNEL_WRAPPER_RE = /^<channel\b[^>]*>\n?([\s\S]*?)\n?<\/channel>\s*$/

/**
 * Channel-injected prompts (phone → channel.mjs → CC) are written with
 * `isMeta: true` and `origin.kind === 'channel'` because CC treats them as
 * out-of-band notifications. They ARE real user input — strip the
 * `<channel ...>...</channel>` wrapper and surface the inner content.
 */
function isChannelInjectedPrompt(e) {
  return e.origin?.kind === 'channel'
}

function isSyntheticUserEntry(e) {
  if (isChannelInjectedPrompt(e)) return false  // real user input via phone
  if (e.isMeta || e.isCompactSummary || e.isVisibleInTranscriptOnly) return true
  const c = e.message?.content
  if (Array.isArray(c) && c[0]?.type === 'tool_result') return true
  const text = typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('')
      : ''
  const head = text.trimStart()
  return SYNTHETIC_USER_WRAPPERS.some((w) => head.startsWith(w))
}

function userEntryText(e) {
  const c = e.message?.content
  const raw = typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n')
      : ''
  if (isChannelInjectedPrompt(e)) {
    const m = raw.match(CHANNEL_WRAPPER_RE)
    if (m) return m[1].trim()
  }
  return raw.trim()
}

/**
 * Find the most recent external user prompt — i.e. what the human actually
 * typed at the prompt (terminal or phone). Skips tool_result injections,
 * compact-summary re-injections, slash-command echoes, bash-mode IO, and
 * other synthetic `user` entries CC writes for its own bookkeeping.
 * Channel-injected prompts (phone) are kept and unwrapped. Returns the
 * text and its line index (so callers can walk forward) or null if none.
 */
function lastUserPromptFromJsonl(jsonl) {
  if (!jsonl) return null
  const lines = jsonl.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"type":"user"')) continue
    try {
      const e = JSON.parse(line)
      if (e.type !== 'user') continue
      if (isSyntheticUserEntry(e)) continue
      return { text: userEntryText(e), lineIndex: i }
    } catch (_) {}
  }
  return null
}

/**
 * True if any assistant entry after `fromLineIndex` carries
 * `stop_reason: "end_turn"` — i.e. CC has finished narrating this turn.
 */
function hasEndTurnAfter(jsonl, fromLineIndex) {
  if (!jsonl) return false
  const lines = jsonl.split('\n')
  for (let i = fromLineIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('"stop_reason":"end_turn"')) continue
    try {
      const e = JSON.parse(line)
      if (e.type === 'assistant' && e.message?.stop_reason === 'end_turn') return true
    } catch (_) {}
  }
  return false
}

/**
 * Concatenate every assistant text block emitted after `fromLineIndex`,
 * prefixed with `● ` and joined with blank lines — mirrors how CC renders
 * interleaved chunks in the terminal. Used to surface the live, in-flight
 * narration on the phone before Stop fires.
 *
 * U+25CF (BLACK CIRCLE) instead of CC's U+23FA: the latter has emoji
 * presentation on Android and would render as a record button glyph.
 */
function assistantTextsAfterFromJsonl(jsonl, fromLineIndex) {
  if (!jsonl) return ''
  const lines = jsonl.split('\n')
  const chunks = []
  for (let i = Math.max(0, fromLineIndex + 1); i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('"type":"assistant"')) continue
    try {
      const e = JSON.parse(line)
      if (e.type !== 'assistant') continue
      const c = e.message?.content
      if (!Array.isArray(c)) continue
      const text = c
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim()
      if (text) chunks.push(text)
    } catch (_) {}
  }
  return chunks.map((t) => `● ${t}`).join('\n\n')
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
 * `jsonl_mtime` is what backend uses to derive `working` vs `idle` —
 * mtime is bumped on every assistant chunk / tool result write.
 *
 * `current_prompt` and `current_assistant_text` are populated only while a
 * turn is in flight (latest user prompt has no `end_turn` after it). Both
 * are nulled out on the Stop hook by the backend, so we don't have to race
 * against it here.
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
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const { request_id, tool_name, description, input_preview } = params
  if (!BACKEND || !SECRET) {
    log(`permission_request ${request_id} dropped (config missing)`)
    return
  }

  const cwd = process.cwd()
  let backendId
  try {
    const res = await apiPost('/v1/approvals', {
      session_id: 'channel',
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
    log(`poll error ${request_id}: ${e.message ?? e}`)
  )
})

async function pollAndEmit(backendId, ccRequestId, toolName, inputPreview, cwd) {
  const start = Date.now()
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    let data
    try {
      const r = await apiGet(`/v1/approvals/${backendId}`)
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
 * Tell backend we're alive every HEARTBEAT_INTERVAL_MS. Backend derives
 * `working` / `idle` / `closed` from `last_heartbeat` + `jsonl_mtime`,
 * so the only state we have to publish is "I exist + here is my latest
 * jsonl mtime". When CC dies, this subprocess dies with it and the next
 * `GET /v1/sessions` will see a stale heartbeat and mark us closed.
 */
async function sendHeartbeat() {
  if (!BACKEND || !SECRET) return
  try {
    await apiPost('/v1/sessions/heartbeat', inspectSession())
  } catch (e) {
    log(`heartbeat failed: ${e.message ?? e}`)
  }
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
  const cwd = sess?.cwd ?? process.cwd()
  const path = `/v1/sessions/${encodeURIComponent(cwd)}/prompts/queued`
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

sendHeartbeat()
setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS).unref()
setInterval(drainPrompts, PROMPT_POLL_INTERVAL_MS).unref()
