import type { Context, Next } from 'hono'
import { ErrCode } from '@momoi/shared/errors'
import { STAND_ALONE } from '../lib/standalone.js'
import { verifyUserToken, getAuthToken } from '../lib/auth.js'
import { ApiError } from '../lib/apiError.js'

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
    throw new ApiError(ErrCode.UNAUTHORIZED)
  }
  const result = await verifyUserToken(token)
  if (!result) {
    throw new ApiError(ErrCode.AUTH_INVALID_TOKEN)
  }
  c.set('userId', result.username)
  await next()
}
