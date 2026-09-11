import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { randomBytes, randomUUID } from 'crypto'
import { db, users, userOauthBindings } from '../db.js'
import { eq, and } from 'drizzle-orm'
import { getConfig } from '../config.js'
import { signUserToken, setAuthCookie, getAuthToken, verifyUserToken, verifyPin, hashPin } from '../auth.js'

export const oauthRoute = new Hono()

const STATE_COOKIE = 'momoi_oauth_state'
const PROVIDER_COOKIE = 'momoi_oauth_provider'

oauthRoute.get('/providers', async (c) => {
  const config = await getConfig()
  return c.json({ providers: config.oauth_providers.map((p) => ({ id: p.id, name: p.name })) })
})

oauthRoute.get('/:providerId/login', async (c) => {
  const providerId = c.req.param('providerId')
  const config = await getConfig()
  const provider = config.oauth_providers.find((p) => p.id === providerId)
  if (!provider) return c.json({ error: 'Unknown OAuth2 provider' }, 404)

  const state = randomBytes(32).toString('hex')
  const cookieBase = { httpOnly: true, sameSite: 'Lax' as const, path: '/api/oauth', maxAge: 600 }
  setCookie(c, STATE_COOKIE, state, cookieBase)
  setCookie(c, PROVIDER_COOKIE, providerId, cookieBase)

  const params = new URLSearchParams({
    client_id: provider.client_id,
    redirect_uri: `${new URL(c.req.url).origin}/api/oauth/callback`,
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
  const spaOrigin = new URL(c.req.url).origin

  const fail = (msg: string) => {
    deleteCookie(c, STATE_COOKIE, { path: '/api/oauth' })
    deleteCookie(c, PROVIDER_COOKIE, { path: '/api/oauth' })
    const url = new URL('/', spaOrigin)
    url.searchParams.set('oauth_error', msg)
    return c.redirect(url.toString())
  }

  if (error) return fail(error)
  if (!state || !storedState || state !== storedState) return fail('Invalid state')
  if (!code) return fail('No authorization code')
  if (!providerId) return fail('Unknown provider')

  const config = await getConfig()
  const provider = config.oauth_providers.find((p) => p.id === providerId)
  if (!provider) return fail('Provider not found')

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
    if (!accessToken) return fail(`Token exchange failed: ${JSON.stringify(tokenData)}`)

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
      if (!userRow) return fail('Linked user account not found')
      if (userRow.banned) return fail('Account is disabled')

      const now = Math.floor(Date.now() / 1000)
      await db.update(users).set({ last_login_at: now }).where(eq(users.username, binding.user_id)).run()

      const result = await signUserToken(binding.user_id)
      setAuthCookie(c, result.token)
      deleteCookie(c, STATE_COOKIE, { path: '/api/oauth' })
      deleteCookie(c, PROVIDER_COOKIE, { path: '/api/oauth' })

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

        deleteCookie(c, STATE_COOKIE, { path: '/api/oauth' })
        deleteCookie(c, PROVIDER_COOKIE, { path: '/api/oauth' })
        return c.redirect('/')
      }
    }

    // 3. Totally new OAuth user → redirect to registration page
    deleteCookie(c, STATE_COOKIE, { path: '/api/oauth' })
    deleteCookie(c, PROVIDER_COOKIE, { path: '/api/oauth' })

    const spaUrl = new URL('/', spaOrigin)
    spaUrl.searchParams.set('oauth_register', '1')
    spaUrl.searchParams.set('provider_id', providerId)
    spaUrl.searchParams.set('provider_user_id', remoteId)
    return c.redirect(spaUrl.toString())
  } catch (err) {
    return fail(`OAuth error: ${err instanceof Error ? err.message : 'Unknown error'}`)
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
    return c.json({ error: 'Missing required fields' }, 400)
  }
  if (!/^\d{4,8}$/.test(pin)) {
    return c.json({ error: 'PIN must be 4-8 digits' }, 400)
  }

  // Prevent re-binding an already-bound OAuth identity
  const existingBinding = await db.select().from(userOauthBindings)
    .where(and(eq(userOauthBindings.provider_id, provider_id), eq(userOauthBindings.provider_user_id, provider_user_id)))
    .get()
  if (existingBinding) return c.json({ error: 'This OAuth account is already linked' }, 409)

  const now = Math.floor(Date.now() / 1000)

  if (action === 'link') {
    // Link: verify existing password + PIN, then add binding
    const userRow = await db.select().from(users).where(eq(users.username, username)).get()
    if (!userRow) return c.json({ error: 'Account not found' }, 404)
    if (!userRow.pin_hash) return c.json({ error: 'Account has no PIN set' }, 400)
    if (userRow.banned) return c.json({ error: 'Account is disabled' }, 403)
    if (!verifyPin(pin, userRow.pin_hash)) return c.json({ error: 'Invalid PIN' }, 401)

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

  // Create: new account with PIN + OAuth binding
  const existingUser = await db.select().from(users).where(eq(users.username, username)).get()
  if (existingUser) return c.json({ error: 'Username already taken' }, 409)

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