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
 * Most recent external user prompt — what the human typed at the prompt
 * (terminal or phone). Skips tool_result injections, compact-summary
 * re-injections, slash-command echoes, bash-mode IO, and other synthetic
 * `user` entries CC writes for its own bookkeeping. Channel-injected
 * prompts are kept and unwrapped. Returns `{ text, ms, lineIndex }` or
 * null if none found. lineIndex is exposed so callers can walk forward.
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
      const ms = e.timestamp ? Date.parse(e.timestamp) : null
      return { text: userEntryText(e), ms, lineIndex: i }
    } catch (_) {}
  }
  return null
}

function lastUserPromptMsFromJsonl(jsonl) {
  return lastUserPromptFromJsonl(jsonl)?.ms ?? null
}

/**
 * True if any assistant entry after the given line index carries
 * `stop_reason: "end_turn"`, signalling CC has written the final chunk of
 * the turn. Used to know when it's safe to snapshot the transcript.
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
 * Tally `tool_use` blocks emitted by the assistant after the given jsonl line
 * index. Returns an array of `{name, count}` sorted by count desc — used as
 * the turn's tool summary in the detail view.
 */
function toolUsageAfterFromJsonl(jsonl, fromLineIndex) {
  if (!jsonl) return []
  const counts = new Map()
  const lines = jsonl.split('\n')
  for (let i = fromLineIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('"type":"tool_use"')) continue
    try {
      const e = JSON.parse(line)
      if (e.type !== 'assistant') continue
      const c = e.message?.content
      if (!Array.isArray(c)) continue
      for (const b of c) {
        if (b?.type === 'tool_use' && typeof b.name === 'string') {
          counts.set(b.name, (counts.get(b.name) ?? 0) + 1)
        }
      }
    } catch (_) {}
  }
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
}

/**
 * Concatenate every assistant text block emitted *after* the given jsonl
 * line index, in the order CC wrote them. Tool-only entries are skipped;
 * pure-text entries contribute their joined text. The result mirrors what
 * CC shows in its terminal — "all of Claude's narration for this turn".
 *
 * `fromLineIndex` is typically the line index of the last user prompt. Pass
 * `-1` to scan the entire jsonl (legacy behaviour).
 */
function assistantTextsAfterFromJsonl(jsonl, fromLineIndex = -1) {
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
  // Prefix each chunk with `● ` and join with blank lines, mirroring how
  // CC renders interleaved text blocks in the terminal. We use U+25CF
  // (BLACK CIRCLE) instead of CC's U+23FA (BLACK CIRCLE FOR RECORD)
  // because the latter has emoji presentation on Android (Noto Color
  // Emoji renders it as a record button), while U+25CF stays as a plain
  // text glyph everywhere.
  return chunks.map((t) => `● ${t}`).join('\n\n')
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
    // CC fires Stop the moment its agent loop exits, but the *last* assistant
    // message — the one with `stop_reason: end_turn` — may still be in
    // CC's write buffer. Reading immediately gives a transcript that's
    // missing the final narration. Poll the jsonl until either an
    // `end_turn` entry shows up after our user prompt or we've waited the
    // budget, then snapshot. This keeps Stop hooks fast in the common case
    // (jsonl already flushed) and at most 1.5s slow in the worst case.
    const cwdInput = input.cwd ?? ''
    const sid = input.session_id
    const start = Date.now()
    const BUDGET_MS = 1500
    const POLL_MS = 100
    let jsonl = readSessionJsonl(cwdInput, sid)
    while (Date.now() - start < BUDGET_MS) {
      const lastPrompt = lastUserPromptFromJsonl(jsonl)
      if (lastPrompt && hasEndTurnAfter(jsonl, lastPrompt.lineIndex)) break
      await new Promise((r) => setTimeout(r, POLL_MS))
      jsonl = readSessionJsonl(cwdInput, sid)
    }
    const cwd = canonicalCwdFromJsonl(jsonl, cwdInput)
    const lastPrompt = lastUserPromptFromJsonl(jsonl)
    const fullMessage = assistantTextsAfterFromJsonl(jsonl, lastPrompt?.lineIndex ?? -1)
    await post('/v1/hook/stop', {
      session_id: sid ?? '',
      cwd,
      ai_title: aiTitleFromJsonl(jsonl),
      elapsed_ms: lastPrompt?.ms != null ? Date.now() - lastPrompt.ms : null,
      full_message: fullMessage,
      user_prompt: lastPrompt?.text ?? '',
      tool_summary: lastPrompt ? toolUsageAfterFromJsonl(jsonl, lastPrompt.lineIndex) : [],
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
