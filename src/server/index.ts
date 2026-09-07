import 'dotenv/config'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import path from 'path'
import fs from 'fs'

// Initialize database (side effect: creates tables)
import './db.js'
// Auto-create Default agent from legacy global config if no agents exist
await migrateDefaultAgent()

import { env } from './config.js'
import { migrateDefaultAgent } from './config.js'
import { conversationsRoute } from './routes/conversations.js'
import { adminRoute } from './routes/admin.js'
import { appRoute } from './routes/app.js'
import { chatRoute } from './routes/chat.js'
import { uploadRoute } from './routes/upload.js'
import { userRoute } from './routes/user.js'
import { workspaceRoute } from './routes/workspace.js'
import { groupRoute } from './routes/group.js'
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

// Static files (production build only)
if (fs.existsSync(path.join('dist/client', 'index.html'))) {
  app.use('*', serveClient)
}

// Start server
serve({
  fetch: app.fetch,
  port: env.PORT,
  hostname: '0.0.0.0',
})

console.log(`
╔══════════════════════════════════════╗
║  智能体服务                          ║
║  端口：${String(env.PORT).padEnd(28)}║
║  管理员密钥：${env.ADMIN_KEY ? '已配置 ✓'.padEnd(20) : '未设置 ⚠️'.padEnd(18)}║
╚══════════════════════════════════════╝
`)
