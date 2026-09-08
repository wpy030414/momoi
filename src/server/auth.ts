import { randomBytes, pbkdf2Sync, timingSafeEqual } from 'crypto'
import type { Context, Next } from 'hono'
import { SignJWT, jwtVerify } from 'jose'
import { env } from './config.js'

const secret = new TextEncoder().encode(env.ADMIN_KEY || 'fallback-secret')

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

// ---- Admin JWT ----

export async function signAdminToken(): Promise<{ token: string; expires_at: number }> {
  const expires_at = Math.floor(Date.now() / 1000) + 24 * 60 * 60 // 24h
  const token = await new SignJWT({ role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('24h')
    .sign(secret)
  return { token, expires_at }
}

async function verifyAdminToken(token: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, secret)
    return payload.role === 'admin'
  } catch {
    return false
  }
}

export function verifyAdminKey(key: string): boolean {
  return key === env.ADMIN_KEY && key !== ''
}

export async function adminAuthMiddleware(c: Context, next: Next) {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const token = auth.slice(7)
  if (!(await verifyAdminToken(token))) {
    return c.json({ error: 'Invalid token' }, 401)
  }
  await next()
}

// ---- User JWT ----

export async function signUserToken(username: string): Promise<{ token: string; expires_at: number }> {
  const expires_at = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 // 30 days
  const token = await new SignJWT({ role: 'user', sub: username })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('30d')
    .sign(secret)
  return { token, expires_at }
}

export async function verifyUserToken(token: string): Promise<{ username: string } | null> {
  try {
    const { payload } = await jwtVerify(token, secret)
    if (payload.role !== 'user' || typeof payload.sub !== 'string') return null
    return { username: payload.sub }
  } catch {
    return null
  }
}

