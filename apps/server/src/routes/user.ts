import { Hono } from 'hono'
import { ErrCode } from '@momoi/shared/errors'
import { db, users, userOauthBindings, wechatBindings, qqBindings, conversations } from '../db/index.js'
import { eq, and } from 'drizzle-orm'
import { hashPin, verifyPin, signUserToken, isAdmin, setAuthCookie, clearAuthCookie } from '../lib/auth.js'
import { ApiError } from '../lib/apiError.js'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { isDirectRegistrationOpen, isOauthRegistrationOpen } from '../lib/config.js'
import { getClientIp, checkIpBlocked, recordPinFailure, clearPinFailures } from '../lib/rateLimiter.js'
import { stopBotForUser, startBotForUser } from '../im/qq/manager.js'

export const userRoute = new Hono()

const PIN_RE = /^\d{4,8}$/

function getUsername(c: any): string {
  const raw = c.req.header('x-user') || ''
  try { return decodeURIComponent(raw) } catch { return raw }
}

async function trackUserLogin(username: string) {
  const now = Math.floor(Date.now() / 1000)
  const existing = await db.select().from(users).where(eq(users.username, username)).get()
  if (existing) {
    await db.update(users).set({ last_login_at: now }).where(eq(users.username, username)).run()
  } else {
    await db.insert(users).values({ username, pin_hash: '', first_login_at: now, last_login_at: now, banned: false }).run()
  }
}

export async function trackUserActivity(username: string) {
  const now = Math.floor(Date.now() / 1000)
  await db.update(users).set({ last_active_at: now }).where(eq(users.username, username)).run()
}

// Current user info — used by the client to detect admin status
userRoute.get('/me', userAuthMiddleware, (c) => {
  const username = (c as any).get('userId') as string
  return c.json({ username, is_admin: isAdmin(username) })
})

// Refresh — exchange a still-valid token for a fresh 14-day one (sliding session).
// The server keeps no token registry: the old token stays valid until its own
// expiry; renewal is purely re-issuance. New token goes out via Set-Cookie only
// (never in the response body — the body must stay readable-by-XSS-free).
userRoute.post('/refresh', userAuthMiddleware, async (c) => {
  const username = (c as any).get('userId') as string
  const result = await signUserToken(username)
  setAuthCookie(c, result.token)
  return c.json({ expires_at: result.expires_at })
})

// Logout — clear the HttpOnly cookie (client JS cannot touch it, so this must
// be done server-side). Idempotent: safe to call without a valid session.
userRoute.post('/logout', (c) => {
  clearAuthCookie(c)
  return c.json({ success: true })
})

// Check whether the user has set a PIN
userRoute.get('/status', async (c) => {
  const username = getUsername(c)
  if (!username) throw new ApiError(ErrCode.USER_NAME_REQUIRED)
  const row = await db.select().from(users).where(eq(users.username, username)).get()
  const [directOpen, oauthOpen] = await Promise.all([isDirectRegistrationOpen(), isOauthRegistrationOpen()])
  return c.json({ has_pin: !!(row?.pin_hash), direct_registration_open: directOpen, oauth_registration_open: oauthOpen })
})

// Verify PIN and return JWT
userRoute.post('/verify', async (c) => {
  const username = getUsername(c)
  if (!username) throw new ApiError(ErrCode.USER_NAME_REQUIRED)

  const ip = getClientIp(c)
  const blocked = checkIpBlocked(ip)
  if (blocked) {
    throw new ApiError(ErrCode.USER_RATE_LIMITED, { seconds: blocked.seconds })
  }

  const { pin } = await c.req.json<{ pin: string }>()
  if (!pin || !PIN_RE.test(pin)) {
    throw new ApiError(ErrCode.USER_PIN_FORMAT)
  }

  const userRow = await db.select().from(users).where(eq(users.username, username)).get()
  if (!userRow?.pin_hash) throw new ApiError(ErrCode.USER_PIN_NOT_SET)

  // Reject disabled accounts before issuing a token
  if (userRow.banned) {
    throw new ApiError(ErrCode.USER_DISABLED)
  }

  if (!verifyPin(pin, userRow.pin_hash)) {
    recordPinFailure(ip)
    throw new ApiError(ErrCode.AUTH_INVALID_PIN)
  }

  clearPinFailures(ip)
  await trackUserLogin(username)
  const result = await signUserToken(username)
  setAuthCookie(c, result.token)
  return c.json({ expires_at: result.expires_at })
})

// Set PIN for the first time (no old PIN required)
userRoute.post('/set-pin', async (c) => {
  const username = getUsername(c)
  if (!username) throw new ApiError(ErrCode.USER_NAME_REQUIRED)

  const { pin } = await c.req.json<{ pin: string }>()
  if (!pin || !PIN_RE.test(pin)) {
    throw new ApiError(ErrCode.USER_PIN_FORMAT)
  }

  // Check registration gate — only new users (no PIN yet) are blocked when closed
  const existing = await db.select().from(users).where(eq(users.username, username)).get()
  if (!existing?.pin_hash) {
    const registrationOpen = await isDirectRegistrationOpen()
    if (!registrationOpen) {
      throw new ApiError(ErrCode.USER_REGISTRATION_CLOSED)
    }
  }

  if (existing?.pin_hash) {
    throw new ApiError(ErrCode.USER_PIN_ALREADY_SET)
  }

  // Reject disabled accounts before issuing a token
  if (existing?.banned) {
    throw new ApiError(ErrCode.USER_DISABLED)
  }

  const hashed = hashPin(pin)
  const now = Math.floor(Date.now() / 1000)

  // Atomic write: INSERT with pin_hash already set, or UPDATE an orphan row.
  // Never persist an empty pin_hash — a crash at any point leaves no half-written user.
  if (existing) {
    await db.update(users).set({ pin_hash: hashed, last_login_at: now }).where(eq(users.username, username)).run()
  } else {
    await db.insert(users).values({ username, pin_hash: hashed, first_login_at: now, last_login_at: now, banned: false }).run()
  }

  const result = await signUserToken(username)
  setAuthCookie(c, result.token)
  return c.json({ expires_at: result.expires_at })
})

// Change PIN (requires old PIN)
userRoute.post('/change-pin', async (c) => {
  const username = getUsername(c)
  if (!username) throw new ApiError(ErrCode.USER_NAME_REQUIRED)

  const ip = getClientIp(c)
  const blocked = checkIpBlocked(ip)
  if (blocked) {
    throw new ApiError(ErrCode.USER_RATE_LIMITED, { seconds: blocked.seconds })
  }

  const { old_pin, new_pin } = await c.req.json<{ old_pin: string; new_pin: string }>()
  if (!old_pin || !PIN_RE.test(old_pin) || !new_pin || !PIN_RE.test(new_pin)) {
    throw new ApiError(ErrCode.USER_PIN_FORMAT)
  }

  const userRow = await db.select().from(users).where(eq(users.username, username)).get()
  if (!userRow?.pin_hash) throw new ApiError(ErrCode.USER_PIN_NOT_SET)

  if (!verifyPin(old_pin, userRow.pin_hash)) {
    recordPinFailure(ip)
    throw new ApiError(ErrCode.AUTH_INVALID_CURRENT_PIN)
  }

  clearPinFailures(ip)
  const hashed = hashPin(new_pin)
  await db.update(users).set({ pin_hash: hashed }).where(eq(users.username, username)).run()

  return c.json({ success: true })
})

// ---- Rename user ----

userRoute.post('/rename', userAuthMiddleware, async (c) => {
  const oldUsername = (c as any).get('userId') as string
  const { new_username } = await c.req.json<{ new_username: string }>()
  if (!new_username || !new_username.trim()) {
    throw new ApiError(ErrCode.USER_RENAME_REQUIRED)
  }
  const newName = new_username.trim()
  if (newName === oldUsername) throw new ApiError(ErrCode.USER_RENAME_SAME)

  const conflict = await db.select().from(users).where(eq(users.username, newName)).get()
  if (conflict) throw new ApiError(ErrCode.USER_NAME_TAKEN)

  const now = Math.floor(Date.now() / 1000)
  await db.update(users).set({ username: newName, last_login_at: now }).where(eq(users.username, oldUsername)).run()
  await db.update(conversations).set({ user_id: newName }).where(eq(conversations.user_id, oldUsername)).run()
  await db.update(userOauthBindings).set({ user_id: newName }).where(eq(userOauthBindings.user_id, oldUsername)).run()
  await db.update(wechatBindings).set({ user_id: newName }).where(eq(wechatBindings.user_id, oldUsername)).run()
  // QQ per-agent 绑定下需遍历全部 binding 行：旧 key 停、新 key 起。
  // 先查再更名，避免改名后旧 user_id 查不到。
  const oldQqBindings = await db.select().from(qqBindings)
    .where(eq(qqBindings.user_id, oldUsername)).all()
  for (const b of oldQqBindings) {
    stopBotForUser(oldUsername, b.agent_id)
  }
  await db.update(qqBindings).set({ user_id: newName }).where(eq(qqBindings.user_id, oldUsername)).run()
  for (const b of oldQqBindings) {
    void startBotForUser(newName, b.agent_id).catch((e) => {
      console.error(`[qq] failed to restart bot after rename ${oldUsername} → ${newName} agent=${b.agent_id}:`, e instanceof Error ? e.message : e)
    })
  }

  const result = await signUserToken(newName)
  setAuthCookie(c, result.token)
  return c.json({ username: newName, expires_at: result.expires_at })
})

// ---- OAuth2 bindings (linked accounts) ----

userRoute.get('/oauth-bindings', userAuthMiddleware, async (c) => {
  const username = (c as any).get('userId') as string
  const bindings = await db.select({
    id: userOauthBindings.id,
    provider_id: userOauthBindings.provider_id,
    created_at: userOauthBindings.created_at,
  }).from(userOauthBindings).where(eq(userOauthBindings.user_id, username)).all()
  return c.json({ bindings })
})

userRoute.delete('/oauth-bindings/:id', userAuthMiddleware, async (c) => {
  const username = (c as any).get('userId') as string
  const bindingId = c.req.param('id')

  const binding = await db.select().from(userOauthBindings).where(eq(userOauthBindings.id, bindingId)).get()
  if (!binding) throw new ApiError(ErrCode.USER_BINDING_NOT_FOUND)
  if (binding.user_id !== username) throw new ApiError(ErrCode.USER_BINDING_NOT_OWNED)

  // Ensure at least one login method remains (PIN or other binding)
  const userRow = await db.select().from(users).where(eq(users.username, username)).get()
  const allBindings = await db.select().from(userOauthBindings)
    .where(eq(userOauthBindings.user_id, username)).all()
  const otherBindings = allBindings.filter((b: { id: string }) => b.id !== bindingId)
  if (!userRow?.pin_hash && otherBindings.length === 0) {
    throw new ApiError(ErrCode.USER_CANNOT_REMOVE_ONLY_LOGIN)
  }

  await db.delete(userOauthBindings).where(eq(userOauthBindings.id, bindingId)).run()
  return c.json({ success: true })
})