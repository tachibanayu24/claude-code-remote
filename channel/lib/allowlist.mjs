// Project-level allowlist (`.claude/settings.local.json`) management.
// Triggered when the phone responds with `add_to_allowlist:true` — the
// matching tool pattern is appended so future invocations skip the prompt.
// CC writes this same file (e.g. on `/permissions add`), so writes must be
// atomic (tmp + rename) to survive concurrent edits.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Translate a (toolName, inputPreview) pair into the matching allowlist
 * pattern, or null when no tool-wide rule would be useful.
 *
 * - Bash: extract the first command word (basename) → `Bash(cmd:*)`.
 * - WebFetch: extract URL host → `WebFetch(domain:host)`.
 * - Edit/Write/MultiEdit deliberately omitted: CC's allowlist matcher takes
 *   glob patterns, not literal file paths, so `Edit(/exact/file.kt)` would
 *   only ever match that one file. Better to keep prompting than to silently
 *   lock the allowlist to a single path.
 *
 * Channel.mjs is the SoT for this rule — `supports_always` sent with the
 * `/v1/approvals` POST is just `deriveAllowPattern(...) != null`.
 */
export function deriveAllowPattern(toolName, inputPreview) {
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

/**
 * Append `pattern` to the project's allowlist file. Returns true iff the
 * pattern was newly added; false when it was already present. Atomic write
 * (tmp + rename) so a concurrent CC `/permissions add` can't truncate the
 * file mid-edit. `log` defaults to a no-op so this is safe to import
 * standalone.
 */
export function appendAllowPattern(cwd, pattern, log = () => {}) {
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
  if (json.permissions.allow.includes(pattern)) return false
  json.permissions.allow.push(pattern)
  mkdirSync(dirname(settingsPath), { recursive: true })
  const tmpPath = `${settingsPath}.cc-remote.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmpPath, JSON.stringify(json, null, 2) + '\n')
  renameSync(tmpPath, settingsPath)
  return true
}
