import { mysqlTable, varchar, int, boolean, text, primaryKey } from 'drizzle-orm/mysql-core'

export const conversations = mysqlTable('conversations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  user_id: varchar('user_id', { length: 255 }).notNull().default(''),
  title: varchar('title', { length: 255 }).notNull().default('新对话'),
  agent_id: varchar('agent_id', { length: 36 }).notNull().default(''),
  type: varchar('type', { length: 20 }).notNull().default('direct'),
  created_at: int('created_at').notNull(),
  updated_at: int('updated_at').notNull(),
  deleted_at: int('deleted_at'),
})

export const messages = mysqlTable('messages', {
  id: int('id').autoincrement().primaryKey(),
  conversation_id: varchar('conversation_id', { length: 36 }).notNull(),
  role: varchar('role', { length: 20 }).notNull(),
  content: text('content').notNull(),
  thinking: text('thinking'),
  tool_calls: text('tool_calls'),
  tool_call_id: varchar('tool_call_id', { length: 255 }),
  suggestions: text('suggestions'),
  attachments: text('attachments'),
  agent_id: varchar('agent_id', { length: 36 }),
  created_at: int('created_at').notNull(),
})

export const settings = mysqlTable('settings', {
  key: varchar('key', { length: 255 }).primaryKey(),
  value: text('value').notNull(),
})

export const agents = mysqlTable('agents', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull().default(''),
  model: varchar('model', { length: 255 }).notNull().default(''),
  system_prompt: text('system_prompt').notNull(),
  avatar: varchar('avatar', { length: 255 }).notNull().default(''),
  role: varchar('role', { length: 20 }).notNull().default('default'),
  created_at: int('created_at').notNull(),
})

export const groupConversationAgents = mysqlTable('group_conversation_agents', {
  conversation_id: varchar('conversation_id', { length: 36 }).notNull(),
  agent_id: varchar('agent_id', { length: 36 }).notNull(),
  sort_order: int('sort_order').notNull().default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.conversation_id, table.agent_id] }),
}))

export const mcpServers = mysqlTable('mcp_servers', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull().default(''),
  url: varchar('url', { length: 2048 }).notNull().default(''),
  enabled: boolean('enabled').notNull().default(true),
  created_at: int('created_at').notNull(),
})

export const users = mysqlTable('users', {
  username: varchar('username', { length: 255 }).primaryKey(),
  pin_hash: varchar('pin_hash', { length: 255 }).notNull().default(''),
  first_login_at: int('first_login_at').notNull(),
  last_login_at: int('last_login_at').notNull(),
  banned: boolean('banned').notNull().default(false),
})