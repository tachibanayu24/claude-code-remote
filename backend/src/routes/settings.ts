import { Hono } from 'hono'
import { nowSec, readJson } from '../db'
import { readSettings } from '../settings'
import type { Bindings, SettingsUpdateRequest } from '../types'

const app = new Hono<{ Bindings: Bindings }>()

// Hard caps so a typo on the phone can't disable notifications entirely or
// queue an absurd timer in channel.mjs.
const MAX_ASK_DELAY_MS = 5 * 60 * 1000        // 5 min
const MAX_STOP_THRESHOLD_MS = 60 * 60 * 1000  // 1 hour

app.get('/', async (c) => {
  const row = await readSettings(c.env)
  return c.json(row)
})

app.put('/', async (c) => {
  const body = await readJson<SettingsUpdateRequest>(c.req.raw)
  if (!body) return c.json({ error: 'invalid body' }, 400)

  const current = await readSettings(c.env)
  const askDelay = body.ask_delay_ms ?? current.ask_delay_ms
  const stopThreshold = body.stop_threshold_ms ?? current.stop_threshold_ms

  if (
    !Number.isInteger(askDelay) || askDelay < 0 || askDelay > MAX_ASK_DELAY_MS ||
    !Number.isInteger(stopThreshold) || stopThreshold < 0 || stopThreshold > MAX_STOP_THRESHOLD_MS
  ) {
    return c.json({ error: 'out of range' }, 400)
  }

  // INSERT OR REPLACE keeps the single-row invariant whether the seed migration
  // has run or not.
  await c.env.DB.prepare(
    `INSERT INTO settings (id, ask_delay_ms, stop_threshold_ms, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       ask_delay_ms = excluded.ask_delay_ms,
       stop_threshold_ms = excluded.stop_threshold_ms,
       updated_at = excluded.updated_at`
  ).bind(askDelay, stopThreshold, nowSec()).run()

  return c.json({ ask_delay_ms: askDelay, stop_threshold_ms: stopThreshold, updated_at: nowSec() })
})

export default app
