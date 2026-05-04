#!/usr/bin/env node
// claude-code-remote: Claude Code hook script.
// Routes hook events through the Workers backend to remote control.
// Modes: pretool | stop | notify

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

const ENV_PATH = process.env.CC_REMOTE_ENV ?? join(homedir(), '.claude/hooks/.env')
const POLL_INTERVAL_MS = 1000
const POLL_TIMEOUT_MS = 5 * 60 * 1000

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

function fallbackAsk(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: `[cc-remote] ${reason}`,
    },
  }))
}

function projectName(cwd) {
  return cwd ? basename(cwd) : 'unknown'
}

async function pretool(input, env) {
  const headers = {
    'Authorization': `Bearer ${env.CC_REMOTE_SHARED_SECRET}`,
    'Content-Type': 'application/json',
  }
  const backend = env.CC_REMOTE_BACKEND_URL.replace(/\/$/, '')

  let id
  try {
    const res = await fetch(`${backend}/v1/approvals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session_id: input.session_id ?? 'unknown',
        cwd: input.cwd ?? '',
        project_name: projectName(input.cwd),
        tool_name: input.tool_name ?? 'unknown',
        tool_input: input.tool_input ?? {},
      }),
    })
    if (!res.ok) {
      fallbackAsk(`backend POST failed: HTTP ${res.status}`)
      return
    }
    const data = await res.json()
    id = data.id
  } catch (e) {
    fallbackAsk(`backend POST error: ${e.message}`)
    return
  }

  const startedAt = Date.now()
  while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    try {
      const r = await fetch(`${backend}/v1/approvals/${id}`, { headers })
      if (!r.ok) continue
      const data = await r.json()
      if (data.status === 'allow' || data.status === 'deny') {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: data.status,
            permissionDecisionReason: data.reason ?? `Decided remotely (${data.status})`,
          },
        }))
        return
      }
    } catch (_) {
      // network blip, keep polling
    }
  }
  fallbackAsk('スマホで応答がなかったため通常確認に戻します')
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
  const message = input.message ?? (mode === 'stop' ? 'completed' : 'waiting for input')
  try {
    await fetch(`${backend}/v1/notifications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session_id: input.session_id ?? 'unknown',
        cwd: input.cwd ?? '',
        project_name: project,
        kind,
        title: `${titlePrefix} ${project}`,
        body: typeof message === 'string' ? message.slice(0, 500) : '',
      }),
    })
  } catch (e) {
    process.stderr.write(`cc-remote-hook (${mode}): ${e.message}\n`)
  }
}

const mode = process.argv[2]
const env = loadEnv()

if (!env || !env.CC_REMOTE_BACKEND_URL || !env.CC_REMOTE_SHARED_SECRET) {
  if (mode === 'pretool') {
    fallbackAsk('config missing')
    process.exit(0)
  }
  process.exit(1)
}

const input = await readStdin()

switch (mode) {
  case 'pretool':
    await pretool(input, env)
    break
  case 'stop':
    await notify(input, env, 'stop')
    break
  case 'notify':
    await notify(input, env, 'notify')
    break
  default:
    process.stderr.write(`cc-remote-hook: unknown mode '${mode}' (expected: pretool | stop | notify)\n`)
    process.exit(1)
}
