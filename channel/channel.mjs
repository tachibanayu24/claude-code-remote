#!/usr/bin/env node
// claude-code-remote channel server.
// Receives Claude Code permission_request notifications, forwards them to the
// Cloudflare Workers backend (which fans out FCM pushes to registered Android
// devices), polls for the verdict, and emits permission notifications back to
// Claude Code. The local terminal dialog stays open in parallel; whichever
// side answers first wins (Channels protocol applies the first verdict and
// drops the rest).

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'

const CLAUDE_HOME = join(homedir(), '.claude')

function encodeCwdForProject(cwd) {
  return cwd.replace(/[\/.]/g, '-')
}

let labelCache = { value: '', ts: 0 }
function getSessionLabel() {
  const now = Date.now()
  if (now - labelCache.ts < 5000) return labelCache.value
  let label = ''
  try {
    const sess = JSON.parse(readFileSync(join(CLAUDE_HOME, 'sessions', `${process.ppid}.json`), 'utf8'))
    if (sess.sessionId && sess.cwd) {
      const projDir = encodeCwdForProject(sess.cwd)
      const jsonl = readFileSync(join(CLAUDE_HOME, 'projects', projDir, `${sess.sessionId}.jsonl`), 'utf8')
      const lines = jsonl.split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]
        if (!line.includes('"ai-title"')) continue
        try {
          const parsed = JSON.parse(line)
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
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const ENV_PATH = process.env.CC_REMOTE_ENV ?? join(homedir(), '.claude/hooks/.env')
const POLL_INTERVAL_MS = 1000
const POLL_TIMEOUT_MS = 5 * 60 * 1000

function log(...args) {
  process.stderr.write(`[cc-remote] ${args.join(' ')}\n`)
}

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

const env = loadEnv()
if (!env || !env.CC_REMOTE_BACKEND_URL || !env.CC_REMOTE_SHARED_SECRET) {
  log('config missing — channel will register with CC but no relay will happen')
}

const BACKEND = env?.CC_REMOTE_BACKEND_URL?.replace(/\/$/, '') ?? ''
const SECRET = env?.CC_REMOTE_SHARED_SECRET ?? ''
const PROJECT = basename(process.cwd())

const headers = {
  'Authorization': `Bearer ${SECRET}`,
  'Content-Type': 'application/json',
}

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

// Track in-flight requests so duplicates / cancellations can be handled cleanly.
const inflight = new Map() // ccRequestId -> AbortController

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const { request_id, tool_name, description, input_preview } = params

  if (!BACKEND || !SECRET) {
    log(`permission_request ${request_id} dropped (config missing)`)
    return
  }

  let backendId
  try {
    const res = await fetch(`${BACKEND}/v1/approvals`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        session_id: 'channel',
        cwd: process.cwd(),
        project_name: PROJECT,
        session_label: getSessionLabel(),
        tool_name,
        description,
        input_preview,
        cc_request_id: request_id,
      }),
    })
    if (!res.ok) {
      log(`backend POST failed ${request_id}: HTTP ${res.status}`)
      return
    }
    const data = await res.json()
    backendId = data.id
  } catch (e) {
    log(`backend POST error ${request_id}: ${e.message ?? e}`)
    return
  }

  const ac = new AbortController()
  inflight.set(request_id, ac)

  pollAndEmit(backendId, request_id, ac.signal)
    .catch((e) => log(`poll error ${request_id}: ${e.message ?? e}`))
    .finally(() => {
      inflight.delete(request_id)
    })
})

async function pollAndEmit(backendId, ccRequestId, signal) {
  const start = Date.now()
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    if (signal.aborted) return
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    if (signal.aborted) return
    let data
    try {
      const r = await fetch(`${BACKEND}/v1/approvals/${backendId}`, { headers, signal })
      if (!r.ok) continue
      data = await r.json()
    } catch (_) {
      continue
    }
    if (!data || data.status === 'pending') continue
    if (data.status === 'allow' || data.status === 'deny') {
      try {
        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: {
            request_id: ccRequestId,
            behavior: data.status,
          },
        })
        log(`emitted verdict ${ccRequestId}=${data.status}`)
      } catch (e) {
        log(`emit failed ${ccRequestId}: ${e.message ?? e}`)
      }
    } else {
      // expired/cancelled — local terminal answered first, no verdict to emit
      log(`stopped polling ${ccRequestId} (status=${data.status})`)
    }
    return
  }
  log(`timeout ${ccRequestId} — local dialog will handle`)
}

await mcp.connect(new StdioServerTransport())
log(`connected (backend=${BACKEND ? 'configured' : 'missing'})`)
