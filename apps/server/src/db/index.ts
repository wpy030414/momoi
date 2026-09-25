import '../lib/env.js'
import { initSqlite } from './sqlite.js'
import { initPg } from './pg.js'

// ---- Detect remote dialect from DATABASE_URL ----

const DATABASE_URL = process.env.DATABASE_URL
const DATABASE_USER = process.env.DATABASE_USER
const DATABASE_SECRET = process.env.DATABASE_SECRET

function detectRemoteDialect(url: string): 'pg' {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return 'pg'
  throw new Error(`Unsupported DATABASE_URL scheme: ${url.split('://')[0]}://. Expected postgres:// or postgresql://`)
}

const remoteDialect = DATABASE_URL && DATABASE_USER && DATABASE_SECRET
  ? detectRemoteDialect(DATABASE_URL)
  : null

if (remoteDialect) {
  console.log(`[db] Remote database mode: ${remoteDialect}`)
}

// ---- Dialect factory + unified exports ----

const result = remoteDialect === 'pg'
  ? await initPg(DATABASE_URL!, DATABASE_USER!, DATABASE_SECRET!)
  : await initSqlite()

export const db = result.db

export const {
  conversations,
  messages,
  settings,
  agents,
  groupConversationAgents,
  mcpServers,
  users,
  userOauthBindings,
  wechatBindings,
  qqBindings,
  qqGroupConversations,
  userAgentMemories,
  pushSubscriptions,
  worlds,
  worldEntities,
  worldEvents,
  worldPatches,
} = result.schema