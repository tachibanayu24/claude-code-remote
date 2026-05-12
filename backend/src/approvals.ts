// Approval-domain helpers shared by the routes layer. Owns:
//   - the `approvals.tool_input` JSON blob encoding (parse / encode)
//   - the FCM push payload shape (`approval_request`)
//   - bulk + single dismiss SQL with `decision:'expired'` fan-out
//
// Keeping these here means `routes/approvals.ts`, `routes/sessions.ts`, and
// `routes/hooks.ts` no longer each re-implement the same JSON parse, default
// fallback, or SQL/notify pair.

import { nowSec } from './db'
import { notifyApprovalResolved } from './push'
import type { Bindings } from './types'

/**
 * Older channel.mjs builds don't send `supports_always`; treat unknown as
 * true so the phone keeps showing the Always button (legacy behavior).
 */
export const supportsAlwaysDefault = (v: unknown): boolean =>
  typeof v === 'boolean' ? v : true

/**
 * Decoded form of the `approvals.tool_input` D1 column — the three packed
 * fields the phone needs to render the request body and decide whether to
 * surface the Always option.
 */
export interface ToolInputBlob {
  description: string
  input_preview: string
  supports_always: boolean
}

export function parseToolInputBlob(raw: string | null | undefined): ToolInputBlob {
  let parsed: Partial<ToolInputBlob> = {}
  try { if (raw) parsed = JSON.parse(raw) ?? {} } catch (_) {}
  return {
    description: parsed.description ?? '',
    input_preview: parsed.input_preview ?? '',
    supports_always: supportsAlwaysDefault(parsed.supports_always),
  }
}

export function encodeToolInputBlob(b: ToolInputBlob): string {
  return JSON.stringify(b)
}

/**
 * Build the FCM data payload for an `approval_request` push. Called from
 * both the immediate path (ask_delay = 0) and the deferred /notify endpoint
 * — same shape, just different source fields.
 */
export function approvalPushData(args: {
  id: string
  session_id: string
  project_name: string
  session_label?: string | null
  tool_name: string
  description: string
  input_preview: string
  supports_always: boolean
}): Record<string, string> {
  return {
    request_id: args.id,
    session_id: args.session_id,
    project: args.project_name,
    session_label: args.session_label ?? '',
    tool_name: args.tool_name,
    description: args.description,
    input_preview: args.input_preview,
    supports_always: args.supports_always ? 'true' : 'false',
  }
}

/**
 * Atomically transition pending → expired and fan out the resolve push so
 * Android clears any in-flight UI. RETURNING + a single UPDATE avoids the
 * UPDATE-then-SELECT race that could double-push if two callers raced.
 *
 * `where` is constrained to a literal union so the interpolated column name
 * is never user input. `value` is bound as a parameter.
 */
async function expirePendingApprovals(
  db: D1Database,
  env: Bindings,
  where: 'session_id' | 'id',
  value: string,
): Promise<string[]> {
  if (!value) return []
  const res = await db.prepare(
    `UPDATE approvals SET status = 'expired', resolved_at = ?
     WHERE status = 'pending' AND ${where} = ?
     RETURNING id`,
  ).bind(nowSec(), value).all<{ id: string }>()
  const ids = (res.results ?? []).map((r) => r.id)
  if (ids.length === 0) return ids
  await Promise.all(ids.map((id) =>
    notifyApprovalResolved(env, db, {
      request_id: id,
      decision: 'expired',
      resolved_by: 'cli',
    })
  ))
  return ids
}

/**
 * PostToolUse hook path: expire every pending approval scoped to this CC
 * session. Empty sessionId is a no-op — '' would match every row.
 */
export async function dismissPendingApprovals(
  db: D1Database,
  env: Bindings,
  sessionId: string,
): Promise<number> {
  return (await expirePendingApprovals(db, env, 'session_id', sessionId)).length
}

/**
 * channel.mjs path: JSONL shows CC has moved past this specific approval
 * (tool_result observed on the bound tool_use_id) before ask_delay
 * elapsed. Idempotent — non-pending rows are silently a no-op.
 */
export async function dismissApprovalById(
  db: D1Database,
  env: Bindings,
  id: string,
): Promise<boolean> {
  return (await expirePendingApprovals(db, env, 'id', id)).length > 0
}
