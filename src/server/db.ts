import 'dotenv/config'
import path from 'path'
import fs from 'fs'

// ---- Detect remote dialect from DATABASE_URL ----

const DATABASE_URL = process.env.DATABASE_URL
const DATABASE_USER = process.env.DATABASE_USER
const DATABASE_SECRET = process.env.DATABASE_SECRET

function detectRemoteDialect(url: string): 'pg' | 'mysql' {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return 'pg'
  if (url.startsWith('mysql://') || url.startsWith('mariadb://')) return 'mysql'
  throw new Error(`Unsupported DATABASE_URL scheme: ${url.split('://')[0]}://. Expected postgres://, postgresql://, mysql://, or mariadb://`)
}

const remoteDialect = (DATABASE_URL && DATABASE_USER && DATABASE_SECRET)
  ? detectRemoteDialect(DATABASE_URL)
  : null

if (remoteDialect) {
  console.log(`[db] Remote database mode: ${remoteDialect}`)
}

// ---- Shared migration SQL (SQLite dialect, used by sql.js) ----

const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '新对话',
    agent_id TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'direct',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    deleted_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
    content TEXT NOT NULL DEFAULT '',
    thinking TEXT,
    tool_calls TEXT,
    tool_call_id TEXT,
    suggestions TEXT,
    attachments TEXT,
    agent_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    avatar TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'default',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS group_conversation_agents (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, agent_id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_group_conv_agents_conv ON group_conversation_agents(conversation_id);

  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    pin_hash TEXT NOT NULL DEFAULT '',
    first_login_at INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL,
    banned INTEGER NOT NULL DEFAULT 0
  );
`

// ---- SQLite (sql.js) local mode ----

async function initSqlite() {
  const initSqlJs = (await import('sql.js')).default
  const { drizzle } = await import('drizzle-orm/sql-js')
  const schema = await import('./schema.js')

  const dataDir = path.resolve('data')
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = path.join(dataDir, 'momoi.db')

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

// ---- PostgreSQL remote mode ----

async function initPg(dbUrl: string, user: string, password: string) {
  let Pool: any; let drizzlePg: any; let schema: any
  try {
    Pool = (await import('pg')).Pool
    drizzlePg = (await import('drizzle-orm/node-postgres')).drizzle
    schema = await import('./schema.pg.js')
  } catch (err) {
    console.error('[db] PostgreSQL driver not found. Install it with: pnpm add pg')
    throw err
  }

  // Inject user/password into connection string if missing
  const parsed = new URL(dbUrl)
  if (!parsed.username) parsed.username = user
  if (!parsed.password) parsed.password = password
  const connectionString = parsed.toString()

  const pool = new Pool({ connectionString, max: 5 })

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '新对话',
      agent_id TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'direct',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      thinking TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      suggestions TEXT,
      attachments TEXT,
      agent_id TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'default',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_conversation_agents (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (conversation_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      pin_hash TEXT NOT NULL DEFAULT '',
      first_login_at INTEGER NOT NULL,
      last_login_at INTEGER NOT NULL,
      banned BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_group_conv_agents_conv ON group_conversation_agents(conversation_id);
  `)

  const db = drizzlePg(pool, { schema }) as any
  console.log('[db] PostgreSQL ready')
  return { db, schema }
}

// ---- MySQL / MariaDB remote mode ----

async function initMysql(dbUrl: string, user: string, password: string) {
  let mysql: any; let drizzleMysql: any; let schema: any
  try {
    mysql = await import('mysql2/promise')
    drizzleMysql = (await import('drizzle-orm/mysql2')).drizzle
    schema = await import('./schema.mysql.js')
  } catch (err) {
    console.error('[db] MySQL driver not found. Install it with: pnpm add mysql2')
    throw err
  }

  const pool = mysql.createPool({ uri: dbUrl, user, password, connectionLimit: 5 })

  const conn = await pool.getConnection()
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id VARCHAR(36) PRIMARY KEY,
        user_id VARCHAR(255) NOT NULL DEFAULT '',
        title VARCHAR(255) NOT NULL DEFAULT '新对话',
        agent_id VARCHAR(36) NOT NULL DEFAULT '',
        type VARCHAR(20) NOT NULL DEFAULT 'direct',
        created_at INT NOT NULL,
        updated_at INT NOT NULL,
        deleted_at INT
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        conversation_id VARCHAR(36) NOT NULL,
        role VARCHAR(20) NOT NULL,
        content TEXT NOT NULL,
        thinking TEXT,
        tool_calls TEXT,
        tool_call_id VARCHAR(255),
        suggestions TEXT,
        attachments TEXT,
        agent_id VARCHAR(36),
        created_at INT NOT NULL
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS settings (
        \`key\` VARCHAR(255) PRIMARY KEY,
        value TEXT NOT NULL
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS agents (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL DEFAULT '',
        model VARCHAR(255) NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL,
        avatar VARCHAR(255) NOT NULL DEFAULT '',
        role VARCHAR(20) NOT NULL DEFAULT 'default',
        created_at INT NOT NULL
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS group_conversation_agents (
        conversation_id VARCHAR(36) NOT NULL,
        agent_id VARCHAR(36) NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        PRIMARY KEY (conversation_id, agent_id)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS mcp_servers (
        id VARCHAR(36) PRIMARY KEY,
        name VARCHAR(255) NOT NULL DEFAULT '',
        url VARCHAR(2048) NOT NULL DEFAULT '',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at INT NOT NULL
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

      CREATE TABLE IF NOT EXISTS users (
        username VARCHAR(255) PRIMARY KEY,
        pin_hash VARCHAR(255) NOT NULL DEFAULT '',
        first_login_at INT NOT NULL,
        last_login_at INT NOT NULL,
        banned BOOLEAN NOT NULL DEFAULT FALSE
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    `)
  } finally {
    conn.release()
  }

  const db = drizzleMysql(pool, { schema, mode: 'default' }) as any
  console.log('[db] MySQL/MariaDB ready')
  return { db, schema }
}

// ---- Dialect factory + unified exports ----

const result = remoteDialect === 'pg'
  ? await initPg(DATABASE_URL!, DATABASE_USER!, DATABASE_SECRET!)
  : remoteDialect === 'mysql'
    ? await initMysql(DATABASE_URL!, DATABASE_USER!, DATABASE_SECRET!)
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
} = result.schema