export async function initPg(dbUrl: string, user: string, password: string) {
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
      last_active_at INTEGER,
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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at INTEGER;
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
    -- Migration: qq_group_conversations — revert to (app_id, group_openid) PK;
    -- drop stale columns (user_id, group_name, group_chain_id) from auto-merge experiment.
    DO $$ BEGIN
      ALTER TABLE qq_group_conversations DROP CONSTRAINT IF EXISTS qq_group_conversations_pkey;
    EXCEPTION WHEN others THEN END $$;
    ALTER TABLE qq_group_conversations DROP COLUMN IF EXISTS user_id;
    ALTER TABLE qq_group_conversations DROP COLUMN IF EXISTS group_name;
    ALTER TABLE qq_group_conversations DROP COLUMN IF EXISTS group_chain_id;
    DROP INDEX IF EXISTS idx_qq_group_conv_user;
    DROP INDEX IF EXISTS idx_qq_group_conv_chain;
    DO $$ BEGIN
      ALTER TABLE qq_group_conversations ADD PRIMARY KEY (app_id, group_openid);
    EXCEPTION WHEN others THEN END $$;
    CREATE INDEX IF NOT EXISTS idx_qq_group_conv_app ON qq_group_conversations(app_id);

    CREATE TABLE IF NOT EXISTS user_agent_memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'agent',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_agent_memories ON user_agent_memories(user_id, agent_id);
  `)

  const db = drizzlePg(pool, { schema }) as any
  console.log('[db] PostgreSQL ready')
  return { db, schema }
}