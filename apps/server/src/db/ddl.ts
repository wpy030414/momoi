// Shared migration SQL (SQLite dialect, used by sql.js).
// PostgreSQL init uses inline CREATE TABLE IF NOT EXISTS statements that
// match this schema but use PG-native types (BOOLEAN, SERIAL, etc.).

export const MIGRATION_SQL = `
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '新对话',
    agent_id TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'direct',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    deleted_at INTEGER,
    last_read_at INTEGER
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
  CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id);
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
    last_active_at INTEGER,
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

  CREATE TABLE IF NOT EXISTS user_agent_memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    content TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'agent',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(user_id, device_id)
  );

  CREATE INDEX IF NOT EXISTS idx_qq_group_conv_app ON qq_group_conversations(app_id);
  CREATE INDEX IF NOT EXISTS idx_qq_bindings_conv ON qq_bindings(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_wechat_bindings_conv ON wechat_bindings(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_oauth_user ON user_oauth_bindings(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_agent_memories ON user_agent_memories(user_id, agent_id);`