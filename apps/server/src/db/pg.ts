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
      last_read_at INTEGER,
      workspace_id TEXT,
      stats TEXT
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
      standing_art TEXT NOT NULL DEFAULT '',
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
      banned BOOLEAN NOT NULL DEFAULT FALSE,
      weekly_quota_mtok INTEGER
    );

    CREATE TABLE IF NOT EXISTS user_oidc_bindings (
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
    CREATE INDEX IF NOT EXISTS idx_oidc_user ON user_oidc_bindings(user_id);

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

    CREATE TABLE IF NOT EXISTS worlds (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      laws TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 会话分组工作区：文件夹语义；创建时锁定到会话（conversations.workspace_id）
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspaces_user ON workspaces(user_id);

    CREATE TABLE IF NOT EXISTS usage_ledger (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL DEFAULT '',
      tokens INTEGER NOT NULL,
      estimated INTEGER NOT NULL DEFAULT 0,
      week_start INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ledger_week ON usage_ledger(week_start, user_id);
    CREATE INDEX IF NOT EXISTS idx_usage_ledger_user ON usage_ledger(user_id, created_at);
  `)

  // 既有 PG 部署补列（幂等）：分组工作区锚定列，见 docs/specs/module-workspace.md
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS workspace_id TEXT`)
  // 会话状态条统计（JSON），见 docs/specs/module-chat.md
  await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS stats TEXT`)
  // 世界模拟「Agent 状态」（JSON），见 docs/specs/module-world.md
  await pool.query(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS states TEXT`)
  await pool.query(`ALTER TABLE worlds ADD COLUMN IF NOT EXISTS state_values TEXT`)
  // 智能体立绘（仅单聊聊天区上半屏展示）
  await pool.query(`ALTER TABLE agents ADD COLUMN IF NOT EXISTS standing_art TEXT NOT NULL DEFAULT ''`)
  // 用户周额度（NULL = 不限制），见 docs/DECISIONS.md D77
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_quota_mtok INTEGER`)
  // 用量流水口径演化（D77 两次修订）：micro（μtoken）→ micro_credits → tokens。
  // 最终只存 token 数；积分由它实时推算。逐级改名，每级都先查 information_schema。
  for (const [from, to] of [['micro', 'micro_credits'], ['micro_credits', 'tokens']] as const) {
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'usage_ledger' AND column_name = '${from}'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'usage_ledger' AND column_name = '${to}'
        ) THEN
          ALTER TABLE usage_ledger RENAME COLUMN ${from} TO ${to};
        END IF;
      END $$;
    `)
  }

  // drizzle-orm 1.0-rc.4：node-postgres 的 drizzle() 不再接受 (client, config) 位置参数，
  // 改用对象形式 { client }。schema 键已被 Omit（关系 API 改用 relations）；momoi 不使用
  // db.query.* 关系查询，故不传——表定义由 db/index.ts 从 schema.pg.ts 静态导出消费。
  const db = drizzlePg({ client: pool }) as any
  console.log('[db] PostgreSQL ready')
  return { db, schema }
}