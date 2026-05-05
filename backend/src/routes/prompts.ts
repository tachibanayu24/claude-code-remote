import { Hono } from 'hono'
import { nowSec, readJson } from '../db'
import type { Bindings, PromptCreateRequest, PromptRow } from '../types'

const app = new Hono<{ Bindings: Bindings }>()

app.post('/sessions/:cwd/prompts', async (c) => {
  const cwd = decodeURIComponent(c.req.param('cwd'))
  if (!cwd) return c.json({ error: 'cwd required' }, 400)
  const body = await readJson<PromptCreateRequest>(c.req.raw)
  const text = (body?.text ?? '').trim()
  if (!text) return c.json({ error: 'text required' }, 400)
  const id = crypto.randomUUID()
  await c.env.DB.prepare(
    `INSERT INTO prompts (id, cwd, text, status, created_at) VALUES (?, ?, ?, 'queued', ?)`
  ).bind(id, cwd, text, nowSec()).run()
  return c.json({ ok: true, id })
})

app.get('/sessions/:cwd/prompts/queued', async (c) => {
  const cwd = decodeURIComponent(c.req.param('cwd'))
  if (!cwd) return c.json({ error: 'cwd required' }, 400)
  const res = await c.env.DB.prepare(
    `SELECT id, cwd, text, status, created_at FROM prompts
     WHERE cwd = ? AND status = 'queued' ORDER BY created_at ASC`
  ).bind(cwd).all<PromptRow>()
  return c.json({ prompts: res.results ?? [] })
})

app.post('/prompts/:id/delivered', async (c) => {
  const id = c.req.param('id')
  const result = await c.env.DB.prepare(
    `UPDATE prompts SET status = 'delivered', delivered_at = ?
     WHERE id = ? AND status = 'queued'`
  ).bind(nowSec(), id).run()
  if ((result.meta?.changes ?? 0) === 0) {
    // 409 lets channel.mjs distinguish "another channel claimed it first"
    // (expected race) from a truly missing id (programming error).
    return c.json({ error: 'already delivered or not found' }, 409)
  }
  return c.json({ ok: true })
})

export default app
