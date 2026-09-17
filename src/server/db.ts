import 'dotenv/config'
import path from 'path'
import fs from 'fs'

// ---- Detect remote dialect from DATABASE_URL ----

const DATABASE_URL = process.env.DATABASE_URL
const DATABASE_USER = process.env.DATABASE_USER
const DATABASE_SECRET = process.env.DATABASE_SECRET

function detectRemoteDialect(url: string): 'pg' {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return 'pg'
  throw new Error(`Unsupported DATABASE_URL scheme: ${url.split('://')[0]}://. Expected postgres:// or postgresql://`)
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
    trace TEXT,
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
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    voice_enabled INTEGER NOT NULL DEFAULT 0,
    voice_sample_url TEXT NOT NULL DEFAULT '',
    voice_settings TEXT NOT NULL DEFAULT '{}'
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

  CREATE TABLE IF NOT EXISTS user_oauth_bindings (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    provider_user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(provider_id, provider_user_id)
  );

  CREATE TABLE IF NOT EXISTS wechat_bindings (
    user_id TEXT PRIMARY KEY,
    bot_token TEXT NOT NULL DEFAULT '',
    wechat_user_id TEXT NOT NULL DEFAULT '',
    conversation_id TEXT NOT NULL DEFAULT '',
    pending_conversation_id TEXT NOT NULL DEFAULT '',
    updates_buf TEXT NOT NULL DEFAULT '',
    session_expired INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS qq_bindings (
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
  );

  CREATE TABLE IF NOT EXISTS qq_group_conversations (
    app_id TEXT NOT NULL,
    group_openid TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (app_id, group_openid)
  );

  CREATE INDEX IF NOT EXISTS idx_qq_group_conv_app ON qq_group_conversations(app_id);`

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

  // Additive column migrations — sql.js throws if column already exists,
  // so run each ALTER individually under try/catch.
  const ADDITIVE_MIGRATIONS = [
    `ALTER TABLE agents ADD COLUMN voice_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE agents ADD COLUMN voice_sample_url TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE agents ADD COLUMN voice_settings TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE messages ADD COLUMN trace TEXT`,
    `ALTER TABLE qq_bindings ADD COLUMN group_enabled INTEGER NOT NULL DEFAULT 0`,
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
      trace TEXT,
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
      created_at INTEGER NOT NULL,
      voice_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      voice_sample_url TEXT NOT NULL DEFAULT '',
      voice_settings TEXT NOT NULL DEFAULT '{}'
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

    CREATE TABLE IF NOT EXISTS user_oauth_bindings (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(provider_id, provider_user_id)
    );

    CREATE TABLE IF NOT EXISTS wechat_bindings (
      user_id TEXT PRIMARY KEY,
      bot_token TEXT NOT NULL DEFAULT '',
      wechat_user_id TEXT NOT NULL DEFAULT '',
      conversation_id TEXT NOT NULL DEFAULT '',
      pending_conversation_id TEXT NOT NULL DEFAULT '',
      updates_buf TEXT NOT NULL DEFAULT '',
      session_expired BOOLEAN NOT NULL DEFAULT FALSE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS qq_bindings (
      user_id TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL DEFAULT '',
      app_id TEXT NOT NULL DEFAULT '',
      app_secret TEXT NOT NULL DEFAULT '',
      conversation_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'connected',
      error TEXT NOT NULL DEFAULT '',
      group_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS qq_group_conversations (
      app_id TEXT NOT NULL,
      group_openid TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (app_id, group_openid)
    );

    CREATE INDEX IF NOT EXISTS idx_qq_group_conv_app ON qq_group_conversations(app_id);

    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_group_conv_agents_conv ON group_conversation_agents(conversation_id);

    -- Additive column migrations for existing PG databases
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS voice_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS voice_sample_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE agents ADD COLUMN IF NOT EXISTS voice_settings TEXT NOT NULL DEFAULT '{}';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS trace TEXT;
    ALTER TABLE qq_bindings ADD COLUMN IF NOT EXISTS group_enabled BOOLEAN NOT NULL DEFAULT FALSE;
    -- Migration: qq_bindings composite PK (user_id, agent_id)
    ALTER TABLE qq_bindings ADD COLUMN IF NOT EXISTS agent_id TEXT NOT NULL DEFAULT '';
    -- Drop old single-column PK if it still exists; add composite PK
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE constraint_name = 'qq_bindings_pkey' AND table_name = 'qq_bindings') THEN
        ALTER TABLE qq_bindings DROP CONSTRAINT qq_bindings_pkey;
      END IF;
    END $$;
    -- Add composite PK if not already present (idempotent: errors if exists, so wrap)
    DO $$ BEGIN
      ALTER TABLE qq_bindings ADD PRIMARY KEY (user_id, agent_id);
    EXCEPTION WHEN others THEN
      -- PK already exists (composite or otherwise), skip
    END $$;
  `)

  const db = drizzlePg(pool, { schema }) as any
  console.log('[db] PostgreSQL ready')
  return { db, schema }
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
} = result.schema