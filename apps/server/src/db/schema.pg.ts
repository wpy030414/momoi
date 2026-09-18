import { pgTable, text, integer, boolean, serial, primaryKey, index } from 'drizzle-orm/pg-core'

export const conversations = pgTable('conversations', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull().default(''),
  title: text('title').notNull().default('新对话'),
  agent_id: text('agent_id').notNull().default(''),
  type: text('type').notNull().default('direct'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
  deleted_at: integer('deleted_at'),
})

export const messages = pgTable('messages', {
  id: serial('id').primaryKey(),
  conversation_id: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
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

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull().default(''),
})

export const agents = pgTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull().default(''),
  model: text('model').notNull().default(''),
  system_prompt: text('system_prompt').notNull().default(''),
  avatar: text('avatar').notNull().default(''),
  role: text('role').notNull().default('default'),
  created_at: integer('created_at').notNull(),
  voice_enabled: boolean('voice_enabled').notNull().default(false),
  voice_sample_url: text('voice_sample_url').notNull().default(''),
  voice_settings: text('voice_settings').notNull().default('{}'),
})

export const groupConversationAgents = pgTable('group_conversation_agents', {
  conversation_id: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  agent_id: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  sort_order: integer('sort_order').notNull().default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.conversation_id, table.agent_id] }),
}))

export const mcpServers = pgTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull().default(''),
  url: text('url').notNull().default(''),
  enabled: boolean('enabled').notNull().default(true),
  created_at: integer('created_at').notNull(),
})

export const users = pgTable('users', {
  username: text('username').primaryKey(),
  pin_hash: text('pin_hash').notNull().default(''),
  first_login_at: integer('first_login_at').notNull(),
  last_login_at: integer('last_login_at').notNull(),
  last_active_at: integer('last_active_at'),
  banned: boolean('banned').notNull().default(false),
})

export const userOauthBindings = pgTable('user_oauth_bindings', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull(),
  provider_id: text('provider_id').notNull(),
  provider_user_id: text('provider_user_id').notNull(),
  created_at: integer('created_at').notNull(),
})

export const wechatBindings = pgTable('wechat_bindings', {
  user_id: text('user_id').primaryKey(),
  bot_token: text('bot_token').notNull().default(''),
  wechat_user_id: text('wechat_user_id').notNull().default(''),
  conversation_id: text('conversation_id').notNull().default(''),
  pending_conversation_id: text('pending_conversation_id').notNull().default(''),
  updates_buf: text('updates_buf').notNull().default(''),
  session_expired: boolean('session_expired').notNull().default(false),
  created_at: integer('created_at').notNull(),
})

export const qqBindings = pgTable('qq_bindings', {
  user_id: text('user_id').notNull().default(''),
  agent_id: text('agent_id').notNull().default(''),
  app_id: text('app_id').notNull().default(''),
  app_secret: text('app_secret').notNull().default(''),
  conversation_id: text('conversation_id').notNull().default(''),
  status: text('status').notNull().default('connected'),
  error: text('error').notNull().default(''),
  group_enabled: boolean('group_enabled').notNull().default(false),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.user_id, table.agent_id] }),
}))

export const userAgentMemories = pgTable('user_agent_memories', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull(),
  agent_id: text('agent_id').notNull(),
  content: text('content').notNull(),
  source: text('source').notNull().default('agent'),
  created_at: integer('created_at').notNull(),
})

export const qqGroupConversations = pgTable('qq_group_conversations', {
  app_id: text('app_id').notNull(),
  group_openid: text('group_openid').notNull(),
  conversation_id: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  created_at: integer('created_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.app_id, table.group_openid] }),
}))
