import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { randomBytes, randomUUID } from 'crypto'
import { ErrCode, type ErrParams } from '@momoi/shared/errors'
import { db, users, userOauthBindings } from '../db/index.js'
import { eq, and } from 'drizzle-orm'
import { getConfig, isOauthRegistrationOpen } from '../lib/config.js'
import { signUserToken, setAuthCookie, getAuthToken, verifyUserToken, verifyPin, hashPin } from '../lib/auth.js'
import { ApiError } from '../lib/apiError.js'

export const oauthRoute = new Hono()

const STATE_COOKIE = 'momoi_oauth_state'
const PROVIDER_COOKIE = 'momoi_oauth_provider'
const ORIGIN_COOKIE = 'momoi_oauth_origin'

/**
 * 回调失败统一出口：清理 OAuth 临时 cookie 后 302 回 SPA。
 * 错误码经 ?oauth_error_code=<CODE> 传递；params.detail 存在时追加
 * oauth_error_detail（URL 序列化自动 percent-encode）。
 */
function fail(c: Context, code: ErrCode, params?: ErrParams) {
  const savedOrigin = getCookie(c, ORIGIN_COOKIE)
  const spaOrigin = savedOrigin || new URL(c.req.url).origin
  deleteCookie(c, STATE_COOKIE, { path: '/api/oauth' })
  deleteCookie(c, PROVIDER_COOKIE, { path: '/api/oauth' })
  deleteCookie(c, ORIGIN_COOKIE, { path: '/api/oauth' })
  const url = new URL('/', spaOrigin)
  url.searchParams.set('oauth_error_code', code)
  if (params?.detail !== undefined) {
    url.searchParams.set('oauth_error_detail', String(params.detail))
  }
  return c.redirect(url.toString())
}

oauthRoute.get('/providers', async (c) => {
  const config = await getConfig()
  return c.json({ providers: config.oauth_providers.map((p) => ({ id: p.id, name: p.name })) })
})

oauthRoute.get('/:providerId/login', async (c) => {
  const providerId = c.req.param('providerId')
  const config = await getConfig()
  const provider = config.oauth_providers.find((p) => p.id === providerId)
  if (!provider) throw new ApiError(ErrCode.OAUTH_UNKNOWN_PROVIDER)

  const state = randomBytes(32).toString('hex')
  const cookieBase = { httpOnly: true, sameSite: 'Lax' as const, path: '/api/oauth', maxAge: 600 }
  setCookie(c, STATE_COOKIE, state, cookieBase)
  setCookie(c, PROVIDER_COOKIE, providerId, cookieBase)

  // Use Referer to determine the SPA origin — in dev mode the request arrives
  // through the Vite proxy so c.req.url gives the backend port.  The Referer
  // header carries the real browser-facing origin.
  let spaOrigin = ''
  try {
    const referer = c.req.header('Referer')
    if (referer) spaOrigin = new URL(referer).origin
  } catch { /* keep empty */ }
  if (spaOrigin) setCookie(c, ORIGIN_COOKIE, spaOrigin, cookieBase)
  const baseOrigin = spaOrigin || new URL(c.req.url).origin

  const params = new URLSearchParams({
    client_id: provider.client_id,
    redirect_uri: `${baseOrigin}/api/oauth/callback`,
    response_type: 'code',
    scope: provider.scopes,
    state,
  })
  return c.redirect(`${provider.authorize_url}?${params.toString()}`)
})

oauthRoute.get('/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')
  const storedState = getCookie(c, STATE_COOKIE) || null
  const providerId = getCookie(c, PROVIDER_COOKIE) || null
  const savedOrigin = getCookie(c, ORIGIN_COOKIE) || null
  const spaOrigin = savedOrigin || new URL(c.req.url).origin

  const cleanupCookies = () => {
    deleteCookie(c, STATE_COOKIE, { path: '/api/oauth' })
    deleteCookie(c, PROVIDER_COOKIE, { path: '/api/oauth' })
    deleteCookie(c, ORIGIN_COOKIE, { path: '/api/oauth' })
  }

  if (error) return fail(c, ErrCode.OAUTH_PROVIDER_ERROR, { detail: error })
  if (!state || !storedState || state !== storedState) return fail(c, ErrCode.OAUTH_INVALID_STATE)
  if (!code) return fail(c, ErrCode.OAUTH_NO_AUTH_CODE)
  if (!providerId) return fail(c, ErrCode.OAUTH_UNKNOWN_PROVIDER)

  const config = await getConfig()
  const provider = config.oauth_providers.find((p) => p.id === providerId)
  if (!provider) return fail(c, ErrCode.OAUTH_UNKNOWN_PROVIDER)

  try {
    const tokenRes = await fetch(provider.token_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code,
        client_id: provider.client_id, client_secret: provider.client_secret,
        redirect_uri: `${spaOrigin}/api/oauth/callback`,
      }).toString(),
    })
    const tokenData = await tokenRes.json() as Record<string, unknown>
    const accessToken = tokenData.access_token as string | undefined
    if (!accessToken) return fail(c, ErrCode.OAUTH_TOKEN_EXCHANGE_FAILED, { detail: JSON.stringify(tokenData) })

    const userRes = await fetch(provider.userinfo_url, { headers: { Authorization: `Bearer ${accessToken}` } })
    const userData = await userRes.json() as Record<string, unknown>
    const remoteId = String(userData.sub || userData.id || userData.user_id || randomUUID())

    // 1. Check if this OAuth identity already has a binding
    const binding = await db.select().from(userOauthBindings)
      .where(and(eq(userOauthBindings.provider_id, providerId), eq(userOauthBindings.provider_user_id, remoteId)))
      .get()

    if (binding) {
      // Existing binding → login directly
      const userRow = await db.select().from(users).where(eq(users.username, binding.user_id)).get()
      if (!userRow) return fail(c, ErrCode.OAUTH_LINKED_USER_NOT_FOUND)
      if (userRow.banned) return fail(c, ErrCode.USER_DISABLED)

      const now = Math.floor(Date.now() / 1000)
      await db.update(users).set({ last_login_at: now }).where(eq(users.username, binding.user_id)).run()

      const result = await signUserToken(binding.user_id)
      setAuthCookie(c, result.token)
      cleanupCookies()

      const spaUrl = new URL('/', spaOrigin)
      spaUrl.searchParams.set('oauth_user', binding.user_id)
      spaUrl.searchParams.set('oauth_expires', String(result.expires_at))
      return c.redirect(spaUrl.toString())
    }

    // 2. No binding — check if user is logged in (link to existing account)
    const existingToken = getAuthToken(c)
    if (existingToken) {
      const jwtResult = await verifyUserToken(existingToken)
      if (jwtResult) {
        // Already logged in → bind OAuth to current account
        const now = Math.floor(Date.now() / 1000)
        await db.insert(userOauthBindings).values({
          id: randomUUID(),
          user_id: jwtResult.username,
          provider_id: providerId,
          provider_user_id: remoteId,
          created_at: now,
        }).run()

        await db.update(users).set({ last_login_at: now }).where(eq(users.username, jwtResult.username)).run()

        cleanupCookies()
        return c.redirect('/')
      }
    }

    // 3. Totally new OAuth user → registration page (if open) or error
    cleanupCookies()

    const oauthRegOpen = await isOauthRegistrationOpen()
    if (!oauthRegOpen) {
      return fail(c, ErrCode.OAUTH_REGISTRATION_CLOSED)
    }

    const spaUrl = new URL('/', spaOrigin)
    spaUrl.searchParams.set('oauth_register', '1')
    spaUrl.searchParams.set('provider_id', providerId)
    spaUrl.searchParams.set('provider_user_id', remoteId)
    return c.redirect(spaUrl.toString())
  } catch (err) {
    // 原始异常只进服务端日志；wire（302 query）仅透传 err.message 摘要
    console.error('[oauth] callback failed:', err)
    return fail(c, ErrCode.OAUTH_PROVIDER_ERROR, {
      detail: err instanceof Error ? err.message : 'Unknown error',
    })
  }
})

// POST /api/oauth/register — complete OAuth registration (link existing or create new)
oauthRoute.post('/register', async (c) => {
  const body = await c.req.json<{
    provider_id: string
    provider_user_id: string
    action: 'link' | 'create'
    username: string
    pin: string
  }>()
  const { provider_id, provider_user_id, action, username, pin } = body

  if (!provider_id || !provider_user_id || !action || !username || !pin) {
    throw new ApiError(ErrCode.OAUTH_MISSING_FIELDS)
  }
  if (!/^\d{4,8}$/.test(pin)) {
    throw new ApiError(ErrCode.USER_PIN_FORMAT)
  }

  // Prevent re-binding an already-bound OAuth identity
  const existingBinding = await db.select().from(userOauthBindings)
    .where(and(eq(userOauthBindings.provider_id, provider_id), eq(userOauthBindings.provider_user_id, provider_user_id)))
    .get()
  if (existingBinding) throw new ApiError(ErrCode.OAUTH_ALREADY_LINKED)

  const now = Math.floor(Date.now() / 1000)

  if (action === 'link') {
    // Link: verify existing password + PIN, then add binding
    const userRow = await db.select().from(users).where(eq(users.username, username)).get()
    if (!userRow) throw new ApiError(ErrCode.OAUTH_ACCOUNT_NOT_FOUND)
    if (!userRow.pin_hash) throw new ApiError(ErrCode.OAUTH_ACCOUNT_NO_PIN)
    if (userRow.banned) throw new ApiError(ErrCode.USER_DISABLED)
    if (!verifyPin(pin, userRow.pin_hash)) throw new ApiError(ErrCode.AUTH_INVALID_PIN)

    await db.insert(userOauthBindings).values({
      id: randomUUID(),
      user_id: username,
      provider_id,
      provider_user_id,
      created_at: now,
    }).run()

    await db.update(users).set({ last_login_at: now }).where(eq(users.username, username)).run()

    const result = await signUserToken(username)
    setAuthCookie(c, result.token)
    return c.json({ username, expires_at: result.expires_at })
  }

  // Check OAuth registration gate for new account creation
  const oauthOpen = await isOauthRegistrationOpen()
  if (!oauthOpen) {
    throw new ApiError(ErrCode.OAUTH_REGISTRATION_CLOSED)
  }

  // Create: new account with PIN + OAuth binding
  const existingUser = await db.select().from(users).where(eq(users.username, username)).get()
  if (existingUser) throw new ApiError(ErrCode.USER_NAME_TAKEN)

  const hashed = hashPin(pin)
  await db.insert(users).values({
    username,
    pin_hash: hashed,
    first_login_at: now,
    last_login_at: now,
    banned: false,
  }).run()

  await db.insert(userOauthBindings).values({
    id: randomUUID(),
    user_id: username,
    provider_id,
    provider_user_id,
    created_at: now,
  }).run()

  const result = await signUserToken(username)
  setAuthCookie(c, result.token)
  return c.json({ username, expires_at: result.expires_at })
})