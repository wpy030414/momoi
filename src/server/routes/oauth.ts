import { Hono } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { randomBytes } from 'crypto'
import { db, users } from '../db.js'
import { eq } from 'drizzle-orm'
import { getConfig } from '../config.js'
import { signUserToken, setAuthCookie } from '../auth.js'

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
    const remoteId = String(userData.sub || userData.id || userData.user_id || 'unknown')
    const username = `oauth:${providerId}:${remoteId}`

    const now = Math.floor(Date.now() / 1000)
    const existing = await db.select().from(users).where(eq(users.username, username)).get()
    if (existing) {
      if (existing.banned) return fail('Account is disabled')
      await db.update(users).set({ last_login_at: now }).where(eq(users.username, username)).run()
    } else {
      await db.insert(users).values({ username, pin_hash: '', first_login_at: now, last_login_at: now, banned: false }).run()
    }

    const result = await signUserToken(username)
    setAuthCookie(c, result.token)
    deleteCookie(c, STATE_COOKIE, { path: '/api/oauth' })
    deleteCookie(c, PROVIDER_COOKIE, { path: '/api/oauth' })

    const spaUrl = new URL('/', spaOrigin)
    spaUrl.searchParams.set('oauth_user', username)
    spaUrl.searchParams.set('oauth_expires', String(result.expires_at))
    return c.redirect(spaUrl.toString())
  } catch (err) {
    return fail(`OAuth error: ${err instanceof Error ? err.message : 'Unknown error'}`)
  }
})