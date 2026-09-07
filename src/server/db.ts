import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from './schema.js'
import path from 'path'
import fs from 'fs'

const dataDir = path.resolve('data')
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

const dbPath = path.join(dataDir, 'open-agent.db')
const client = createClient({ url: `file:${dbPath}` })

// --- Migrations ---
// Lightweight: CREATE IF NOT EXISTS won't add columns to existing DBs,
// so new columns are ALTERed in when missing.
async function migrate() {
  // --- Pre-flight: add columns that older DBs may be missing ---
  // These ALTERs must run BEFORE executeMultiple, because CREATE INDEX
  // on a missing column would fail inside the batch.
  const convRes = await client.execute('PRAGMA table_info(conversations)')
  if (convRes.rows.length > 0) {
    // Table exists — patch any new columns
    const hasUserId = convRes.rows.some((r) => r.name === 'user_id')
    if (!hasUserId) {
      await client.execute("ALTER TABLE conversations ADD COLUMN user_id TEXT NOT NULL DEFAULT ''")
    }
    const hasAgentId = convRes.rows.some((r) => r.name === 'agent_id')
    if (!hasAgentId) {
      await client.execute("ALTER TABLE conversations ADD COLUMN agent_id TEXT NOT NULL DEFAULT ''")
    }
    const hasType = convRes.rows.some((r) => r.name === 'type')
    if (!hasType) {
      await client.execute("ALTER TABLE conversations ADD COLUMN type TEXT NOT NULL DEFAULT 'direct'")
    }
  }

  const msgRes = await client.execute('PRAGMA table_info(messages)')
  if (msgRes.rows.length > 0) {
    const hasSuggestions = msgRes.rows.some((r) => r.name === 'suggestions')
    if (!hasSuggestions) {
      await client.execute('ALTER TABLE messages ADD COLUMN suggestions TEXT')
    }
    const hasAttachments = msgRes.rows.some((r) => r.name === 'attachments')
    if (!hasAttachments) {
      await client.execute('ALTER TABLE messages ADD COLUMN attachments TEXT')
    }
    const hasMsgAgentId = msgRes.rows.some((r) => r.name === 'agent_id')
    if (!hasMsgAgentId) {
      await client.execute('ALTER TABLE messages ADD COLUMN agent_id TEXT')
    }
  }

  const agentRes = await client.execute('PRAGMA table_info(agents)')
  if (agentRes.rows.length > 0) {
    const hasAvatar = agentRes.rows.some((r) => r.name === 'avatar')
    if (!hasAvatar) {
      await client.execute("ALTER TABLE agents ADD COLUMN avatar TEXT NOT NULL DEFAULT ''")
    }
  }

  // --- Main DDL (safe: IF NOT EXISTS on everything) ---
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '新对话',
      agent_id TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      content TEXT NOT NULL DEFAULT '',
      thinking TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      suggestions TEXT,
      attachments TEXT,
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
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
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
  `)
}

await migrate()

export const db = drizzle(client, { schema })
