#!/usr/bin/env node
// claude-code-remote: Claude Code Stop / PostToolUse hook.
// Thin event forwarder. PC-only logic (jsonl reading) lives in
// `./lib/jsonl.mjs`; the threshold check, title/body formatting, FCM push,
// and dismiss all run on the backend.
//
// Modes: stop | posttool

import { loadEnv } from './lib/env.mjs'
import {
  aiTitleFromJsonl,
  assistantTextsAfterFromJsonl,
  canonicalCwdFromJsonl,
  hasEndTurnAfter,
  lastUserPromptFromJsonl,
  readSessionJsonl,
  toolUsageAfterFromJsonl,
} from './lib/jsonl.mjs'

const log = (msg) => process.stderr.write(`cc-remote-hook: ${msg}\n`)

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

const mode = process.argv[2]
const env = loadEnv(log)
if (!env || !env.CC_REMOTE_BACKEND_URL || !env.CC_REMOTE_SHARED_SECRET) {
  log('config missing — skipping (CC_REMOTE_BACKEND_URL / CC_REMOTE_SHARED_SECRET unset)')
  // exit 0 so CC keeps the hook quiet rather than treating it as a failure.
  process.exit(0)
}
const backend = env.CC_REMOTE_BACKEND_URL.replace(/\/$/, '')
const input = await readStdin()

async function post(path, payload) {
  try {
    const r = await fetch(`${backend}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CC_REMOTE_SHARED_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    if (!r.ok) {
      log(`POST ${path} → HTTP ${r.status}`)
    }
  } catch (e) {
    log(`POST ${path} failed: ${e.message ?? e}`)
  }
}

switch (mode) {
  case 'stop': {
    // CC fires Stop the moment its agent loop exits, but the *last* assistant
    // message — the one with `stop_reason: end_turn` — may still be in
    // CC's write buffer. Reading immediately gives a transcript that's
    // missing the final narration. Poll the jsonl until either an
    // `end_turn` entry shows up after our user prompt or we've waited the
    // budget, then snapshot. Fast path: jsonl already flushed → no wait.
    // Worst case: 1.5s.
    const cwdInput = input.cwd ?? ''
    const sid = input.session_id
    const transcriptPath = input.transcript_path ?? null
    const start = Date.now()
    const BUDGET_MS = 1500
    const POLL_MS = 100
    const readArgs = { transcriptPath, cwd: cwdInput, sessionId: sid }
    let jsonl = readSessionJsonl(readArgs)
    while (Date.now() - start < BUDGET_MS) {
      const lastPrompt = lastUserPromptFromJsonl(jsonl)
      if (lastPrompt && hasEndTurnAfter(jsonl, lastPrompt.lineIndex)) break
      await new Promise((r) => setTimeout(r, POLL_MS))
      jsonl = readSessionJsonl(readArgs)
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
    // session_id is required so dismissPendingApprovals scopes to this CC,
    // not every concurrent instance in the same cwd.
    await post('/v1/hook/posttool', {
      session_id: input.session_id ?? '',
      cwd: input.cwd ?? '',
    })
    break
  default:
    log(`unknown mode '${mode}' (expected: stop | posttool)`)
    process.exit(1)
}
