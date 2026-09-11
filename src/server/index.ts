import 'dotenv/config'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'

import { env, migrateDefaultAgent } from './config.js'

// config.ts transitively imports db.ts which has top-level await for database initialization.
// Auto-create Default agent from legacy global config if no agents exist
await migrateDefaultAgent()
import { conversationsRoute } from './routes/conversations.js'
import { adminRoute } from './routes/admin.js'
import { appRoute } from './routes/app.js'
import { chatRoute } from './routes/chat.js'
import { uploadRoute } from './routes/upload.js'
import { userRoute } from './routes/user.js'
import { workspaceRoute } from './routes/workspace.js'
import { groupRoute } from './routes/group.js'
import { oauthRoute } from './routes/oauth.js'
import { serveClient } from './static.js'

const app = new Hono()

// Middleware — allow all origins in dev (Vite runs on 5173)
app.use('*', logger())
app.use('*', cors({
  origin: '*',
  allowHeaders: ['Content-Type', 'Authorization', 'X-User'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}))

// API Routes
app.route('/api/conversations', conversationsRoute)
app.route('/api/admin', adminRoute)
app.route('/api/app-name', appRoute)
app.route('/api/chat', chatRoute)
app.route('/api/upload', uploadRoute)
app.route('/api/user', userRoute)
app.route('/api/workspace', workspaceRoute)
app.route('/api/group', groupRoute)
app.route('/api/oauth', oauthRoute)

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
║  ${padVisual(`Admin: ${env.ADMIN.length ? env.ADMIN.join('、') : 'Not configured (no admin)'}`, contentCols)}  ║
╚══════════════════════════════════════╝
`)
