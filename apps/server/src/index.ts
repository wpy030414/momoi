import './lib/env.js'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ErrCode } from '@momoi/shared/errors'

import { env, bootstrapAgents } from './lib/config.js'
import { ApiError } from './lib/apiError.js'
import { STAND_ALONE } from './lib/standalone.js'
import { db, users } from './db/index.js'

// Stand-alone mode: seed the fixed 'admin' user row (idempotent) so the users
// table (and /api/admin/stats' total_users) reflects the single fixed identity.
if (STAND_ALONE) {
  const now = Math.floor(Date.now() / 1000)
  await db.insert(users)
    .values({ username: 'admin', pin_hash: '', first_login_at: now, last_login_at: now, banned: false })
    .onConflictDoNothing()
    .run()
}

// Ensure neutral agent + at least one non-neutral agent exist on every startup.
await bootstrapAgents()

import { conversationsRoute } from './routes/conversations.js'
import { adminRoute } from './routes/admin.js'
import { appRoute } from './routes/app.js'
import { chatRoute } from './routes/chat.js'
import { uploadRoute } from './routes/upload.js'
import { userRoute } from './routes/user.js'
import { standAloneUserRoute } from './routes/user-standalone.js'
import { workspaceRoute } from './routes/workspace.js'
import { groupRoute } from './routes/group.js'
import { worldsRoute } from './routes/worlds.js'
import { oauthRoute } from './routes/oauth.js'
import { assetsRoute } from './routes/assets.js'
import { voiceRoute } from './routes/voice.js'
import { wechatRoute } from './routes/wechat.js'
import { qqRoute } from './routes/qq.js'
import { eventsRoute } from './routes/events.js'
import { docsRoute } from './routes/docs.js'
import { memoriesRoute } from './routes/memories.js'
import { pushNotificationRoute } from './routes/push-notification.js'
import { serveClient } from './lib/static.js'
import { startWechatPoller } from './im/wechat/poller.js'
import { initQqBots } from './im/qq/manager.js'

const app = new Hono()

// Middleware — allow all origins in dev (Vite runs on 5173)
app.use('*', logger())
app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization', 'X-User'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}))

// 错误序列化收口——wire 上只有 { code, params }（不发 message，详见 docs/specs/module-errors.md）
app.onError((err, c) => {
  if (err instanceof ApiError) {
    if (err.status >= 500) {
      console.error(`[api] ${err.code}${err.log ? `: ${err.log}` : ''}`, err.cause ?? '')
    }
    return c.json({ code: err.code, ...(err.params ? { params: err.params } : {}) }, err.status as ContentfulStatusCode)
  }
  // 未捕获异常：完整堆栈只进日志，绝不透传给客户端
  console.error('[api] unhandled:', err)
  return c.json({ code: ErrCode.INTERNAL }, 500)
})

// API 路由未匹配 → JSON 错误体；非 API 路径维持默认纯文本（生产下由静态托管兜底 SPA）
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ code: ErrCode.NOT_FOUND }, 404)
  }
  // 不能调 c.notFound()（会递归自身），等价于 Hono 默认 404
  return new Response('404 Not Found', { status: 404 })
})

// API Routes
app.route('/api/conversations', conversationsRoute)
app.route('/api/admin', adminRoute)
app.route('/api/app-name', appRoute)
app.route('/api/chat', chatRoute)
app.route('/api/upload', uploadRoute)
// Stand-alone mode: the fixed 'admin' identity has no PIN/JWT/cookie, so only
// the minimal /me endpoint exists. WeChat/QQ bridge routes stay mounted —
// binding is an IM capability, not Momoi auth, and binds to the 'admin' user.
app.route('/api/user', STAND_ALONE ? standAloneUserRoute : userRoute)
app.route('/api/workspace', workspaceRoute)
app.route('/api/group', groupRoute)
app.route('/api/worlds', worldsRoute)
if (!STAND_ALONE) {
  // OAuth login is part of the Momoi auth stack — not offered in stand-alone.
  app.route('/api/oauth', oauthRoute)
}
app.route('/api/assets', assetsRoute)
app.route('/api/voice', voiceRoute)
app.route('/api/wechat', wechatRoute)
app.route('/api/qq', qqRoute)
app.route('/api/events', eventsRoute)
app.route('/api/docs', docsRoute)
// User-facing memory management — independent prefix (not inside the /api/user
// stand-alone fork), so it works in both normal and stand-alone modes.
app.route('/api/memories', memoriesRoute)
app.route('/api/push-notification', pushNotificationRoute)

// Static files — production only (dev mode uses Vite proxy)
if (process.env.NODE_ENV === 'production') {
  app.use('*', serveClient)
}

// Start server
serve({
  fetch: app.fetch,
  port: env.PORT,
  hostname: '0.0.0.0',
})

// Start WeChat message poller (non-blocking, timer-based)
startWechatPoller()

// Restore QQ bot gateway connections for all bound users (non-blocking)
void initQqBots().catch((e) => console.error('[qq] restore failed:', e instanceof Error ? e.message : e))

// Banner — use visual-width-aware padding so CJK characters align properly in terminal
const visualWidth = (s: string): number => {
  let w = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0)!
    // ASCII / Latin-1 / Box Drawing → 1 column; everything else (CJK, fullwidth, emoji, …) → 2 columns
    w += (cp <= 0xFF || (cp >= 0x2500 && cp <= 0x257F)) ? 1 : 2
  }
  return w
}
const padVisual = (s: string, cols: number) => s + ' '.repeat(Math.max(0, cols - visualWidth(s)))
const contentCols = 34

console.log(`
╔══════════════════════════════════════╗
║  ${padVisual("Momoi AGI", contentCols)}  ║
║  ${padVisual(`http://localhost:${env.PORT}`, contentCols)}  ║
║  ${padVisual("----------------------------------", contentCols)}  ║
║  ${padVisual(STAND_ALONE
  ? 'Mode: Stand-alone (user: admin, auth disabled)'
  : `Admin: ${env.ADMIN.length ? env.ADMIN.join('、') : 'Not configured (no admin)'}`, contentCols)}  ║
╚══════════════════════════════════════╝
`)
