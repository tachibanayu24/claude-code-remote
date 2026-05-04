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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const CLAUDE_HOME = join(homedir(), '.claude')
const ENV_PATH = process.env.CC_REMOTE_ENV ?? join(CLAUDE_HOME, 'hooks/.env')
const POLL_INTERVAL_MS = 1000
const POLL_TIMEOUT_MS = 5 * 60 * 1000
const SESSION_LABEL_TTL_MS = 5_000

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

// ---------- Session label (CC's ai-title) ----------

const encodeCwd = (cwd) => cwd.replace(/[\/.]/g, '-')

let labelCache = { value: '', ts: 0 }

function getSessionLabel() {
  const now = Date.now()
  if (now - labelCache.ts < SESSION_LABEL_TTL_MS) return labelCache.value
  let label = ''
  try {
    const sess = JSON.parse(
      readFileSync(join(CLAUDE_HOME, 'sessions', `${process.ppid}.json`), 'utf8')
    )
    if (sess.sessionId && sess.cwd) {
      const jsonl = readFileSync(
        join(CLAUDE_HOME, 'projects', encodeCwd(sess.cwd), `${sess.sessionId}.jsonl`),
        'utf8'
      )
      const lines = jsonl.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"ai-title"')) continue
        try {
          const parsed = JSON.parse(lines[i])
          if (parsed.type === 'ai-title' && parsed.aiTitle) {
            label = parsed.aiTitle
            break
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  labelCache = { value: label, ts: now }
  return label
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
  if ((toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') &&
      typeof parsed.file_path === 'string') {
    return `${toolName}(${parsed.file_path})`
  }
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
  if (!json.permissions.allow.includes(pattern)) {
    json.permissions.allow.push(pattern)
  } else {
    return false
  }
  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(json, null, 2) + '\n')
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
      cc_request_id: request_id,
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

await mcp.connect(new StdioServerTransport())
log(`connected (backend=${BACKEND ? 'configured' : 'missing'})`)
