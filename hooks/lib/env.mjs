// Loader for `~/.claude/hooks/.env` (or whichever path CC_REMOTE_ENV points
// at). Used by both the Stop/PostToolUse hook script and the channel.mjs
// MCP server. Reads `KEY=VALUE` lines, strips matching surrounding quotes,
// ignores `#` comments. Returns null on read failure so callers can surface
// a config-missing error.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CLAUDE_HOME = join(homedir(), '.claude')
const ENV_PATH = process.env.CC_REMOTE_ENV ?? join(CLAUDE_HOME, 'hooks/.env')

export function loadEnv(logger = () => {}) {
  let text
  try {
    text = readFileSync(ENV_PATH, 'utf8')
  } catch (e) {
    logger(`cannot read ${ENV_PATH}: ${e.message}`)
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
