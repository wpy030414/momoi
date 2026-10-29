import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { randomBytes, randomUUID } from 'crypto'
import { ErrCode, type ErrParams } from '@momoi/shared/errors'
import type { OidcProvider } from '@momoi/shared/types'
import { db, users, userOidcBindings } from '../db/index.js'
import { eq, and } from 'drizzle-orm'
import { getConfig, isOidcRegistrationOpen } from '../lib/config.js'
import { signUserToken, setAuthCookie, getAuthToken, verifyUserToken, verifyPin, hashPin } from '../lib/auth.js'
import { ApiError } from '../lib/apiError.js'
import { resolveEndpoints, type ResolvedEndpoints } from '../lib/oidc-discovery.js'
import { verifyIdToken, OidcVerifyError } from '../lib/oidc-verify.js'

export const oidcRoute = new Hono()

const COOKIE_PATH = '/api/oidc'
const STATE_COOKIE = 'momoi_oidc_state'
const PROVIDER_COOKIE = 'momoi_oidc_provider'
const ORIGIN_COOKIE = 'momoi_oidc_origin'

/**
 * 回调失败统一出口：清理 OIDC 临时 cookie 后 302 回 SPA。
 * 错误码经 ?oidc_error_code=<CODE> 传递；params.detail 存在时追加
 * oidc_error_detail（URL 序列化自动 percent-encode）。
 */
function fail(c: Context, code: ErrCode, params?: ErrParams) {
  const savedOrigin = getCookie(c, ORIGIN_COOKIE)
  const spaOrigin = savedOrigin || new URL(c.req.url).origin
  deleteCookie(c, STATE_COOKIE, { path: COOKIE_PATH })
  deleteCookie(c, PROVIDER_COOKIE, { path: COOKIE_PATH })
  deleteCookie(c, ORIGIN_COOKIE, { path: COOKIE_PATH })
  const url = new URL('/', spaOrigin)
  url.searchParams.set('oidc_error_code', code)
  if (params?.detail !== undefined) {
    url.searchParams.set('oidc_error_detail', String(params.detail))
  }
  return c.redirect(url.toString())
}

/** 解析 Provider 端点。discovery 失败 / issuer 不一致统一转成 PROVIDER_ERROR。 */
async function resolveOrFail(c: Context, provider: OidcProvider): Promise<ResolvedEndpoints | Response> {
  try {
    return await resolveEndpoints(provider)
  } catch (err) {
    console.error('[oidc] resolve endpoints failed:', err)
    return fail(c, ErrCode.OIDC_PROVIDER_ERROR, {
      detail: err instanceof Error ? err.message : 'discovery failed',
    })
  }
}

/** 确保 scope 含 openid —— OIDC 硬性要求，管理员没写也补上 */
function ensureOpenidScope(scopes: string | undefined): string {
  const list = (scopes ?? '').split(/\s+/).filter(Boolean)
  if (!list.includes('openid')) list.unshift('openid')
  return list.join(' ')
}

oidcRoute.get('/providers', async (c) => {
  const config = await getConfig()
  return c.json({ providers: config.oidc_providers.map((p) => ({ id: p.id, name: p.name })) })
})

oidcRoute.get('/:providerId/login', async (c) => {
  const providerId = c.req.param('providerId')
  const config = await getConfig()
  const provider = config.oidc_providers.find((p) => p.id === providerId)
  if (!provider) throw new ApiError(ErrCode.OIDC_UNKNOWN_PROVIDER)

  const state = randomBytes(32).toString('hex')
  const cookieBase = { httpOnly: true, sameSite: 'Lax' as const, path: COOKIE_PATH, maxAge: 600 }
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
  const redirectUri = `${baseOrigin}${COOKIE_PATH}/callback`

  const endpoints = await resolveOrFail(c, provider)
  if (endpoints instanceof Response) return endpoints

  const params = new URLSearchParams({
    client_id: provider.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: ensureOpenidScope(provider.scopes),
    state,
  })
  return c.redirect(`${endpoints.authorization_endpoint}?${params.toString()}`)
})

oidcRoute.get('/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')
  const storedState = getCookie(c, STATE_COOKIE) || null
  const providerId = getCookie(c, PROVIDER_COOKIE) || null
  const savedOrigin = getCookie(c, ORIGIN_COOKIE) || null
  const spaOrigin = savedOrigin || new URL(c.req.url).origin

  const cleanupCookies = () => {
    deleteCookie(c, STATE_COOKIE, { path: COOKIE_PATH })
    deleteCookie(c, PROVIDER_COOKIE, { path: COOKIE_PATH })
    deleteCookie(c, ORIGIN_COOKIE, { path: COOKIE_PATH })
  }

  if (error) return fail(c, ErrCode.OIDC_PROVIDER_ERROR, { detail: error })
  if (!state || !storedState || state !== storedState) return fail(c, ErrCode.OIDC_INVALID_STATE)
  if (!code) return fail(c, ErrCode.OIDC_NO_AUTH_CODE)
  if (!providerId) return fail(c, ErrCode.OIDC_UNKNOWN_PROVIDER)

  const config = await getConfig()
  const provider = config.oidc_providers.find((p) => p.id === providerId)
  if (!provider) return fail(c, ErrCode.OIDC_UNKNOWN_PROVIDER)

  const endpoints = await resolveOrFail(c, provider)
  if (endpoints instanceof Response) return endpoints

  const redirectUri = `${spaOrigin}${COOKIE_PATH}/callback`

  try {
    // ---- 1. code → token ----
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    })
    // client_secret_post：client_id / client_secret 放 body（参考 Provider 与多数 OIDC 的默认方式）
    if (endpoints.tokenAuthMethods.length === 0 || endpoints.tokenAuthMethods.includes('client_secret_post')) {
      tokenBody.set('client_id', provider.client_id)
      tokenBody.set('client_secret', provider.client_secret)
    }

    const tokenRes = await fetch(endpoints.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: tokenBody.toString(),
    })
    const tokenData = await tokenRes.json() as Record<string, unknown>
    if (!tokenRes.ok) {
      return fail(c, ErrCode.OIDC_TOKEN_EXCHANGE_FAILED, { detail: JSON.stringify(tokenData) })
    }

    // ---- 2. 身份：优先验签 id_token，无 id_token 则回退 userinfo ----
    let remoteId: string | null = null
    let identityName = ''
    let identityPicture = ''

    const idToken = typeof tokenData.id_token === 'string' ? tokenData.id_token : null
    if (idToken) {
      try {
        const claims = await verifyIdToken({
          idToken,
          clientSecret: provider.client_secret,
          issuer: provider.issuer,
          clientId: provider.client_id,
          signingAlgs: endpoints.signingAlgs,
          jwksUri: endpoints.jwks_uri,
        })
        remoteId = claims.sub
        identityName = claims.name ?? ''
        identityPicture = claims.picture ?? ''
      } catch (err) {
        console.error('[oidc] id_token verify failed:', err)
        return fail(c, ErrCode.OIDC_ID_TOKEN_INVALID, {
          detail: err instanceof OidcVerifyError ? err.message : 'id_token invalid',
        })
      }
    } else {
      // 非标准 Provider 兜底：userinfo 端点
      const accessToken = tokenData.access_token as string | undefined
      if (!accessToken) return fail(c, ErrCode.OIDC_TOKEN_EXCHANGE_FAILED, { detail: JSON.stringify(tokenData) })
      if (!endpoints.userinfo_endpoint) {
        return fail(c, ErrCode.OIDC_PROVIDER_ERROR, { detail: 'no id_token and no userinfo_endpoint' })
      }
      const userRes = await fetch(endpoints.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const userData = await userRes.json() as Record<string, unknown>
      const sub = userData.sub
      if (typeof sub !== 'string' || !sub) {
        return fail(c, ErrCode.OIDC_PROVIDER_ERROR, { detail: 'userinfo has no sub' })
      }
      remoteId = sub
      identityName = String(userData.name ?? '')
      identityPicture = String(userData.picture ?? '')
    }

    if (!remoteId) return fail(c, ErrCode.OIDC_PROVIDER_ERROR, { detail: 'identity unresolved' })

    // ---- 3. 三态决策 ----
    const binding = await db.select().from(userOidcBindings)
      .where(and(eq(userOidcBindings.provider_id, providerId), eq(userOidcBindings.provider_user_id, remoteId)))
      .get()

    if (binding) {
      // 已有绑定 → 直接登录
      const userRow = await db.select().from(users).where(eq(users.username, binding.user_id)).get()
      if (!userRow) return fail(c, ErrCode.OIDC_LINKED_USER_NOT_FOUND)
      if (userRow.banned) return fail(c, ErrCode.USER_DISABLED)

      const now = Math.floor(Date.now() / 1000)
      await db.update(users).set({ last_login_at: now }).where(eq(users.username, binding.user_id)).run()

      const result = await signUserToken(binding.user_id)
      setAuthCookie(c, result.token)
      cleanupCookies()

      const spaUrl = new URL('/', spaOrigin)
      spaUrl.searchParams.set('oidc_user', binding.user_id)
      spaUrl.searchParams.set('oidc_expires', String(result.expires_at))
      return c.redirect(spaUrl.toString())
    }

    // 无绑定 → 若当前已登录则自动绑定到当前账户
    const existingToken = getAuthToken(c)
    if (existingToken) {
      const jwtResult = await verifyUserToken(existingToken)
      if (jwtResult) {
        const now = Math.floor(Date.now() / 1000)
        await db.insert(userOidcBindings).values({
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

    // 全新 OIDC 用户 → 注册页（开启）或错误
    cleanupCookies()

    const oidcRegOpen = await isOidcRegistrationOpen()
    if (!oidcRegOpen) {
      return fail(c, ErrCode.OIDC_REGISTRATION_CLOSED)
    }

    const spaUrl = new URL('/', spaOrigin)
    spaUrl.searchParams.set('oidc_register', '1')
    spaUrl.searchParams.set('provider_id', providerId)
    spaUrl.searchParams.set('provider_user_id', remoteId)
    if (identityName) spaUrl.searchParams.set('provider_name', identityName)
    if (identityPicture) spaUrl.searchParams.set('provider_picture', identityPicture)
    return c.redirect(spaUrl.toString())
  } catch (err) {
    // 原始异常只进服务端日志；wire（302 query）仅透传 err.message 摘要
    console.error('[oidc] callback failed:', err)
    return fail(c, ErrCode.OIDC_PROVIDER_ERROR, {
      detail: err instanceof Error ? err.message : 'Unknown error',
    })
  }
})

// POST /api/oidc/register — 完成 OIDC 注册（绑定已有账户或创建新账户）
oidcRoute.post('/register', async (c) => {
  const body = await c.req.json<{
    provider_id: string
    provider_user_id: string
    action: 'link' | 'create'
    username: string
    pin: string
  }>()
  const { provider_id, provider_user_id, action, username, pin } = body

  if (!provider_id || !provider_user_id || !action || !username || !pin) {
    throw new ApiError(ErrCode.OIDC_MISSING_FIELDS)
  }
  if (!/^\d{4,8}$/.test(pin)) {
    throw new ApiError(ErrCode.USER_PIN_FORMAT)
  }

  // 防竞态重复绑定
  const existingBinding = await db.select().from(userOidcBindings)
    .where(and(eq(userOidcBindings.provider_id, provider_id), eq(userOidcBindings.provider_user_id, provider_user_id)))
    .get()
  if (existingBinding) throw new ApiError(ErrCode.OIDC_ALREADY_LINKED)

  const now = Math.floor(Date.now() / 1000)

  if (action === 'link') {
    // 绑定：校验已有账户的 PIN
    const userRow = await db.select().from(users).where(eq(users.username, username)).get()
    if (!userRow) throw new ApiError(ErrCode.OIDC_ACCOUNT_NOT_FOUND)
    if (!userRow.pin_hash) throw new ApiError(ErrCode.OIDC_ACCOUNT_NO_PIN)
    if (userRow.banned) throw new ApiError(ErrCode.USER_DISABLED)
    if (!verifyPin(pin, userRow.pin_hash)) throw new ApiError(ErrCode.AUTH_INVALID_PIN)

    await db.insert(userOidcBindings).values({
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

  // 创建：新账户 + OIDC 绑定
  const oidcOpen = await isOidcRegistrationOpen()
  if (!oidcOpen) {
    throw new ApiError(ErrCode.OIDC_REGISTRATION_CLOSED)
  }

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

  await db.insert(userOidcBindings).values({
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