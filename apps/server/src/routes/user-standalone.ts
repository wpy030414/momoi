import { Hono } from 'hono'

// Stand-alone mode user API: the identity is fixed to 'admin' and every other
// /api/user/* endpoint (status/verify/set-pin/change-pin/rename/logout/refresh/
// oauth-bindings) intentionally does not exist in this mode (404) — no PIN, no
// JWT, no cookie can be issued. This router deliberately imports nothing else
// (no db, no auth, no rate limiter) so the multi-user router stays untouched.
export const standAloneUserRoute = new Hono()

standAloneUserRoute.get('/me', (c) => {
  return c.json({ username: 'admin', is_admin: true })
})
