import { Hono } from 'hono'
import { db } from '../db.js'
import { settings } from '../schema.js'
import { eq } from 'drizzle-orm'
import { hashPin, verifyPin, signUserToken } from '../auth.js'
import { getClientIp, checkIpBlocked, recordPinFailure, clearPinFailures } from '../rateLimiter.js'

export const userRoute = new Hono()

function getUsername(c: any): string {
  const raw = c.req.header('x-user') || ''
  try { return decodeURIComponent(raw) } catch { return raw }
}

function pinKey(username: string): string {
  return `pin:${username}`
}

// Check whether the user has set a PIN
userRoute.get('/status', async (c) => {
  const username = getUsername(c)
  if (!username) return c.json({ error: 'Username required' }, 400)
  const row = await db.select().from(settings).where(eq(settings.key, pinKey(username))).get()
  return c.json({ has_pin: !!row })
})

// Verify PIN and return JWT
userRoute.post('/verify', async (c) => {
  const username = getUsername(c)
  if (!username) return c.json({ error: 'Username required' }, 400)

  const ip = getClientIp(c)
  const blocked = checkIpBlocked(ip)
  if (blocked) {
    return c.json({ error: blocked }, 429)
  }

  const { pin } = await c.req.json<{ pin: string }>()
  if (!pin || !/^\d{4}$/.test(pin)) {
    return c.json({ error: 'PIN must be 4 digits' }, 400)
  }

  const row = await db.select().from(settings).where(eq(settings.key, pinKey(username))).get()
  if (!row) return c.json({ error: 'PIN not set' }, 404)

  if (!verifyPin(pin, row.value)) {
    recordPinFailure(ip)
    return c.json({ error: 'Invalid PIN' }, 401)
  }

  clearPinFailures(ip)
  const result = await signUserToken(username)
  return c.json(result)
})

// Set PIN for the first time (no old PIN required)
userRoute.post('/set-pin', async (c) => {
  const username = getUsername(c)
  if (!username) return c.json({ error: 'Username required' }, 400)

  const { pin } = await c.req.json<{ pin: string }>()
  if (!pin || !/^\d{4}$/.test(pin)) {
    return c.json({ error: 'PIN must be 4 digits' }, 400)
  }

  const existing = await db.select().from(settings).where(eq(settings.key, pinKey(username))).get()
  if (existing) {
    return c.json({ error: 'PIN already set, use change-pin' }, 409)
  }

  const hashed = hashPin(pin)
  await db.insert(settings).values({ key: pinKey(username), value: hashed }).run()

  const result = await signUserToken(username)
  return c.json(result)
})

// Change PIN (requires old PIN)
userRoute.post('/change-pin', async (c) => {
  const username = getUsername(c)
  if (!username) return c.json({ error: 'Username required' }, 400)

  const ip = getClientIp(c)
  const blocked = checkIpBlocked(ip)
  if (blocked) {
    return c.json({ error: blocked }, 429)
  }

  const { old_pin, new_pin } = await c.req.json<{ old_pin: string; new_pin: string }>()
  if (!old_pin || !/^\d{4}$/.test(old_pin) || !new_pin || !/^\d{4}$/.test(new_pin)) {
    return c.json({ error: 'PIN must be 4 digits' }, 400)
  }

  const row = await db.select().from(settings).where(eq(settings.key, pinKey(username))).get()
  if (!row) return c.json({ error: 'PIN not set' }, 404)

  if (!verifyPin(old_pin, row.value)) {
    recordPinFailure(ip)
    return c.json({ error: 'Invalid current PIN' }, 401)
  }

  clearPinFailures(ip)
  const hashed = hashPin(new_pin)
  await db.update(settings).set({ value: hashed }).where(eq(settings.key, pinKey(username))).run()

  return c.json({ success: true })
})
