#!/usr/bin/env node
// claude-code-remote: Claude Code Stop / PostToolUse hook.
// Thin event forwarder. PC-only logic (jsonl reading) lives here; everything
// else — threshold check, title/body formatting, FCM push, dismiss — runs on
// the backend.
//
// Modes: stop | posttool

import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_HOME = join(homedir(), '.claude')
const ENV_PATH = process.env.CC_REMOTE_ENV ?? join(CLAUDE_HOME, 'hooks/.env')

const log = (msg) => process.stderr.write(`cc-remote-hook: ${msg}\n`)

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

// ---------- jsonl extraction (PC-only — backend can't see ~/.claude) ----------

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

// ---------- Main ----------

const mode = process.argv[2]
const env = loadEnv()
if (!env || !env.CC_REMOTE_BACKEND_URL || !env.CC_REMOTE_SHARED_SECRET) {
  process.exit(1)
}
const backend = env.CC_REMOTE_BACKEND_URL.replace(/\/$/, '')
const input = await readStdin()

async function post(path, payload) {
  try {
    await fetch(`${backend}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CC_REMOTE_SHARED_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
  } catch (_) {
    // best-effort, silent
  }
}

switch (mode) {
  case 'stop': {
    const jsonl = readSessionJsonl(input.cwd, input.session_id)
    const cwd = canonicalCwdFromJsonl(jsonl, input.cwd ?? '')
    const startMs = lastUserPromptMsFromJsonl(jsonl)
    await post('/v1/hook/stop', {
      session_id: input.session_id ?? '',
      cwd,
      ai_title: aiTitleFromJsonl(jsonl),
      elapsed_ms: startMs !== null ? Date.now() - startMs : null,
      full_message: lastAssistantTextFromJsonl(jsonl),
    })
    break
  }
  case 'posttool':
    await post('/v1/hook/posttool', { cwd: input.cwd ?? '' })
    break
  default:
    log(`unknown mode '${mode}' (expected: stop | posttool)`)
    process.exit(1)
}
