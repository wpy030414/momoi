import { sqliteTable, text, integer, real, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull().default(''),
  title: text('title').notNull().default('新对话'),
  agent_id: text('agent_id').notNull().default(''),
  type: text('type').notNull().default('direct'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
  deleted_at: integer('deleted_at'),
  last_read_at: integer('last_read_at'),
})

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  conversation_id: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant', 'system', 'tool'] }).notNull(),
  content: text('content').notNull().default(''),
  thinking: text('thinking'),
  tool_calls: text('tool_calls'),
  trace: text('trace'),
  tool_call_id: text('tool_call_id'),
  suggestions: text('suggestions'),
  attachments: text('attachments'),
  agent_id: text('agent_id'),
  created_at: integer('created_at').notNull(),
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull().default(''),
})

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull().default(''),
  model: text('model').notNull().default(''),
  system_prompt: text('system_prompt').notNull().default(''),
  avatar: text('avatar').notNull().default(''),
  role: text('role').notNull().default('default'),
  created_at: integer('created_at').notNull(),
  voice_enabled: integer('voice_enabled', { mode: 'boolean' }).notNull().default(false),
  voice_sample_url: text('voice_sample_url').notNull().default(''),
  voice_settings: text('voice_settings').notNull().default('{}'),
})

export const groupConversationAgents = sqliteTable('group_conversation_agents', {
  conversation_id: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  agent_id: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  sort_order: integer('sort_order').notNull().default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.conversation_id, table.agent_id] }),
}))

export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull().default(''),
  url: text('url').notNull().default(''),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  created_at: integer('created_at').notNull(),
})

export const users = sqliteTable('users', {
  username: text('username').primaryKey(),
  pin_hash: text('pin_hash').notNull().default(''),
  first_login_at: integer('first_login_at').notNull(),
  last_login_at: integer('last_login_at').notNull(),
  last_active_at: integer('last_active_at'),
  banned: integer('banned', { mode: 'boolean' }).notNull().default(false),
})

export const userOauthBindings = sqliteTable('user_oauth_bindings', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull(),
  provider_id: text('provider_id').notNull(),
  provider_user_id: text('provider_user_id').notNull(),
  created_at: integer('created_at').notNull(),
})

export const wechatBindings = sqliteTable('wechat_bindings', {
  user_id: text('user_id').primaryKey(),
  bot_token: text('bot_token').notNull().default(''),
  wechat_user_id: text('wechat_user_id').notNull().default(''),
  conversation_id: text('conversation_id').notNull().default(''),
  pending_conversation_id: text('pending_conversation_id').notNull().default(''),
  updates_buf: text('updates_buf').notNull().default(''),
  session_expired: integer('session_expired', { mode: 'boolean' }).notNull().default(false),
  created_at: integer('created_at').notNull(),
})

export const qqBindings = sqliteTable('qq_bindings', {
  user_id: text('user_id').notNull().default(''),
  agent_id: text('agent_id').notNull().default(''),
  app_id: text('app_id').notNull().default(''),
  app_secret: text('app_secret').notNull().default(''),
  conversation_id: text('conversation_id').notNull().default(''),
  status: text('status').notNull().default('connected'),
  error: text('error').notNull().default(''),
  group_enabled: integer('group_enabled', { mode: 'boolean' }).notNull().default(false),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.user_id, table.agent_id] }),
}))

export const userAgentMemories = sqliteTable('user_agent_memories', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull(),
  agent_id: text('agent_id').notNull(),
  content: text('content').notNull(),
  source: text('source').notNull().default('agent'),
  created_at: integer('created_at').notNull(),
})

export const qqGroupConversations = sqliteTable('qq_group_conversations', {
  app_id: text('app_id').notNull(),
  group_openid: text('group_openid').notNull(),
  conversation_id: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  created_at: integer('created_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.app_id, table.group_openid] }),
}))

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  user_id: text('user_id').notNull(),
  device_id: text('device_id').notNull(),
  endpoint: text('endpoint').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  created_at: integer('created_at').notNull(),
}, (t) => [
  // 与 db/ddl.ts 的 UNIQUE(user_id, device_id) 对齐（此前 schema 未声明，
  // 曾致 endpoint 键控 upsert 撞物理约束 500）
  uniqueIndex('uq_push_user_device').on(t.user_id, t.device_id),
])

/**
 * 世界模拟：与 conversations 1:1。
 * 归属以 conversations.user_id 为唯一权威，故此处刻意不存 user_id。
 * conversations 为软删除，故读取时须连带过滤 deleted_at IS NULL。
 */
export const worlds = sqliteTable('worlds', {
  conversation_id: text('conversation_id').primaryKey().references(() => conversations.id, { onDelete: 'cascade' }),
  /** 用户原文「世界地形规则」—— 创生后不可修改 */
  terrain_prompt: text('terrain_prompt').notNull().default(''),
  /** TerrainSpec 的 JSON 文本；生成中为空串 */
  terrain_spec: text('terrain_spec').notNull().default(''),
  /** 世界法则 —— 可修改 */
  laws: text('laws').notNull().default(''),
  status: text('status').notNull().default('generating'),
  status_error: text('status_error').notNull().default(''),
  /** 回合计数；Phase 1 仅初始化，Phase 2 的回合制引擎使用 */
  turn: integer('turn').notNull().default(0),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
})

/**
 * 世界中的存在：Agent，或（Phase 3 起）上帝的 Avatar。
 * 坐标**归一化**到 [-1,1]，中心 (0,0) —— 与 @momoi/shared/world 的采样坐标系一致，
 * 故客户端可直接送进 sampleHeight / sampleBiome，无需任何换算。
 */
export const worldEntities = sqliteTable('world_entities', {
  id: text('id').primaryKey(),
  conversation_id: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().default('agent'),
  agent_id: text('agent_id'),
  name: text('name').notNull().default(''),
  x: real('x').notNull().default(0),
  z: real('z').notNull().default(0),
  status: text('status').notNull().default('alive'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
})

/** 世界里发生的一件事 —— 世界的「消息」。按 (turn, seq) 排序即世界史。 */
export const worldEvents = sqliteTable('world_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  conversation_id: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  turn: integer('turn').notNull().default(0),
  seq: integer('seq').notNull().default(0),
  actor_kind: text('actor_kind').notNull().default('world'),
  actor_id: text('actor_id'),
  actor_name: text('actor_name').notNull().default(''),
  kind: text('kind').notNull().default('act'),
  content: text('content').notNull().default(''),
  payload: text('payload'),
  created_at: integer('created_at').notNull(),
})
