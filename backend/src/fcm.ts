interface ServiceAccount {
  client_email: string
  private_key: string
}

let cachedToken: { token: string; expiresAt: number } | null = null

export async function getAccessToken(env: { FCM_SERVICE_ACCOUNT_JSON: string }): Promise<string> {
  const now = Date.now()
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token
  }

  const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON) as ServiceAccount
  const nowSec = Math.floor(now / 1000)
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
    expiresAt: now + (data.expires_in - 60) * 1000,
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
    body: JSON.stringify({ message }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`FCM send failed: ${res.status} ${err}`)
  }
}
