import { Hono } from 'hono'
import { nowSec, readJson } from '../db'
import type { Bindings, DeviceRegisterRequest } from '../types'

const app = new Hono<{ Bindings: Bindings }>()

app.post('/register', async (c) => {
  const body = await readJson<DeviceRegisterRequest>(c.req.raw)
  if (!body?.device_id || !body.fcm_token) {
    return c.json({ error: 'device_id and fcm_token required' }, 400)
  }
  // Drop stale rows that share this token under a different device id (e.g.
  // after the user reset the app and DataStore generated a new UUID).
  await c.env.DB.prepare('DELETE FROM devices WHERE fcm_token = ? AND id != ?')
    .bind(body.fcm_token, body.device_id)
    .run()
  await c.env.DB.prepare(
    `INSERT INTO devices (id, fcm_token, name, registered_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET fcm_token = excluded.fcm_token,
                                    name = excluded.name,
                                    registered_at = excluded.registered_at`
  )
    .bind(body.device_id, body.fcm_token, body.name ?? null, nowSec())
    .run()
  return c.json({ ok: true })
})

export default app
