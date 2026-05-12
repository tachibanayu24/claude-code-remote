// Lookups for the parent Claude Code session. CC writes
// `~/.claude/sessions/<ppid>.json` at startup with {sessionId, cwd}, which is
// the entry point for everything downstream (jsonl read, heartbeat snapshot,
// ai-title caching). All file I/O is sync — we're always called from the
// MCP / wait-loop hot path where event-loop yielding for fs is overkill.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_HOME } from '../../hooks/lib/env.mjs'
import {
  aiTitleFromJsonl,
  assistantBlocksAfterFromJsonl,
  hasEndTurnAfter,
  jsonlPath,
  lastUserPromptFromJsonl,
} from '../../hooks/lib/jsonl.mjs'

const SESSION_LABEL_TTL_MS = 5_000

/**
 * Resolve our parent CC's sessionId via `~/.claude/sessions/<ppid>.json`.
 * Returns null if the file doesn't exist or can't be parsed (e.g. CC is too
 * old to write it).
 */
export function readPpidSession() {
  try {
    const sess = JSON.parse(
      readFileSync(join(CLAUDE_HOME, 'sessions', `${process.ppid}.json`), 'utf8'),
    )
    if (sess.sessionId && sess.cwd) return sess
  } catch (_) {}
  return null
}

const labelCache = { value: '', ts: 0 }

/**
 * AI-generated title for the parent session, cached with a short TTL so we
 * don't re-read the jsonl on every permission_request. Empty string when
 * unavailable.
 */
export function getSessionLabel() {
  const now = Date.now()
  if (now - labelCache.ts < SESSION_LABEL_TTL_MS) return labelCache.value
  const sess = readPpidSession()
  let label = ''
  if (sess) {
    try { label = aiTitleFromJsonl(readFileSync(jsonlPath(sess.cwd, sess.sessionId), 'utf8')) }
    catch (_) {}
  }
  labelCache.value = label
  labelCache.ts = now
  return label
}

/**
 * Snapshot of session state for the heartbeat upsert in /v1/wait.
 * current_prompt + current_blocks are populated only while a turn is in
 * flight (latest user prompt has no end_turn after it); backend nulls them
 * out on the Stop hook, so we don't race against it here.
 */
export function inspectSession() {
  const sess = readPpidSession()
  const cwd = sess?.cwd ?? process.cwd()
  const sessionId = sess?.sessionId ?? null
  let jsonl_mtime = null
  let ai_title = ''
  let current_prompt = null
  let current_blocks = null
  if (sessionId) {
    const path = jsonlPath(cwd, sessionId)
    try { jsonl_mtime = statSync(path).mtimeMs } catch (_) {}
    try {
      const jsonl = readFileSync(path, 'utf8')
      ai_title = aiTitleFromJsonl(jsonl)
      const lastPrompt = lastUserPromptFromJsonl(jsonl)
      if (lastPrompt && !hasEndTurnAfter(jsonl, lastPrompt.lineIndex)) {
        current_prompt = lastPrompt.text || null
        const partial = assistantBlocksAfterFromJsonl(jsonl, lastPrompt.lineIndex)
        current_blocks = partial.length > 0 ? partial : null
      }
    } catch (_) {}
  }
  return { cwd, session_id: sessionId, ai_title, jsonl_mtime, current_prompt, current_blocks }
}
