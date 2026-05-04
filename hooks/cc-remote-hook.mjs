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

function getAiTitle(cwd, sessionId) {
  if (!cwd || !sessionId) return ''
  try {
    const jsonl = readFileSync(
      join(CLAUDE_HOME, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`),
      'utf8'
    )
    const lines = jsonl.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"ai-title"')) continue
      try {
        const parsed = JSON.parse(lines[i])
        if (parsed.type === 'ai-title' && parsed.aiTitle) return parsed.aiTitle
      } catch (_) {}
    }
  } catch (_) {}
  return ''
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

switch (mode) {
  case 'stop':
    await dismissPending(post, input)
    await notify(post, input, 'stop')
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
