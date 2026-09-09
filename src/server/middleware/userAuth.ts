import type { Context, Next } from 'hono'
import { verifyUserToken, getAuthToken } from '../auth.js'

/**
 * User auth middleware — validates the JWT from the HttpOnly cookie
 * (or the Authorization Bearer header, kept as a fallback for API clients),
 * sets `userId` in context for downstream routes.
 */
export async function userAuthMiddleware(c: Context, next: Next) {
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
