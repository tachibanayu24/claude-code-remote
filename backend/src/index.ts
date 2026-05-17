import { Hono } from 'hono'
import { bearerAuth } from './auth'
import approvals from './routes/approvals'
import devices from './routes/devices'
import hooks from './routes/hooks'
import prompts from './routes/prompts'
import questions from './routes/questions'
import sessions from './routes/sessions'
import settings from './routes/settings'
import wait from './routes/wait'
import type { Bindings } from './types'

const app = new Hono<{ Bindings: Bindings }>()

app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }))

app.use('/v1/*', bearerAuth)

app.route('/v1/devices', devices)
app.route('/v1/approvals', approvals)
app.route('/v1/questions', questions)
app.route('/v1/hook', hooks)
app.route('/v1/sessions', sessions)
app.route('/v1/settings', settings)
app.route('/v1/wait', wait)
// `prompts` declares both `/sessions/:sid/prompts*` and `/prompts/:id/...`
// shapes, so it mounts at the v1 root rather than under a sub-prefix.
app.route('/v1', prompts)

export default app
