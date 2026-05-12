export const nowSec = () => Math.floor(Date.now() / 1000)

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
