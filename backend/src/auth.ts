import type { Context, Next } from 'hono'
import type { Bindings } from './types'

async function timingSafeEqual(provided: string, expected: string): Promise<boolean> {
  // Hash both sides to a fixed length, then compare byte-by-byte. Avoids
  // length and prefix-time leaks from a naive string compare.
  const enc = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(provided)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ])
  const av = new Uint8Array(a)
  const bv = new Uint8Array(b)
  let diff = 0
  for (let i = 0; i < av.length; i++) diff |= av[i]! ^ bv[i]!
  return diff === 0
}

export async function bearerAuth(c: Context<{ Bindings: Bindings }>, next: Next) {
  const header = c.req.header('Authorization') ?? ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!provided || !(await timingSafeEqual(provided, c.env.SHARED_SECRET))) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
}
