#!/usr/bin/env node
// claude-code-remote: Claude Code Stop / Notification hook.
// Sends one-shot pushes to phone when Claude finishes a turn (stop) or when
// CC waits for user input (notify, e.g. idle_prompt). Permission approvals
// are NOT handled here — they go through the MCP channel server (see
// channel/channel.mjs and Channels permission relay).
// Modes: stop | notify

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

const CLAUDE_HOME = join(homedir(), '.claude')

function encodeCwdForProject(cwd) {
  return cwd.replace(/[\/.]/g, '-')
}

function getAiTitle(cwd, sessionId) {
  if (!cwd || !sessionId) return ''
  try {
    const projDir = encodeCwdForProject(cwd)
    const jsonl = readFileSync(join(CLAUDE_HOME, 'projects', projDir, `${sessionId}.jsonl`), 'utf8')
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

const ENV_PATH = process.env.CC_REMOTE_ENV ?? join(homedir(), '.claude/hooks/.env')

function loadEnv() {
  let text
  try {
    text = readFileSync(ENV_PATH, 'utf8')
  } catch (e) {
    process.stderr.write(`cc-remote-hook: cannot read ${ENV_PATH}: ${e.message}\n`)
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
    process.stderr.write(`cc-remote-hook: invalid stdin JSON: ${e.message}\n`)
    return {}
  }
}

function projectName(cwd) {
  return cwd ? basename(cwd) : 'unknown'
}

async function notify(input, env, mode) {
  const headers = {
    'Authorization': `Bearer ${env.CC_REMOTE_SHARED_SECRET}`,
    'Content-Type': 'application/json',
  }
  const backend = env.CC_REMOTE_BACKEND_URL.replace(/\/$/, '')
  const project = projectName(input.cwd)
  const titlePrefix = mode === 'stop' ? '✅' : '⚠️'
  const kind = mode === 'stop' ? 'completed' : 'waiting'
  const aiTitle = getAiTitle(input.cwd, input.session_id)
  const label = aiTitle || project
  try {
    await fetch(`${backend}/v1/notifications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session_id: input.session_id ?? 'unknown',
        cwd: input.cwd ?? '',
        project_name: project,
        session_label: aiTitle,
        kind,
        title: `${titlePrefix} ${label}`,
        body: '',
      }),
    })
  } catch (e) {
    process.stderr.write(`cc-remote-hook (${mode}): ${e.message}\n`)
  }
}

async function dismissPending(input, env) {
  const headers = {
    'Authorization': `Bearer ${env.CC_REMOTE_SHARED_SECRET}`,
    'Content-Type': 'application/json',
  }
  const backend = env.CC_REMOTE_BACKEND_URL.replace(/\/$/, '')
  try {
    await fetch(`${backend}/v1/approvals/dismiss_pending`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ cwd: input.cwd ?? '' }),
    })
  } catch (_) {
    // best-effort, silent
  }
}

const mode = process.argv[2]
const env = loadEnv()

if (!env || !env.CC_REMOTE_BACKEND_URL || !env.CC_REMOTE_SHARED_SECRET) {
  process.exit(1)
}

const input = await readStdin()

switch (mode) {
  case 'stop':
    await dismissPending(input, env)
    await notify(input, env, 'stop')
    break
  case 'notify':
    await notify(input, env, 'notify')
    break
  case 'posttool':
    await dismissPending(input, env)
    break
  default:
    process.stderr.write(`cc-remote-hook: unknown mode '${mode}' (expected: stop | notify | posttool)\n`)
    process.exit(1)
}
