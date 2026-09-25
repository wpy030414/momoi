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

  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 })

  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '新对话',
      agent_id TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'direct',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER,
      last_read_at INTEGER
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
    CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id);
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_group_conv_agents_conv ON group_conversation_agents(conversation_id);

    CREATE INDEX IF NOT EXISTS idx_qq_bindings_conv ON qq_bindings(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_wechat_bindings_conv ON wechat_bindings(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_oauth_user ON user_oauth_bindings(user_id);

    CREATE TABLE IF NOT EXISTS user_agent_memories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'agent',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_agent_memories ON user_agent_memories(user_id, agent_id);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, device_id)
    );

    -- 世界模拟：与 conversations 1:1（方言差异仅在建表语句，列与 sqlite 逐列一致）
    CREATE TABLE IF NOT EXISTS worlds (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      terrain_prompt TEXT NOT NULL DEFAULT '',
      terrain_spec TEXT NOT NULL DEFAULT '',
      laws TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'generating',
      status_error TEXT NOT NULL DEFAULT '',
      turn INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_worlds_status ON worlds(status);

    CREATE TABLE IF NOT EXISTS world_entities (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'agent',
      agent_id TEXT,
      name TEXT NOT NULL DEFAULT '',
      x REAL NOT NULL DEFAULT 0,
      z REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'alive',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS world_events (
      id SERIAL PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      turn INTEGER NOT NULL DEFAULT 0,
      seq INTEGER NOT NULL DEFAULT 0,
      actor_kind TEXT NOT NULL DEFAULT 'world',
      actor_id TEXT,
      actor_name TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'act',
      content TEXT NOT NULL DEFAULT '',
      payload TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_world_entities_conv ON world_entities(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_world_events_conv ON world_events(conversation_id, turn, seq);
  `)

  const db = drizzlePg(pool, { schema }) as any
  console.log('[db] PostgreSQL ready')
  return { db, schema }
}