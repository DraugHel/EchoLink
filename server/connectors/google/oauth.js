import crypto from 'node:crypto'
import db from '../../db.js'

const AUTH_URL =
  'https://accounts.google.com/o/oauth2/v2/auth'

const TOKEN_URL =
  'https://oauth2.googleapis.com/token'

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly'
]

function exposedError(message, statusCode = 500) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.expose = true
  return error
}

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim()

  if (!value) {
    throw exposedError(
      `Google OAuth ist nicht vollständig konfiguriert: ${name} fehlt`,
      503
    )
  }

  return value
}

function encryptionKey() {
  const raw = requiredEnv(
    'GOOGLE_TOKEN_ENCRYPTION_KEY'
  )

  if (!/^[a-fA-F0-9]{64}$/.test(raw)) {
    throw exposedError(
      'GOOGLE_TOKEN_ENCRYPTION_KEY muss 32 Byte als Hex enthalten',
      503
    )
  }

  return Buffer.from(raw, 'hex')
}

function encryptToken(value) {
  if (!value) return null

  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    encryptionKey(),
    iv
  )

  const ciphertext = Buffer.concat([
    cipher.update(String(value), 'utf8'),
    cipher.final()
  ])

  const authTag = cipher.getAuthTag()

  return [
    'v1',
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url')
  ].join('.')
}

function decryptToken(value) {
  if (!value) return null

  const parts = String(value).split('.')

  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw exposedError(
      'Gespeichertes Google-Token hat ein ungültiges Format',
      500
    )
  }

  const [, ivValue, tagValue, cipherValue] =
    parts

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(ivValue, 'base64url')
  )

  decipher.setAuthTag(
    Buffer.from(tagValue, 'base64url')
  )

  return Buffer.concat([
    decipher.update(
      Buffer.from(cipherValue, 'base64url')
    ),
    decipher.final()
  ]).toString('utf8')
}

export function googleOAuthConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI &&
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY
  )
}

export function buildGoogleAuthorizationUrl(
  state
) {
  const params = new URLSearchParams({
    client_id: requiredEnv('GOOGLE_CLIENT_ID'),
    redirect_uri:
      requiredEnv('GOOGLE_REDIRECT_URI'),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state
  })

  return `${AUTH_URL}?${params.toString()}`
}

async function requestTokens(parameters) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type':
        'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(parameters),
    signal: AbortSignal.timeout(20_000)
  })

  let body = {}

  try {
    body = await response.json()
  } catch {}

  if (!response.ok) {
    const message =
      body.error_description ||
      body.error ||
      `HTTP ${response.status}`

    throw exposedError(
      `Google OAuth fehlgeschlagen: ${message}`,
      502
    )
  }

  return body
}

export async function exchangeGoogleCode(code) {
  return requestTokens({
    code,
    client_id: requiredEnv('GOOGLE_CLIENT_ID'),
    client_secret:
      requiredEnv('GOOGLE_CLIENT_SECRET'),
    redirect_uri:
      requiredEnv('GOOGLE_REDIRECT_URI'),
    grant_type: 'authorization_code'
  })
}

export function saveGoogleTokens(
  userId,
  tokens
) {
  if (!tokens?.access_token) {
    throw exposedError(
      'Google hat kein Access-Token geliefert',
      502
    )
  }

  const existing = db.prepare(`
    SELECT *
    FROM google_oauth_accounts
    WHERE user_id = ?
  `).get(userId)

  const accessTokenEnc =
    encryptToken(tokens.access_token)

  const refreshTokenEnc =
    tokens.refresh_token
      ? encryptToken(tokens.refresh_token)
      : existing?.refresh_token_enc || null

  const expiresIn = Math.max(
    60,
    Number(tokens.expires_in) || 3600
  )

  const expiresAt =
    Math.floor(Date.now() / 1000) + expiresIn

  const scope =
    tokens.scope ||
    existing?.scope ||
    GOOGLE_SCOPES.join(' ')

  const tokenType =
    tokens.token_type ||
    existing?.token_type ||
    'Bearer'

  db.prepare(`
    INSERT INTO google_oauth_accounts (
      user_id,
      access_token_enc,
      refresh_token_enc,
      expires_at,
      scope,
      token_type,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
    ON CONFLICT(user_id) DO UPDATE SET
      access_token_enc = excluded.access_token_enc,
      refresh_token_enc = excluded.refresh_token_enc,
      expires_at = excluded.expires_at,
      scope = excluded.scope,
      token_type = excluded.token_type,
      updated_at = unixepoch()
  `).run(
    userId,
    accessTokenEnc,
    refreshTokenEnc,
    expiresAt,
    scope,
    tokenType
  )
}

export function getGoogleConnectionStatus(
  userId
) {
  const account = db.prepare(`
    SELECT
      expires_at,
      scope,
      created_at,
      updated_at
    FROM google_oauth_accounts
    WHERE user_id = ?
  `).get(userId)

  if (!account) {
    return {
      configured: googleOAuthConfigured(),
      connected: false
    }
  }

  return {
    configured: googleOAuthConfigured(),
    connected: true,
    expiresAt: account.expires_at,
    scope: account.scope,
    connectedAt: account.created_at,
    updatedAt: account.updated_at
  }
}

export function disconnectGoogle(userId) {
  return db.prepare(`
    DELETE FROM google_oauth_accounts
    WHERE user_id = ?
  `).run(userId).changes > 0
}

export async function getGoogleAccessToken(
  userId,
  { forceRefresh = false } = {}
) {
  const account = db.prepare(`
    SELECT *
    FROM google_oauth_accounts
    WHERE user_id = ?
  `).get(userId)

  if (!account) {
    throw exposedError(
      'Google Calendar ist noch nicht verbunden',
      409
    )
  }

  const now = Math.floor(Date.now() / 1000)

  if (
    !forceRefresh &&
    account.expires_at > now + 60
  ) {
    return decryptToken(
      account.access_token_enc
    )
  }

  const refreshToken = decryptToken(
    account.refresh_token_enc
  )

  if (!refreshToken) {
    throw exposedError(
      'Google-Verbindung besitzt keinen Refresh-Token. Bitte neu verbinden.',
      409
    )
  }

  const tokens = await requestTokens({
    client_id: requiredEnv('GOOGLE_CLIENT_ID'),
    client_secret:
      requiredEnv('GOOGLE_CLIENT_SECRET'),
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  })

  saveGoogleTokens(userId, tokens)

  return tokens.access_token
}
