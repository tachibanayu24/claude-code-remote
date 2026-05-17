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
 * Channel-injected prompts (phone → channel.mjs → CC) come in two shapes
 * depending on CC's busy state when the notification arrives:
 *
 *   (a) IDLE — CC writes a normal `type:"user"` entry with `origin.kind:
 *       "channel"` and the channel-wrapper text in `message.content`.
 *   (b) BUSY — CC stashes it as `type:"attachment"`,
 *       `attachment.type:"queued_command"`, `attachment.origin.kind:
 *       "channel"`, and the channel-wrapper text in `attachment.prompt`.
 *       The attachment is consumed in jsonl-order: by the time it appears,
 *       CC's about to (or already has) treated it as the next user input.
 *
 * Both shapes are real user input. The parsers below normalize over them.
 */
function isChannelInjectedPrompt(e) {
  return e.origin?.kind === 'channel'
}

function isChannelQueuedCommand(e) {
  return (
    e.type === 'attachment' &&
    e.attachment?.type === 'queued_command' &&
    e.attachment?.origin?.kind === 'channel'
  )
}

function isSyntheticUserEntry(e) {
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

function unwrapChannel(text) {
  const m = text.match(CHANNEL_WRAPPER_RE)
  return m ? m[1].trim() : text.trim()
}

function userEntryText(e) {
  if (isChannelQueuedCommand(e)) {
    return unwrapChannel(String(e.attachment?.prompt ?? ''))
  }
  const c = e.message?.content
  const raw = typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n')
      : ''
  if (isChannelInjectedPrompt(e)) return unwrapChannel(raw)
  return raw.trim()
}

/**
 * Most recent external user prompt — what the human typed at the prompt
 * (terminal or phone). Skips tool_result injections, compact-summary
 * re-injections, slash-command echoes, bash-mode IO, and other synthetic
 * `user` entries CC writes for its own bookkeeping. Both channel-injected
 * shapes (idle → `type:"user"`, busy → `type:"attachment"` queued_command)
 * are kept and unwrapped. Returns `{ text, ms, lineIndex }` or null if
 * none. ms is the parsed timestamp (or null), lineIndex lets callers walk
 * forward.
 */
export function lastUserPromptFromJsonl(jsonl) {
  if (!jsonl) return null
  const lines = jsonl.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    // Cheap pre-filter — full JSON parse only on candidate lines.
    const looksUser = line.includes('"type":"user"')
    const looksQueuedAttachment = line.includes('"type":"attachment"') &&
      line.includes('"queued_command"') &&
      line.includes('"channel"')
    if (!looksUser && !looksQueuedAttachment) continue
    try {
      const e = JSON.parse(line)
      if (e.type === 'user') {
        if (isSyntheticUserEntry(e)) continue
        const ms = e.timestamp ? Date.parse(e.timestamp) : null
        return { text: userEntryText(e), ms, lineIndex: i }
      }
      if (isChannelQueuedCommand(e)) {
        // For attachment timestamps, prefer the consumption time over the
        // enqueue time. Heuristic: walk forward to the first assistant
        // entry — its timestamp is when CC actually started responding.
        // Falls back to the attachment timestamp if no assistant follows
        // yet (in-flight from a phone perspective).
        const ms = consumeMsFromJsonl(lines, i) ??
          (e.timestamp ? Date.parse(e.timestamp) : null)
        return { text: userEntryText(e), ms, lineIndex: i }
      }
    } catch (_) {}
  }
  return null
}

function consumeMsFromJsonl(lines, fromLineIndex) {
  for (let i = fromLineIndex + 1; i < lines.length; i++) {
    if (!lines[i].includes('"type":"assistant"')) continue
    try {
      const e = JSON.parse(lines[i])
      if (e.type === 'assistant' && e.timestamp) return Date.parse(e.timestamp)
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
 * Find the most recent assistant `tool_use` block that has NOT yet been
 * paired with a `tool_result`, matching `toolName` and (if parsable)
 * `inputPreview`. This is the canonical signal channel.mjs uses to bind a
 * permission_request to a specific tool_use_id — the same id later carries
 * the tool_result, which doubles as the "CC moved past this prompt" signal.
 *
 * Match priority: exact-input match > latest pending name match. Returns
 * `{ id, lineIndex }` or null.
 */
export function findPendingToolUseInJsonl(jsonl, toolName, inputPreview) {
  if (!jsonl || !toolName) return null
  let targetInput = null
  try { if (inputPreview) targetInput = JSON.parse(inputPreview) } catch (_) {}
  const lines = jsonl.split('\n')
  const resulted = new Set()
  const toolUses = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes('"type":"tool_result"')) {
      try {
        const e = JSON.parse(line)
        if (e.type === 'user') {
          const c = e.message?.content
          if (Array.isArray(c)) {
            for (const b of c) {
              if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
                resulted.add(b.tool_use_id)
              }
            }
          }
        }
      } catch (_) {}
    }
    if (line.includes('"type":"tool_use"')) {
      try {
        const e = JSON.parse(line)
        if (e.type !== 'assistant') continue
        const c = e.message?.content
        if (!Array.isArray(c)) continue
        for (const b of c) {
          if (b?.type === 'tool_use' && typeof b.id === 'string' && b.name === toolName) {
            toolUses.push({ id: b.id, input: b.input ?? {}, lineIndex: i })
          }
        }
      } catch (_) {}
    }
  }
  const pending = toolUses.filter((t) => !resulted.has(t.id))
  if (pending.length === 0) return null
  if (targetInput !== null) {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (deepEqualJson(pending[i].input, targetInput)) {
        return { id: pending[i].id, lineIndex: pending[i].lineIndex }
      }
    }
  }
  const last = pending[pending.length - 1]
  return { id: last.id, lineIndex: last.lineIndex }
}

/**
 * True if a `tool_result` entry exists for `toolUseId`. Channel.mjs treats
 * this as "CC has moved past the matching permission prompt" — either the
 * tool ran to completion (allow) or CC wrote an error result (deny).
 */
export function hasToolResultFor(jsonl, toolUseId) {
  if (!jsonl || !toolUseId) return false
  if (!jsonl.includes(toolUseId)) return false
  const lines = jsonl.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('"type":"tool_result"')) continue
    if (!line.includes(toolUseId)) continue
    try {
      const e = JSON.parse(line)
      if (e.type !== 'user') continue
      const c = e.message?.content
      if (!Array.isArray(c)) continue
      for (const b of c) {
        if (b?.type === 'tool_result' && b.tool_use_id === toolUseId) return true
      }
    } catch (_) {}
  }
  return false
}

/**
 * Count assistant `tool_use` blocks for AskUserQuestion and how many of them
 * already have a paired `tool_result`. channel.mjs uses this to detect when
 * CC has answered a question locally (CLI early-resolve) without needing to
 * bind to a specific tool_use_id — a delta in `resolved` between wait rounds
 * means "one more pending question can be dismissed from the phone".
 */
export function countAskUserQuestionStatus(jsonl) {
  if (!jsonl) return { resolved: 0, pending: 0, total: 0 }
  const lines = jsonl.split('\n')
  const resulted = new Set()
  const toolUseIds = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes('"type":"tool_result"')) {
      try {
        const e = JSON.parse(line)
        if (e.type === 'user') {
          const c = e.message?.content
          if (Array.isArray(c)) {
            for (const b of c) {
              if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
                resulted.add(b.tool_use_id)
              }
            }
          }
        }
      } catch (_) {}
    }
    if (line.includes('"type":"tool_use"')) {
      try {
        const e = JSON.parse(line)
        if (e.type !== 'assistant') continue
        const c = e.message?.content
        if (!Array.isArray(c)) continue
        for (const b of c) {
          if (b?.type === 'tool_use' && typeof b.id === 'string' && b.name === 'AskUserQuestion') {
            toolUseIds.push(b.id)
          }
        }
      } catch (_) {}
    }
  }
  let resolved = 0
  for (const id of toolUseIds) if (resulted.has(id)) resolved++
  return { resolved, pending: toolUseIds.length - resolved, total: toolUseIds.length }
}

function deepEqualJson(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqualJson(a[i], b[i])) return false
    return true
  }
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!deepEqualJson(a[k], b[k])) return false
  return true
}

/**
 * Walk every assistant entry after `fromLineIndex` and return its content
 * blocks in order: `[{kind:'text', text}, {kind:'tool_use', name, input}]`.
 * Other block types (`thinking`, `image`, ...) are filtered out — only
 * narration and tool calls are surfaced. Pass `-1` to scan the entire jsonl.
 * Stop hook と channel heartbeat の双方で使い、phone は受け取った順序で描画する。
 */
export function assistantBlocksAfterFromJsonl(jsonl, fromLineIndex = -1) {
  if (!jsonl) return []
  const lines = jsonl.split('\n')
  const blocks = []
  for (let i = Math.max(0, fromLineIndex + 1); i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('"type":"assistant"')) continue
    try {
      const e = JSON.parse(line)
      if (e.type !== 'assistant') continue
      const c = e.message?.content
      if (!Array.isArray(c)) continue
      for (const b of c) {
        if (!b || typeof b !== 'object') continue
        if (b.type === 'text' && typeof b.text === 'string') {
          const text = b.text.trim()
          if (text) blocks.push({ kind: 'text', text })
        } else if (b.type === 'tool_use' && typeof b.name === 'string') {
          blocks.push({ kind: 'tool_use', name: b.name, input: b.input ?? {} })
        }
      }
    } catch (_) {}
  }
  return blocks
}
