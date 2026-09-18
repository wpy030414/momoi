import type { Context, Next } from 'hono'
import { STAND_ALONE } from '../lib/standalone.js'
import { verifyUserToken, getAuthToken } from '../lib/auth.js'

/**
 * User auth middleware — validates the JWT from the HttpOnly cookie
 * `momoi_token` (the sole credential transport).  Sets `userId` in context
 * for downstream routes.
 * In stand-alone mode there is no JWT and no cookie: the identity is the
 * fixed 'admin' user and the middleware passes straight through.
 */
export async function userAuthMiddleware(c: Context, next: Next) {
  if (STAND_ALONE) {
    c.set('userId', 'admin')
    await next()
    return
  }
  const token = getAuthToken(c)
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401)
  }
  const result = await verifyUserToken(token)
  if (!result) {
    return c.json({ error: 'Invalid token' }, 401)
  }
  c.set('userId', result.username)
  await next()
}
