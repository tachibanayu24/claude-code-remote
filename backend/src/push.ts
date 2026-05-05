import { FcmInvalidTokenError, sendFcm } from './fcm'
import type { FcmEnv } from './types'

async function listFcmTokens(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare('SELECT fcm_token FROM devices')
    .all<{ fcm_token: string }>()
  return (rows.results ?? []).map((r) => r.fcm_token)
}

/**
 * Fan-out to every registered device. Returns the count that *successfully*
 * received the push (not the count attempted) so callers report a meaningful
 * `notified` value. Tokens that FCM rejects as permanently invalid are
 * pruned from the devices table so we don't keep retrying them forever.
 */
async function fanOut(
  env: FcmEnv,
  db: D1Database,
  tokens: string[],
  data: Record<string, string>,
  errLabel: string
): Promise<number> {
  const results = await Promise.allSettled(
    tokens.map((token) => sendFcm(env, { token, data }))
  )
  let success = 0
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    if (r.status === 'fulfilled') {
      success++
      continue
    }
    const reason = r.reason
    if (reason instanceof FcmInvalidTokenError) {
      console.warn(`FCM ${errLabel} prune ${reason.token.slice(0, 12)}…: ${reason.message}`)
      await db.prepare('DELETE FROM devices WHERE fcm_token = ?').bind(reason.token).run().catch(() => {})
      continue
    }
    console.error(`FCM ${errLabel} failed`, reason instanceof Error ? reason.message : reason)
  }
  return success
}

export async function notifyApprovalRequest(
  env: FcmEnv,
  db: D1Database,
  data: Record<string, string>
): Promise<number> {
  const tokens = await listFcmTokens(db)
  return fanOut(env, db, tokens, { type: 'approval_request', ...data }, 'approval_request')
}

export async function notifyApprovalResolved(
  env: FcmEnv,
  db: D1Database,
  data: Record<string, string>
): Promise<number> {
  const tokens = await listFcmTokens(db)
  return fanOut(env, db, tokens, { type: 'approval_resolved', ...data }, 'approval_resolved')
}

export async function notifyInfo(
  env: FcmEnv,
  db: D1Database,
  data: Record<string, string>
): Promise<number> {
  const tokens = await listFcmTokens(db)
  return fanOut(env, db, tokens, { type: 'info', ...data }, 'info')
}
