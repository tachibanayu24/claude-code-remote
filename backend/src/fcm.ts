interface ServiceAccount {
  client_email: string
  private_key: string
}

let cachedToken: { token: string; expiresAt: number } | null = null
let inflightToken: Promise<string> | null = null

export async function getAccessToken(env: { FCM_SERVICE_ACCOUNT_JSON: string }): Promise<string> {
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token
  }
  // Single-flight: if multiple notifyXxx fan-outs hit a cold cache at once,
  // funnel them through the same exchange instead of issuing N parallel JWTs.
  if (inflightToken) return inflightToken
  inflightToken = exchangeToken(env).finally(() => { inflightToken = null })
  return inflightToken
}

async function exchangeToken(env: { FCM_SERVICE_ACCOUNT_JSON: string }): Promise<string> {
  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON) as ServiceAccount
  const nowSec = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    })
  )
  const signingInput = `${header}.${payload}`
  const signature = await signRS256(signingInput, sa.private_key)
  const jwt = `${signingInput}.${signature}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OAuth token exchange failed: ${res.status} ${err}`)
  }
  const data = (await res.json()) as { access_token: string; expires_in: number }
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  }
  return data.access_token
}

async function signRS256(data: string, privateKeyPem: string): Promise<string> {
  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '')
  const binaryDer = base64ToBytes(pemBody)
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(data)
  )
  return bytesToB64url(new Uint8Array(sig))
}

function b64url(s: string): string {
  return bytesToB64url(new TextEncoder().encode(s))
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

export interface FcmMessage {
  token: string
  data: Record<string, string>
}

/**
 * Thrown when FCM rejects a token as permanently invalid (UNREGISTERED /
 * INVALID_ARGUMENT). Callers should remove the token from their device list.
 */
export class FcmInvalidTokenError extends Error {
  constructor(readonly token: string, readonly status: number, readonly detail: string) {
    super(`FCM token rejected (${status}): ${detail}`)
  }
}

interface FcmErrorBody {
  error?: {
    status?: string
    details?: Array<{ errorCode?: string; '@type'?: string }>
  }
}

function isPermanentlyInvalidToken(status: number, errBody: string): boolean {
  // 404: UNREGISTERED (token revoked or never existed).
  if (status === 404) return true
  if (status !== 400) return false
  // 400 INVALID_ARGUMENT covers many things; only treat as invalid token when
  // FCM tells us so via error.details[].errorCode === 'INVALID_ARGUMENT' or
  // when the status is the FCM-specific 'INVALID_ARGUMENT' for tokens.
  try {
    const parsed = JSON.parse(errBody) as FcmErrorBody
    const status = parsed.error?.status
    if (status === 'INVALID_ARGUMENT') {
      const details = parsed.error?.details ?? []
      return details.some((d) =>
        d.errorCode === 'INVALID_ARGUMENT' || d.errorCode === 'UNREGISTERED'
      )
    }
    return false
  } catch (_) {
    // Fallback to legacy text match if the body isn't JSON.
    return /INVALID_ARGUMENT|registration token/i.test(errBody)
  }
}

export async function sendFcm(
  env: { FCM_SERVICE_ACCOUNT_JSON: string; FCM_PROJECT_ID: string },
  message: FcmMessage
): Promise<void> {
  const accessToken = await getAccessToken(env)
  const url = `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    // data-only メッセージは Android で normal priority がデフォルト → Doze 中は
    // バッチ遅延され、アプリを開くまで届かない事象が起きる。HIGH に上げて
    // 端末を wake させ、kill 状態の MessagingService も叩く。
    body: JSON.stringify({
      message: {
        ...message,
        android: { priority: 'high' },
      },
    }),
  })
  if (res.ok) return
  const err = await res.text()
  if (isPermanentlyInvalidToken(res.status, err)) {
    throw new FcmInvalidTokenError(message.token, res.status, err)
  }
  throw new Error(`FCM send failed: ${res.status} ${err}`)
}
