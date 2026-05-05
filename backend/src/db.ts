import { notifyApprovalResolved } from './push'
import type { Bindings } from './types'

export const nowSec = () => Math.floor(Date.now() / 1000)

/**
 * Atomically expire all pending approvals for `cwd` and notify Android of each
 * one. Uses `RETURNING` so the UPDATE and the ID extraction happen in a single
 * statement — without that, two concurrent calls (e.g. two Stop hooks for the
 * same cwd) would each see the rows as pending and fan out duplicate FCM
 * pushes.
 *
 * cwd is required — '' would match every row. Callers must validate.
 */
export async function dismissPendingApprovals(
  db: D1Database,
  env: Bindings,
  cwd: string,
): Promise<number> {
  if (!cwd) return 0
  const res = await db.prepare(
    `UPDATE approvals SET status = 'expired', resolved_at = ?
     WHERE status = 'pending' AND cwd = ?
     RETURNING id`,
  ).bind(nowSec(), cwd).all<{ id: string }>()
  const ids = (res.results ?? []).map((r) => r.id)
  if (ids.length === 0) return 0
  await Promise.all(ids.map((id) =>
    notifyApprovalResolved(env, db, {
      request_id: id,
      decision: 'expired',
      resolved_by: 'cli',
    })
  ))
  return ids.length
}

/**
 * Cleanup helpers fired from `c.executionCtx.waitUntil(...)` inside read
 * endpoints. Cheap (range scan on indexed columns), runs after the response is
 * sent, no cron needed. Errors are intentionally swallowed — a failed cleanup
 * is a soft warning, not a user-visible error.
 */
export const SESSION_STALE_AFTER_SEC = 7 * 24 * 3600
export const TURNS_RETENTION_SEC = 30 * 24 * 3600

export async function cleanupStaleSessions(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE last_heartbeat < ?')
    .bind(nowSec() - SESSION_STALE_AFTER_SEC)
    .run()
    .catch(() => {})
}

export async function cleanupOldTurns(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM turns WHERE ended_at < ?')
    .bind(nowSec() - TURNS_RETENTION_SEC)
    .run()
    .catch(() => {})
}

/** Read JSON body but never throw — return null on parse failure. */
export async function readJson<T>(req: Request): Promise<T | null> {
  try { return await req.json<T>() } catch (_) { return null }
}
