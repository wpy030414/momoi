import { randomBytes, pbkdf2Sync, timingSafeEqual } from 'crypto'
import type { Context, Next } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { SignJWT, jwtVerify } from 'jose'
import { eq } from 'drizzle-orm'
import { env } from './config.js'
import { db } from './db.js'
import { settings } from './schema.js'

// ---- Admin membership ----

/**
 * Admins are declared via the `ADMIN` env var (comma-separated usernames),
 * fixed for the process lifetime. There is no admin key and no separate
 * admin token: admin endpoints accept an ordinary user JWT and check
 * membership here on every request.
 */
export function isAdmin(username: string): boolean {
  return env.ADMIN.includes(username)
}

// ---- JWT signing secret ----

const JWT_SECRET_KEY = 'jwt_secret'
let cachedSecret: Uint8Array | null = null

/**
 * JWT signing secret: `JWT_SECRET` from .env when provided; otherwise a random
 * 32-byte value generated on first boot and persisted in the settings table so
 * user tokens survive restarts without any required configuration.
 */
async function getSecret(): Promise<Uint8Array> {
  if (!cachedSecret) {
    if (env.JWT_SECRET) {
      cachedSecret = new TextEncoder().encode(env.JWT_SECRET)
    } else {
      const existing = await db.select().from(settings).where(eq(settings.key, JWT_SECRET_KEY)).get()
      if (existing?.value) {
        cachedSecret = new TextEncoder().encode(existing.value)
      } else {
        const generated = randomBytes(32).toString('hex')
        await db.insert(settings).values({ key: JWT_SECRET_KEY, value: generated }).onConflictDoNothing().run()
        const row = await db.select().from(settings).where(eq(settings.key, JWT_SECRET_KEY)).get()
        cachedSecret = new TextEncoder().encode(row?.value || generated)
      }
    }
  }
  return cachedSecret
}

// ---- PIN hashing (PBKDF2) ----

export function hashPin(pin: string, salt?: string): string {
  const s = salt || randomBytes(16).toString('hex')
  const hash = pbkdf2Sync(pin, s, 10000, 64, 'sha512').toString('hex')
  return `${s}:${hash}`
}

export function verifyPin(pin: string, stored: string): boolean {
  const [salt, hash] = stored.split(':')
  if (!salt || !hash) return false
  const check = pbkdf2Sync(pin, salt, 10000, 64, 'sha512')
  return timingSafeEqual(check, Buffer.from(hash, 'hex'))
}

// ---- Admin middleware ----

/**
 * Admin auth: verifies an ordinary user JWT, then checks that the username is
 * in the `ADMIN` list. 401 = missing/invalid token, 403 = valid user but not
 * an admin. Sets `userId` for downstream handlers.
 */
export async function adminAuthMiddleware(c: Context, next: Next) {
  const token = getAuthToken(c)
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const result = await verifyUserToken(token)
  if (!result) {
    return c.json({ error: 'Invalid token' }, 401)
  }
  if (!isAdmin(result.username)) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  c.set('userId', result.username)
  await next()
}

// ---- Token transport (HttpOnly Cookie primary, Bearer fallback) ----

export const AUTH_COOKIE = 'momoi_token'

function isHttps(c: Context): boolean {
  const proto = c.req.header('x-forwarded-proto') || new URL(c.req.url).protocol.replace(':', '')
  return proto === 'https'
}

function authCookieOptions(c: Context) {
  return {
    httpOnly: true, // invisible to JS — XSS cannot read/exfiltrate the token
    sameSite: 'Lax' as const, // blocks cookies on cross-site POSTs (CSRF mitigation)
    secure: isHttps(c), // only set Secure on HTTPS so plain-HTTP LAN deploys keep working
    path: '/',
  }
}

/** Issue the JWT as an HttpOnly cookie (primary transport). */
export function setAuthCookie(c: Context, token: string) {
  setCookie(c, AUTH_COOKIE, token, { ...authCookieOptions(c), maxAge: USER_TOKEN_TTL_SECONDS })
}

/** Clear the auth cookie (logout). */
export function clearAuthCookie(c: Context) {
  setCookie(c, AUTH_COOKIE, '', { ...authCookieOptions(c), maxAge: 0 })
}

/**
 * Extract the auth token: `Authorization: Bearer` header first (kept for API
 * clients/scripts and the localStorage→cookie migration window), then the
 * HttpOnly cookie.
 */
export function getAuthToken(c: Context): string | null {
  const auth = c.req.header('Authorization')
  if (auth?.startsWith('Bearer ')) return auth.slice(7)
  return getCookie(c, AUTH_COOKIE) || null
}

// ---- User JWT ----

/**
 * User JWT lifetime: 14 days, kept alive by client-side auto-renewal
 * (`POST /api/user/refresh` once less than half its life remains) — a sliding
 * session. Active users never re-login; after 14 days of inactivity the token
 * expires and PIN login is required again.
 */
export const USER_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60

export async function signUserToken(username: string): Promise<{ token: string; expires_at: number }> {
  const expires_at = Math.floor(Date.now() / 1000) + USER_TOKEN_TTL_SECONDS
  const token = await new SignJWT({ role: 'user', sub: username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    // NOTE: jose treats a numeric argument as an ABSOLUTE epoch, not an offset —
    // keep the relative form ('14d') in sync with USER_TOKEN_TTL_SECONDS.
    .setExpirationTime('14d')
    .sign(await getSecret())
  return { token, expires_at }
}

export async function verifyUserToken(token: string): Promise<{ username: string } | null> {
  try {
    const { payload } = await jwtVerify(token, await getSecret())
    if (payload.role !== 'user' || typeof payload.sub !== 'string') return null
    return { username: payload.sub }
  } catch {
    return null
  }
}
