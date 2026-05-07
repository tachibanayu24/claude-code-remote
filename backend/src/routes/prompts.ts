import { Hono } from 'hono'
import { nowSec, readJson } from '../db'
import type { Bindings, PromptCreateRequest } from '../types'

const app = new Hono<{ Bindings: Bindings }>()

app.post('/sessions/:sid/prompts', async (c) => {
  const sid = c.req.param('sid')
  if (!sid) return c.json({ error: 'session_id required' }, 400)
  const body = await readJson<PromptCreateRequest>(c.req.raw)
  const text = (body?.text ?? '').trim()
  if (!text) return c.json({ error: 'text required' }, 400)
  // Look up the session's cwd so the prompts row keeps it for display, but
  // the routing key is session_id — only that CC's channel.mjs will drain it.
  const session = await c.env.DB.prepare('SELECT cwd FROM sessions WHERE session_id = ?')
    .bind(sid)
    .first<{ cwd: string }>()
  if (!session) return c.json({ error: 'session not found' }, 404)
  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO prompts (id, session_id, cwd, text, status, created_at)
     VALUES (?, ?, ?, ?, 'queued', ?)`
  ).bind(id, sid, session.cwd, text, nowSec()).run()
  return c.json({ ok: true, id })
})

app.post('/prompts/:id/delivered', async (c) => {
  const id = c.req.param('id')
  const result = await c.env.DB.prepare(
    `UPDATE prompts SET status = 'delivered', delivered_at = ?
     WHERE id = ? AND status = 'queued'`
  ).bind(nowSec(), id).run()
  if ((result.meta?.changes ?? 0) === 0) {
    return c.json({ error: 'already delivered or not found' }, 409)
  }
  return c.json({ ok: true })
})

export default app
