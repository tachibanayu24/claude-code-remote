// FCM fan-out。 全 device に同じ data payload を撒き、 永続的に invalid な
// token は devices テーブルから自動 prune する。
//
// 設計: 旧 API では「タイプごとの notify*Request / *Resolved 関数」が並んでいたが、
// 中身は `pushNotification(type, data)` で済む。 routes は具体の type 名で呼びたい
// ので thin wrapper を用意して命名は保つ — 利用箇所の grep は引き続き効く。

import { FcmInvalidTokenError, sendFcm } from './fcm'
import type { FcmEnv } from './types'

/** FCM data の `type` 既定値。 Android 側 dispatcher で switch される識別子。 */
export type PushType =
  | 'approval_request'
  | 'approval_resolved'
  | 'question_request'
  | 'question_resolved'
  | 'info'

async function listFcmTokens(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare('SELECT fcm_token FROM devices')
    .all<{ fcm_token: string }>()
  return (rows.results ?? []).map((r) => r.fcm_token)
}

/** Bulk-prune tokens that FCM has rejected as permanently invalid. */
async function pruneInvalidTokens(db: D1Database, tokens: string[]): Promise<void> {
  if (tokens.length === 0) return
  const placeholders = tokens.map(() => '?').join(',')
  await db.prepare(`DELETE FROM devices WHERE fcm_token IN (${placeholders})`)
    .bind(...tokens)
    .run()
    .catch(() => {})
}

/**
 * 全 device に FCM data push を撒く。 返値は成功した送信件数。
 * `UNREGISTERED` などの永続的失敗は devices から prune される。
 * 1 件でも成功すれば push は配送済みとみなす運用。
 */
export async function pushNotification(
  env: FcmEnv,
  db: D1Database,
  type: PushType,
  data: Record<string, string>,
): Promise<number> {
  const tokens = await listFcmTokens(db)
  const payload = { type, ...data }
  const results = await Promise.allSettled(
    tokens.map((token) => sendFcm(env, { token, data: payload }))
  )
  let success = 0
  const invalidTokens: string[] = []
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    if (r.status === 'fulfilled') {
      success++
      continue
    }
    const reason = r.reason
    if (reason instanceof FcmInvalidTokenError) {
      console.warn(`FCM ${type} prune ${reason.token.slice(0, 12)}…: ${reason.message}`)
      invalidTokens.push(reason.token)
      continue
    }
    console.error(`FCM ${type} failed`, reason instanceof Error ? reason.message : reason)
  }
  await pruneInvalidTokens(db, invalidTokens)
  return success
}

// ---- thin wrappers (call site の grep 性と arity 統一のため) ----

export const notifyApprovalRequest = (env: FcmEnv, db: D1Database, data: Record<string, string>) =>
  pushNotification(env, db, 'approval_request', data)

export const notifyApprovalResolved = (env: FcmEnv, db: D1Database, data: Record<string, string>) =>
  pushNotification(env, db, 'approval_resolved', data)

export const notifyQuestionRequest = (env: FcmEnv, db: D1Database, data: Record<string, string>) =>
  pushNotification(env, db, 'question_request', data)

export const notifyQuestionResolved = (env: FcmEnv, db: D1Database, data: Record<string, string>) =>
  pushNotification(env, db, 'question_resolved', data)

export const notifyInfo = (env: FcmEnv, db: D1Database, data: Record<string, string>) =>
  pushNotification(env, db, 'info', data)
