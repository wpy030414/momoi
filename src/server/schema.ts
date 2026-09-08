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
})

export const groupConversationAgents = sqliteTable('group_conversation_agents', {
  conversation_id: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  agent_id: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  sort_order: integer('sort_order').notNull().default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.conversation_id, table.agent_id] }),
}))
