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

  // Persistent index creation — safe to run on every startup
  sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_qq_group_conv_app ON qq_group_conversations(app_id)`)

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