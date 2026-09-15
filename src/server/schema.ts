import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core'

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull().default(''),
  title: text('title').notNull().default('新对话'),
  agent_id: text('agent_id').notNull().default(''),
  type: text('type').notNull().default('direct'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
  deleted_at: integer('deleted_at'),
})

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  conversation_id: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant', 'system', 'tool'] }).notNull(),
  content: text('content').notNull().default(''),
  thinking: text('thinking'),
  tool_calls: text('tool_calls'),
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
  banned: integer('banned', { mode: 'boolean' }).notNull().default(false),
})

export const userOauthBindings = sqliteTable('user_oauth_bindings', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull(),
  provider_id: text('provider_id').notNull(),
  provider_user_id: text('provider_user_id').notNull(),
  created_at: integer('created_at').notNull(),
})

export const userWechatBindings = sqliteTable('user_wechat_bindings', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull().unique(),
  conversation_id: text('conversation_id').notNull().default(''),
  bot_token: text('bot_token').notNull(),
  ilink_user_id: text('ilink_user_id').notNull().default(''),
  wechat_user_id: text('wechat_user_id').notNull().default(''),
  updates_buf: text('updates_buf').notNull().default(''),
  last_poll_at: integer('last_poll_at').notNull().default(0),
  pending_conv_id: text('pending_conv_id').notNull().default(''),
  created_at: integer('created_at').notNull(),
})

export const wechatSessions = sqliteTable('wechat_sessions', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull(),
  wechat_sender_id: text('wechat_sender_id').notNull(),
  conversation_id: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  created_at: integer('created_at').notNull(),
})
