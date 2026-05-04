#!/usr/bin/env node
// claude-code-remote: Claude Code Stop / Notification / PostToolUse hook.
// Sends one-shot pushes to phone when Claude finishes a turn (stop) or when
// CC waits for user input (notify, e.g. idle_prompt). Permission approvals
// are NOT handled here — they go through the MCP channel server (see
// channel/channel.mjs and Channels permission relay). PostToolUse fires after
// each tool execution to clean up any pending phone notifications when the
// user answered locally in the CLI.
//
// Modes: stop | notify | posttool

import { readFileSync } from 'node:fs'
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

function readSessionJsonl(cwd, sessionId) {
  if (!cwd || !sessionId) return null
  try {
    return readFileSync(
      join(CLAUDE_HOME, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`),
      'utf8'
    )
  } catch (_) {
    return null
  }
}

function getAiTitle(cwd, sessionId) {
  const jsonl = readSessionJsonl(cwd, sessionId)
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
 * Find the timestamp (ms) of the most recent external user prompt — i.e. a
 * `user` entry whose content is plain text, not a `tool_result` injection.
 * Returns null if not found.
 */
function getLastUserPromptMs(cwd, sessionId) {
  const jsonl = readSessionJsonl(cwd, sessionId)
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

// ---------- Actions ----------

async function notify(post, input, mode) {
  const project = input.cwd ? basename(input.cwd) : 'unknown'
  const aiTitle = getAiTitle(input.cwd, input.session_id)
  const titlePrefix = mode === 'stop' ? '✅' : '⚠️'
  const kind = mode === 'stop' ? 'completed' : 'waiting'
  await post('/v1/notifications', {
    session_id: input.session_id ?? 'unknown',
    cwd: input.cwd ?? '',
    project_name: project,
    session_label: aiTitle,
    kind,
    title: `${titlePrefix} ${aiTitle || project}`,
    body: '',
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
  const startMs = getLastUserPromptMs(input.cwd, input.session_id)
  if (startMs === null) return true
  const thresholdMs = Number.parseInt(env.CC_REMOTE_STOP_THRESHOLD_MS ?? '180000', 10)
  return Date.now() - startMs >= thresholdMs
}

switch (mode) {
  case 'stop':
    await dismissPending(post, input)
    if (shouldNotifyStop(input, env)) {
      await notify(post, input, 'stop')
    }
    break
  case 'notify':
    await notify(post, input, 'notify')
    break
  case 'posttool':
    await dismissPending(post, input)
    break
  default:
    log(`unknown mode '${mode}' (expected: stop | notify | posttool)`)
    process.exit(1)
}
