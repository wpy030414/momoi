import path from 'path'
import fs from 'fs'
import fsPromises from 'fs/promises'
import { MIGRATION_SQL } from './ddl.js'
import { repoRoot } from '../lib/paths.js'

export async function initSqlite() {
  const initSqlJs = (await import('sql.js')).default
  const { drizzle } = await import('drizzle-orm/sql-js')
  const schema = await import('./schema.sqlite.js')

  const dataDir = path.resolve(repoRoot(), 'data')
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, 'momoi.db')

  const SQL = await initSqlJs()

  let sqlDb: any
  if (fs.existsSync(dbPath)) {
    console.log(`[db] Loading existing database: ${dbPath} (${(fs.statSync(dbPath).size / 1024).toFixed(1)} KB)`)
    const buf = await fsPromises.readFile(dbPath)
    sqlDb = new SQL.Database(buf)
  } else {
    console.log(`[db] Creating new database: ${dbPath}`)
    sqlDb = new SQL.Database()
  }

  // Run migrations
  sqlDb.run(MIGRATION_SQL)

  // Persistent index creation — safe to run on every startup
  sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_qq_group_conv_app ON qq_group_conversations(app_id)`)
  sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_qq_bindings_conv ON qq_bindings(conversation_id)`)
  sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_wechat_bindings_conv ON wechat_bindings(conversation_id)`)
  sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_oauth_user ON user_oauth_bindings(user_id)`)
  sqlDb.run(`CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id)`)

  persist()

  const db = drizzle(sqlDb, { schema }) as any

  // Disk persistence — async write to avoid blocking the event loop.
  function persist() {
    try {
      const buf = Buffer.from(sqlDb.export())
      fsPromises.writeFile(dbPath, buf).catch((err) =>
        console.error('[db] Failed to persist database:', (err as Error).message))
    } catch (err) {
      console.error('[db] Failed to export database:', (err as Error).message)
    }
  }

  // Auto-save every 30s (async — safe for periodic saves)
  setInterval(persist, 30_000)

  // Shutdown: synchronous write to guarantee data survives pm2 restart / SIGTERM.
  // The async persist() truncates the file on open (O_TRUNC) then writes — if
  // the process exits before the write completes (pm2 sends SIGKILL after grace
  // period), the database file is left empty and all data is irreversibly lost.
  // Using writeFileSync here eliminates that race condition entirely.
  const shutdown = () => {
    try {
      fs.writeFileSync(dbPath, Buffer.from(sqlDb.export()))
    } catch (err) {
      console.error('[db] Failed to persist database on shutdown:', (err as Error).message)
    }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  console.log('[db] SQLite (sql.js) ready')
  return { db, schema }
}