import path from 'path'
import fs from 'fs'
import { MIGRATION_SQL } from './ddl.js'
import { repoRoot } from '../lib/paths.js'
import { STAND_ALONE } from '../lib/standalone.js'

export async function initSqlite() {
  const initSqlJs = (await import('sql.js')).default
  const { drizzle } = await import('drizzle-orm/sql-js')
  const schema = await import('./schema.sqlite.js')

  const dataDir = path.resolve(repoRoot(), 'data')
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  // Stand-alone mode uses its own isolated database file, fully separate from
  // the multi-tenant momoi.db.
  const dbPath = path.join(dataDir, STAND_ALONE ? 'momoi.stand-alone.db' : 'momoi.db')

  const SQL = await initSqlJs()

  let sqlDb: any
  if (fs.existsSync(dbPath)) {
    console.log(`[db] Loading existing database: ${dbPath} (${(fs.statSync(dbPath).size / 1024).toFixed(1)} KB)`)
    sqlDb = new SQL.Database(fs.readFileSync(dbPath))
  } else {
    console.log(`[db] Creating new database: ${dbPath}`)
    sqlDb = new SQL.Database()
  }

  // Run migrations
  sqlDb.run(MIGRATION_SQL)

  // Additive column migrations — sql.js throws if column already exists,
  // so run each ALTER individually under try/catch.
  const ADDITIVE_MIGRATIONS = [
    `ALTER TABLE agents ADD COLUMN voice_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE agents ADD COLUMN voice_sample_url TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE agents ADD COLUMN voice_settings TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE messages ADD COLUMN trace TEXT`,
    `ALTER TABLE qq_bindings ADD COLUMN group_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN last_active_at INTEGER`,
  ]
  for (const stmt of ADDITIVE_MIGRATIONS) {
    try { sqlDb.run(stmt) } catch { /* column already exists */ }
  }

  // Migration: qq_bindings composite PK (user_id, agent_id).
  // Old schema had user_id as sole PK — rebuild the table if agent_id column is missing.
  let qqBindingsNeedsRebuild = false
  try {
    sqlDb.run(`SELECT agent_id FROM qq_bindings LIMIT 0`)
  } catch {
    qqBindingsNeedsRebuild = true
  }
  if (qqBindingsNeedsRebuild) {
    console.log('[db] Migrating qq_bindings: adding agent_id column + composite PK')
    sqlDb.run(`
      CREATE TABLE IF NOT EXISTS qq_bindings_new (
        user_id TEXT NOT NULL DEFAULT '',
        agent_id TEXT NOT NULL DEFAULT '',
        app_id TEXT NOT NULL DEFAULT '',
        app_secret TEXT NOT NULL DEFAULT '',
        conversation_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'connected',
        error TEXT NOT NULL DEFAULT '',
        group_enabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (user_id, agent_id)
      )
    `)
    sqlDb.run(`INSERT INTO qq_bindings_new (user_id, agent_id, app_id, app_secret, conversation_id, status, error, group_enabled, created_at, updated_at)
      SELECT user_id, '', app_id, app_secret, conversation_id, status, error, COALESCE(group_enabled, 0), created_at, updated_at FROM qq_bindings`)
    sqlDb.run(`DROP TABLE qq_bindings`)
    sqlDb.run(`ALTER TABLE qq_bindings_new RENAME TO qq_bindings`)
    console.log('[db] qq_bindings migration complete')
  }

  // Migration: qq_group_conversations — revert to (app_id, group_openid) PK.
  // Detect stale schema by checking for removed columns (group_name / user_id).
  let qqGroupConvNeedsRebuild = false
  try {
    sqlDb.run(`SELECT group_name FROM qq_group_conversations LIMIT 0`)
    // column exists → stale schema, need rebuild
    qqGroupConvNeedsRebuild = true
  } catch {
    // column missing → might still have user_id col from intermediate state
    try {
      sqlDb.run(`SELECT user_id FROM qq_group_conversations LIMIT 0`)
      qqGroupConvNeedsRebuild = true
    } catch { /* already correct */ }
  }
  if (qqGroupConvNeedsRebuild) {
    console.log('[db] Migrating qq_group_conversations: reverting to (app_id, group_openid) PK')
    sqlDb.run(`
      CREATE TABLE IF NOT EXISTS qq_group_conversations_new (
        app_id TEXT NOT NULL,
        group_openid TEXT NOT NULL,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (app_id, group_openid)
      )
    `)
    try {
      sqlDb.run(`
        INSERT INTO qq_group_conversations_new (app_id, group_openid, conversation_id, created_at)
        SELECT app_id, group_openid, conversation_id, created_at
        FROM qq_group_conversations
      `)
    } catch (e) {
      console.log('[db] qq_group_conversations migration insert failed:', (e as Error).message)
    }
    sqlDb.run(`DROP TABLE qq_group_conversations`)
    sqlDb.run(`ALTER TABLE qq_group_conversations_new RENAME TO qq_group_conversations`)
    console.log('[db] qq_group_conversations migration complete')
  }

  // Ensure index exists
  sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_qq_group_conv_app ON qq_group_conversations(app_id)`)

  // Create user_agent_memories table for existing databases (new installs get it from MIGRATION_SQL)
  try { sqlDb.run(`CREATE TABLE IF NOT EXISTS user_agent_memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'agent',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`) } catch { /* table already exists */ }
  sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_user_agent_memories ON user_agent_memories(user_id, agent_id)`)

  persist()

  const db = drizzle(sqlDb, { schema }) as any

  // Disk persistence
  function persist() {
    try {
      fs.writeFileSync(dbPath, Buffer.from(sqlDb.export()))
    } catch (err) {
      console.error('[db] Failed to persist database:', (err as Error).message)
    }
  }

  // Auto-save every 30s
  setInterval(persist, 30_000)

  // Save on graceful shutdown
  const shutdown = () => { persist(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  console.log('[db] SQLite (sql.js) ready')
  return { db, schema }
}