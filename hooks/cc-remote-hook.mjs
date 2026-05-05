#!/usr/bin/env node
// claude-code-remote: Claude Code Stop / PostToolUse hook.
// Sends a one-shot push to phone when Claude finishes a turn that exceeded
// the threshold. Permission approvals are NOT handled here — they go through
// the MCP channel server (see channel/channel.mjs and Channels permission
// relay). PostToolUse fires after each tool execution to clean up any pending
// phone notifications when the user answered locally in the CLI.
//
// Modes: stop | posttool

import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const CLAUDE_HOME = join(homedir(), '.claude')
const ENV_PATH = process.env.CC_REMOTE_ENV ?? join(CLAUDE_HOME, 'hooks/.env')

const log = (msg) => process.stderr.write(`cc-remote-hook: ${msg}\n`)

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

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (e) {
    log(`invalid stdin JSON: ${e.message}`)
    return {}
  }
}

// ---------- Backend client ----------

function makeClient(env) {
  const backend = env.CC_REMOTE_BACKEND_URL.replace(/\/$/, '')
  const headers = {
    'Authorization': `Bearer ${env.CC_REMOTE_SHARED_SECRET}`,
    'Content-Type': 'application/json',
  }
  return async function post(path, payload) {
    try {
      await fetch(`${backend}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })
    } catch (_) {
      // best-effort, silent
    }
  }
}

// ---------- ai-title lookup (mirrors channel/channel.mjs#getSessionLabel) ----------

const encodeCwd = (cwd) => cwd.replace(/[\/.]/g, '-')

/**
 * Read CC's per-session jsonl. Tries the direct path under
 * `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` first; falls back to scanning
 * all project dirs for a matching `<sid>.jsonl`. The fallback covers the case
 * where the hook's `input.cwd` is a subdirectory (because the user/agent ran
 * `cd` inside Bash) and no longer matches the project root that CC encoded.
 */
function readSessionJsonl(cwd, sessionId) {
  if (!sessionId) return null
  if (cwd) {
    try {
      return readFileSync(
        join(CLAUDE_HOME, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`),
        'utf8'
      )
    } catch (_) {}
  }
  const projectsDir = join(CLAUDE_HOME, 'projects')
  let dirs
  try { dirs = readdirSync(projectsDir) } catch (_) { return null }
  for (const dir of dirs) {
    try {
      return readFileSync(join(projectsDir, dir, `${sessionId}.jsonl`), 'utf8')
    } catch (_) {}
  }
  return null
}

/**
 * Read the canonical session cwd from the first jsonl entry that has it
 * (falling back to whatever the hook reported if the jsonl can't be parsed).
 */
function canonicalCwdFromJsonl(jsonl, fallback) {
  if (!jsonl) return fallback
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"cwd"')) continue
    try {
      const e = JSON.parse(line)
      if (typeof e.cwd === 'string' && e.cwd) return e.cwd
    } catch (_) {}
  }
  return fallback
}

function aiTitleFromJsonl(jsonl) {
  if (!jsonl) return ''
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

/**
 * Timestamp (ms) of the most recent external user prompt — a `user` entry
 * whose content is plain text, not a `tool_result` injection. Returns null
 * if not found.
 */
function lastUserPromptMsFromJsonl(jsonl) {
  if (!jsonl) return null
  const lines = jsonl.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"type":"user"')) continue
    try {
      const e = JSON.parse(line)
      if (e.type !== 'user') continue
      const c = e.message?.content
      const isToolResult = Array.isArray(c) && c[0]?.type === 'tool_result'
      if (isToolResult) continue
      if (e.timestamp) return Date.parse(e.timestamp)
    } catch (_) {}
  }
  return null
}

/**
 * Latest assistant text — Claude's final reply for this turn. Skips tool-only
 * entries (an assistant turn often contains multiple chunks; the last one
 * with actual text is what the user sees as "Claude's response").
 */
function lastAssistantTextFromJsonl(jsonl) {
  if (!jsonl) return ''
  const lines = jsonl.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
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
      if (text) return text
    } catch (_) {}
  }
  return ''
}


// ---------- Actions ----------

/**
 * Forward raw turn data to backend. Title/body formatting lives server-side
 * so this script stays a thin event forwarder. The jsonl is parsed locally
 * because only the PC has access to `~/.claude/projects/...`.
 */
async function notifyStop(post, input) {
  const jsonl = readSessionJsonl(input.cwd, input.session_id)
  const cwd = canonicalCwdFromJsonl(jsonl, input.cwd ?? '')
  const startMs = lastUserPromptMsFromJsonl(jsonl)
  await post('/v1/notifications', {
    session_id: input.session_id ?? 'unknown',
    cwd,
    project_name: cwd ? basename(cwd) : 'unknown',
    session_label: aiTitleFromJsonl(jsonl),
    kind: 'completed',
    elapsed_ms: startMs !== null ? Date.now() - startMs : null,
    full_message: lastAssistantTextFromJsonl(jsonl),
  })
}

async function dismissPending(post, input) {
  await post('/v1/approvals/dismiss_pending', { cwd: input.cwd ?? '' })
}

// ---------- Main ----------

const mode = process.argv[2]
const env = loadEnv()
if (!env || !env.CC_REMOTE_BACKEND_URL || !env.CC_REMOTE_SHARED_SECRET) {
  process.exit(1)
}
const post = makeClient(env)
const input = await readStdin()

function shouldNotifyStop(input, env) {
  // Skip the completion push for short turns. Threshold defaults to 3 min,
  // overridable via CC_REMOTE_STOP_THRESHOLD_MS in the env file. If the start
  // time can't be determined, notify to avoid silently dropping signals.
  const jsonl = readSessionJsonl(input.cwd, input.session_id)
  const startMs = lastUserPromptMsFromJsonl(jsonl)
  if (startMs === null) return true
  const thresholdMs = Number.parseInt(env.CC_REMOTE_STOP_THRESHOLD_MS ?? '180000', 10)
  return Date.now() - startMs >= thresholdMs
}

switch (mode) {
  case 'stop':
    await dismissPending(post, input)
    if (shouldNotifyStop(input, env)) {
      await notifyStop(post, input)
    }
    break
  case 'posttool':
    await dismissPending(post, input)
    break
  default:
    log(`unknown mode '${mode}' (expected: stop | posttool)`)
    process.exit(1)
}
