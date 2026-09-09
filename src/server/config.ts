import 'dotenv/config'
import { db } from './db.js'
import { settings, agents, mcpServers } from './schema.js'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import type { AppConfig, Agent, McpServerConfig } from '../shared/types.js'
import {
  DEFAULT_APP_NAME,
  DEFAULT_API_ENDPOINT,
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  DEFAULT_MODEL,
  NEUTRAL_AGENT_NAME,
  NEUTRAL_AGENT_ID,
} from '../shared/constants.js'

// .env values (read at startup, not hot-reloadable)
export const env = {
  // Admin usernames, comma-separated (supports both "," and "，"), e.g. ADMIN=xrl,咕咕,k3p0.
  // Membership is fixed for the process lifetime — edit .env and restart to change.
  // Empty or missing => no admins; the app still runs normally.
  ADMIN: (process.env.ADMIN || '')
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean),
  // Optional JWT signing secret. When empty, a random secret is generated once
  // and persisted in the settings table (stable across restarts).
  JWT_SECRET: process.env.JWT_SECRET || '',
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || DEFAULT_API_ENDPOINT,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || DEFAULT_MODEL,
  PORT: parseInt(process.env.PORT || '3001', 10),
}

// Runtime config (stored in DB, hot-reloadable by admin)
async function getSetting(key: string, fallback: string): Promise<string> {
  const row = await db.select().from(settings).where(eq(settings.key, key)).get()
  return row?.value ?? fallback
}

async function setSetting(key: string, value: string): Promise<void> {
  const existing = await db.select().from(settings).where(eq(settings.key, key)).get()
  if (existing) {
    await db.update(settings).set({ value }).where(eq(settings.key, key)).run()
  } else {
    await db.insert(settings).values({ key, value }).run()
  }
}

export async function isRegistrationOpen(): Promise<boolean> {
  return (await getSetting('registration_open', 'true')) === 'true'
}

export async function setRegistrationOpen(open: boolean): Promise<void> {
  await setSetting('registration_open', open ? 'true' : 'false')
}

export async function getConfig(): Promise<AppConfig> {
  return {
    app_name: await getSetting('app_name', DEFAULT_APP_NAME),
    app_favicon: await getSetting('app_favicon', ''),
    app_background: await getSetting('app_background', ''),
    api_endpoint: await getSetting('api_endpoint', env.OPENAI_BASE_URL),
    api_key: await getSetting('api_key', env.OPENAI_API_KEY),
    support_attachments: (await getSetting('support_attachments', 'false')) === 'true',
    show_github: (await getSetting('show_github', 'true')) === 'true',
  }
}

export async function updateConfig(partial: Partial<AppConfig>): Promise<AppConfig> {
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) {
      const boolKeys = ['support_attachments', 'show_github']
      const stored = boolKeys.includes(key) ? (value ? 'true' : 'false') : value
      await setSetting(key, stored as string)
    }
  }
  return getConfig()
}

// ---- Agent CRUD ----

export async function listAgents(): Promise<Agent[]> {
  const rows = await db.select().from(agents).orderBy(agents.created_at).all()
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    model: r.model,
    system_prompt: r.system_prompt,
    avatar: r.avatar,
    role: r.role as Agent['role'],
    created_at: r.created_at,
  }))
}

export async function getAgent(id: string): Promise<Agent | null> {
  const row = await db.select().from(agents).where(eq(agents.id, id)).get()
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    system_prompt: row.system_prompt,
    avatar: row.avatar,
    role: row.role as Agent['role'],
    created_at: row.created_at,
  }
}

export async function createAgent(name: string, model: string, systemPrompt: string, avatar = '', role: Agent['role'] = 'default'): Promise<Agent> {
  const id = role === 'neutral' ? NEUTRAL_AGENT_ID : randomUUID()
  const now = Math.floor(Date.now() / 1000)
  await db.insert(agents).values({
    id,
    name,
    model,
    system_prompt: systemPrompt,
    avatar,
    role,
    created_at: now,
  }).run()
  return { id, name, model, system_prompt: systemPrompt, avatar, role, created_at: now }
}

export async function updateAgent(id: string, partial: Partial<Pick<Agent, 'name' | 'model' | 'system_prompt' | 'avatar'>>): Promise<Agent | null> {
  const existing = await getAgent(id)
  if (!existing) return null
  const updates: Record<string, unknown> = {}
  if (partial.name !== undefined) updates.name = partial.name
  if (partial.model !== undefined) updates.model = partial.model
  if (partial.system_prompt !== undefined) updates.system_prompt = partial.system_prompt
  if (partial.avatar !== undefined) updates.avatar = partial.avatar
  if (Object.keys(updates).length > 0) {
    await db.update(agents).set(updates as any).where(eq(agents.id, id)).run()
  }
  return getAgent(id)
}

export async function deleteAgent(id: string): Promise<boolean> {
  const existing = await getAgent(id)
  if (!existing) return false
  await db.delete(agents).where(eq(agents.id, id)).run()
  return true
}

// ---- Migration: auto-create Default agent + Neutral Agent from legacy global config ----

export async function migrateDefaultAgent(): Promise<void> {
  const existingAgents = await listAgents()
  if (existingAgents.length > 0) return

  // Read old global model/prompt from settings (may have been set by previous versions)
  const oldModel = await getSetting('model', env.OPENAI_MODEL || DEFAULT_AGENT_MODEL)
  const oldPrompt = await getSetting('system_prompt', DEFAULT_AGENT_SYSTEM_PROMPT)

  await createAgent(DEFAULT_AGENT_NAME, oldModel, oldPrompt)
  console.log(`[migrate] Created default agent "${DEFAULT_AGENT_NAME}" with model "${oldModel}"`)

  // Create neutral agent: reuses first agent's model, no name/avatar editing
  await createAgent(NEUTRAL_AGENT_NAME, oldModel, '', '', 'neutral')
  console.log(`[migrate] Created neutral agent "${NEUTRAL_AGENT_NAME}" with model "${oldModel}"`)
}

// ---- MCP Server CRUD ----

export async function listMcpServers(): Promise<McpServerConfig[]> {
  const rows = await db.select().from(mcpServers).orderBy(mcpServers.created_at).all()
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    url: r.url,
    enabled: r.enabled,
    created_at: r.created_at,
  }))
}

export async function getMcpServer(id: string): Promise<McpServerConfig | null> {
  const row = await db.select().from(mcpServers).where(eq(mcpServers.id, id)).get()
  if (!row) return null
  return { id: row.id, name: row.name, url: row.url, enabled: row.enabled, created_at: row.created_at }
}

export async function createMcpServer(name: string, url: string): Promise<McpServerConfig> {
  const id = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  await db.insert(mcpServers).values({ id, name, url, enabled: true, created_at: now }).run()
  return { id, name, url, enabled: true, created_at: now }
}

export async function updateMcpServer(id: string, partial: Partial<Pick<McpServerConfig, 'name' | 'url' | 'enabled'>>): Promise<McpServerConfig | null> {
  const existing = await getMcpServer(id)
  if (!existing) return null
  const updates: Record<string, unknown> = {}
  if (partial.name !== undefined) updates.name = partial.name
  if (partial.url !== undefined) updates.url = partial.url
  if (partial.enabled !== undefined) updates.enabled = partial.enabled ? 1 : 0
  if (Object.keys(updates).length > 0) {
    await db.update(mcpServers).set(updates as any).where(eq(mcpServers.id, id)).run()
  }
  return getMcpServer(id)
}

export async function deleteMcpServer(id: string): Promise<boolean> {
  const existing = await getMcpServer(id)
  if (!existing) return false
  await db.delete(mcpServers).where(eq(mcpServers.id, id)).run()
  return true
}