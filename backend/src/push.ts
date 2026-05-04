import { sendFcm } from './fcm'
import type { FcmEnv } from './types'

async function listFcmTokens(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare('SELECT fcm_token FROM devices')
    .all<{ fcm_token: string }>()
  return (rows.results ?? []).map((r) => r.fcm_token)
}

async function fanOut(
  env: FcmEnv,
  tokens: string[],
  data: Record<string, string>,
  errLabel: string
): Promise<void> {
  const sends = tokens.map((token) =>
    sendFcm(env, { token, data }).catch((e) => {
      console.error(`FCM ${errLabel} failed`, e instanceof Error ? e.message : e)
    })
  )
  await Promise.allSettled(sends)
}

export async function notifyApprovalRequest(
  env: FcmEnv,
  db: D1Database,
  data: Record<string, string>
): Promise<number> {
  const tokens = await listFcmTokens(db)
  await fanOut(env, tokens, { type: 'approval_request', ...data }, 'approval_request')
  return tokens.length
}

export async function notifyApprovalResolved(
  env: FcmEnv,
  db: D1Database,
  data: Record<string, string>
): Promise<number> {
  const tokens = await listFcmTokens(db)
  await fanOut(env, tokens, { type: 'approval_resolved', ...data }, 'approval_resolved')
  return tokens.length
}

export async function notifyInfo(
  env: FcmEnv,
  db: D1Database,
  data: Record<string, string>
): Promise<number> {
  const tokens = await listFcmTokens(db)
  await fanOut(env, tokens, { type: 'info', ...data }, 'info')
  return tokens.length
}
