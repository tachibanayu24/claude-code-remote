// HTTP client for the Cloudflare Workers backend. Owns config loading so
// channel.mjs doesn't have to thread BACKEND/SECRET through every call site;
// `apiPost` is the single egress point used by the permission relay,
// `/v1/wait` long-poll, and `/dismiss` early-expire paths.

import { loadEnv } from '../../hooks/lib/env.mjs'

const log = (msg) => process.stderr.write(`[cc-remote] ${msg}\n`)
const env = loadEnv(log) ?? {}

const BACKEND = env.CC_REMOTE_BACKEND_URL?.replace(/\/$/, '') ?? ''
const SECRET = env.CC_REMOTE_SHARED_SECRET ?? ''

/** True iff both backend URL and shared secret are present in the env file. */
export const isConfigured = () => Boolean(BACKEND && SECRET)

const headers = {
  'Authorization': `Bearer ${SECRET}`,
  'Content-Type': 'application/json',
}

export async function apiPost(path, payload, signal) {
  return fetch(`${BACKEND}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  })
}
