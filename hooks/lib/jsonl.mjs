// Shared jsonl parsers for `channel.mjs` and the Stop/PostToolUse hook.
// All functions accept the raw jsonl string (or null) and return primitives
// — no I/O. The exception is `readSessionJsonl`, which is the entry point
// hooks use; it's kept here so the read-path is consistent across callers.

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_HOME } from './env.mjs'
import { encodeCwd } from './cwd.mjs'

/**
 * Read CC's per-session jsonl. Prefers the `transcript_path` that recent
 * Claude Code hooks include in their stdin payload (absolute, exact). Falls
 * back to the encoded cwd path under `~/.claude/projects/`, then to a scan
 * of every project dir for a matching `<sid>.jsonl` (covers the case where
 * the hook's `cwd` is a subdir because the agent ran `cd` inside Bash).
 */
export function readSessionJsonl({ transcriptPath, cwd, sessionId } = {}) {
  if (transcriptPath) {
    try { return readFileSync(transcriptPath, 'utf8') } catch (_) {}
  }
  if (!sessionId) return null
  if (cwd) {
    try {
      return readFileSync(
        join(CLAUDE_HOME, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`),
        'utf8',
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

export function jsonlPath(cwd, sessionId) {
  return join(CLAUDE_HOME, 'projects', encodeCwd(cwd), `${sessionId}.jsonl`)
}

export function aiTitleFromJsonl(jsonl) {
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

export function canonicalCwdFromJsonl(jsonl, fallback) {
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
export function isChannelInjectedPrompt(e) {
  return e.origin?.kind === 'channel'
}

export function isSyntheticUserEntry(e) {
  if (isChannelInjectedPrompt(e)) return false
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

export function userEntryText(e) {
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
 * null if none. ms is the parsed timestamp (or null), lineIndex lets
 * callers walk forward.
 */
export function lastUserPromptFromJsonl(jsonl) {
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

/**
 * True if any assistant entry after `fromLineIndex` carries
 * `stop_reason: "end_turn"` — i.e. CC has finished narrating this turn.
 */
export function hasEndTurnAfter(jsonl, fromLineIndex) {
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
 * Tally `tool_use` blocks emitted by the assistant after `fromLineIndex`.
 * Returns `[{name, count}]` sorted by count desc.
 */
export function toolUsageAfterFromJsonl(jsonl, fromLineIndex) {
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
 * Concatenate every assistant text block emitted after `fromLineIndex`,
 * prefixed with `● ` and joined with blank lines — mirrors how CC renders
 * interleaved chunks in the terminal. Used both for snapshotting a
 * completed turn (Stop hook) and surfacing live narration to the phone
 * (channel heartbeat). Pass `-1` to scan the entire jsonl.
 *
 * U+25CF (BLACK CIRCLE) instead of CC's U+23FA: the latter has emoji
 * presentation on Android and would render as a record button glyph.
 */
export function assistantTextsAfterFromJsonl(jsonl, fromLineIndex = -1) {
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
