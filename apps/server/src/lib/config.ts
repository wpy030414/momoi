import './env.js'
import { db, settings, agents, mcpServers, userAgentMemories } from '../db/index.js'
import { eq, and, desc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import type { AppConfig, Agent, McpServerConfig, UserAgentMemory } from '@momoi/shared/types'
import {
  DEFAULT_APP_NAME,
  DEFAULT_API_ENDPOINT,
  DEFAULT_MODEL,
  NEUTRAL_AGENT_ID,
  NEUTRAL_AGENT_NAME,
  DEFAULT_TTS_ENDPOINT,
  DEFAULT_TTS_PROVIDER,
} from '@momoi/shared/constants'

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
  PORT: parseInt(process.env.PORT || '11408', 10),
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

export async function isDirectRegistrationOpen(): Promise<boolean> {
  return (await getSetting('direct_registration_open', 'true')) === 'true'
}

export async function setDirectRegistrationOpen(open: boolean): Promise<void> {
  await setSetting('direct_registration_open', open ? 'true' : 'false')
}

export async function isOauthRegistrationOpen(): Promise<boolean> {
  return (await getSetting('oauth_registration_open', 'true')) === 'true'
}

export async function setOauthRegistrationOpen(open: boolean): Promise<void> {
  await setSetting('oauth_registration_open', open ? 'true' : 'false')
}

export async function isExternalImageHostingEnabled(): Promise<boolean> {
  return (await getSetting('use_external_image_hosting', 'false')) === 'true'
}

// ---- TTS Config ----

export async function getTtsConfig(): Promise<{ endpoint: string; provider: string }> {
  return {
    endpoint: await getSetting('tts_api_endpoint', DEFAULT_TTS_ENDPOINT),
    provider: await getSetting('tts_provider', DEFAULT_TTS_PROVIDER),
  }
}

export async function updateTtsConfig(partial: Partial<{ endpoint: string; provider: string }>): Promise<{ endpoint: string; provider: string }> {
  if (partial.endpoint !== undefined) await setSetting('tts_api_endpoint', partial.endpoint)
  if (partial.provider !== undefined) await setSetting('tts_provider', partial.provider)
  return getTtsConfig()
}

export async function getConfig(): Promise<AppConfig> {
  return {
    app_name: await getSetting('app_name', DEFAULT_APP_NAME),
    app_favicon: await getSetting('app_favicon', ''),
    app_background: await getSetting('app_background', ''),
    api_endpoint: await getSetting('api_endpoint', env.OPENAI_BASE_URL),
    api_key: await getSetting('api_key', env.OPENAI_API_KEY),
    support_attachments: (await getSetting('support_attachments', 'true')) === 'true',
    support_infinite_mode: (await getSetting('support_infinite_mode', 'true')) === 'true',
    allow_im_conversations: (await getSetting('allow_im_conversations', 'true')) === 'true',
    show_github: (await getSetting('show_github', 'true')) === 'true',
    use_external_image_hosting: (await getSetting('use_external_image_hosting', 'false')) === 'true',
    recommended_questions: JSON.parse(await getSetting('recommended_questions', '[]')),
    followup_questions: JSON.parse(await getSetting('followup_questions', '[]')),
    oauth_providers: JSON.parse(await getSetting('oauth_providers', '[]')),
  }
}

export async function updateConfig(partial: Partial<AppConfig>): Promise<AppConfig> {
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) {
      const boolKeys = ['support_attachments', 'support_infinite_mode', 'allow_im_conversations', 'show_github', 'use_external_image_hosting']
      const jsonKeys = ['recommended_questions', 'followup_questions', 'oauth_providers']
      let stored: string
      if (jsonKeys.includes(key)) {
        stored = JSON.stringify(value)
      } else if (boolKeys.includes(key)) {
        stored = value ? 'true' : 'false'
      } else {
        stored = value as string
      }
      await setSetting(key, stored as string)
    }
  }
  return getConfig()
}

// ---- Agent CRUD ----

export async function listAgents(): Promise<Agent[]> {
  const rows = await db.select().from(agents).orderBy(agents.created_at).all()
  return rows.map((r: typeof agents.$inferSelect) => ({
    id: r.id,
    name: r.name,
    model: r.model,
    system_prompt: r.system_prompt,
    avatar: r.avatar,
    role: r.role as Agent['role'],
    created_at: r.created_at,
    voice_enabled: r.voice_enabled,
    voice_sample_url: r.voice_sample_url,
    voice_settings: r.voice_settings,
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
    voice_enabled: row.voice_enabled,
    voice_sample_url: row.voice_sample_url,
    voice_settings: row.voice_settings,
  }
}

export async function createAgent(name: string, model: string, systemPrompt: string, avatar = '', role: Agent['role'] = 'default', voiceEnabled = false, voiceSampleUrl = '', voiceSettings = '{}'): Promise<Agent> {
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
    voice_enabled: voiceEnabled,
    voice_sample_url: voiceSampleUrl,
    voice_settings: voiceSettings,
  } as any).run()
  return { id, name, model, system_prompt: systemPrompt, avatar, role, created_at: now, voice_enabled: voiceEnabled, voice_sample_url: voiceSampleUrl, voice_settings: voiceSettings }
}

export async function updateAgent(id: string, partial: Partial<Pick<Agent, 'name' | 'model' | 'system_prompt' | 'avatar' | 'voice_enabled' | 'voice_sample_url' | 'voice_settings'>>): Promise<Agent | null> {
  const existing = await getAgent(id)
  if (!existing) return null
  const updates: Record<string, unknown> = {}
  if (partial.name !== undefined) updates.name = partial.name
  if (partial.model !== undefined) updates.model = partial.model
  if (partial.system_prompt !== undefined) updates.system_prompt = partial.system_prompt
  if (partial.avatar !== undefined) updates.avatar = partial.avatar
  if (partial.voice_enabled !== undefined) updates.voice_enabled = partial.voice_enabled ? 1 : 0
  if (partial.voice_sample_url !== undefined) updates.voice_sample_url = partial.voice_sample_url
  if (partial.voice_settings !== undefined) updates.voice_settings = partial.voice_settings
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

// ---- Bootstrap: ensure neutral + at least one non-neutral agent exist ----

export async function bootstrapAgents(): Promise<void> {
  const all = await listAgents()
  const model = env.OPENAI_MODEL

  if (!all.some((a) => a.id === NEUTRAL_AGENT_ID)) {
    await createAgent(NEUTRAL_AGENT_NAME, model, '', '', 'neutral')
    console.log(`[bootstrap] Created neutral agent "${NEUTRAL_AGENT_NAME}" with model "${model}"`)
  }

  if (!all.some((a) => a.role !== 'neutral')) {
    await createAgent('Momoi', model, '')
    console.log(`[bootstrap] Created default agent "Momoi" with model "${model}"`)
  }
}

// ---- MCP Server CRUD ----

export async function listMcpServers(): Promise<McpServerConfig[]> {
  const rows = await db.select().from(mcpServers).orderBy(mcpServers.created_at).all()
  return rows.map((r: typeof mcpServers.$inferSelect) => ({
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

// ---- User-Agent Memory CRUD ----

/** Latest N memories for a user+agent pair, returned in chronological order
 *  (oldest first) so the injected numbered list reads as a timeline. */
export async function getUserAgentMemories(userId: string, agentId: string, limit = 30): Promise<string[]> {
  const rows = await db.select({ content: userAgentMemories.content })
    .from(userAgentMemories)
    .where(and(eq(userAgentMemories.user_id, userId), eq(userAgentMemories.agent_id, agentId)))
    .orderBy(desc(userAgentMemories.created_at))
    .limit(limit)
    .all()
  // Take the latest N, then restore chronological order for prompt injection.
  return rows.map((r: typeof userAgentMemories.$inferSelect) => r.content).reverse()
}

/** Save a new memory for a user+agent pair. Returns the created row. */
export async function saveUserAgentMemory(
  userId: string,
  agentId: string,
  content: string,
  source: 'agent' | 'user' = 'agent',
): Promise<UserAgentMemory> {
  const row: UserAgentMemory = {
    id: randomUUID(),
    user_id: userId,
    agent_id: agentId,
    content,
    source,
    created_at: Math.floor(Date.now() / 1000),
  }
  await db.insert(userAgentMemories).values(row).run()
  return row
}

/** Delete all memories for a specific user (admin "forget" action). Returns count deleted. */
export async function deleteUserMemories(userId: string): Promise<number> {
  const rows = await db.select({ id: userAgentMemories.id })
    .from(userAgentMemories)
    .where(eq(userAgentMemories.user_id, userId))
    .all()
  if (rows.length > 0) {
    await db.delete(userAgentMemories)
      .where(eq(userAgentMemories.user_id, userId))
      .run()
  }
  return rows.length
}

// ---- User memory management (memory management view) ----

/** All memory rows of a user across agents, newest first (management UI, unpaged). */
export async function listUserMemories(userId: string): Promise<UserAgentMemory[]> {
  const rows = await db.select().from(userAgentMemories)
    .where(eq(userAgentMemories.user_id, userId))
    .orderBy(desc(userAgentMemories.created_at))
    .all()
  return rows as unknown as UserAgentMemory[]
}

/** Update one memory's content. Scoped to owner (id + user_id); created_at is
 *  intentionally NOT bumped — it marks creation time, keeping the injection timeline stable. */
export async function updateUserAgentMemory(userId: string, id: string, content: string): Promise<UserAgentMemory | null> {
  const scope = and(eq(userAgentMemories.id, id), eq(userAgentMemories.user_id, userId))
  const existing = await db.select().from(userAgentMemories).where(scope).get()
  if (!existing) return null
  await db.update(userAgentMemories).set({ content }).where(scope).run()
  const row = await db.select().from(userAgentMemories).where(scope).get()
  return (row as unknown as UserAgentMemory) ?? null
}

/** Delete one memory. Scoped to owner (id + user_id). Returns true if a row was deleted. */
export async function deleteUserAgentMemory(userId: string, id: string): Promise<boolean> {
  const scope = and(eq(userAgentMemories.id, id), eq(userAgentMemories.user_id, userId))
  const existing = await db.select({ id: userAgentMemories.id }).from(userAgentMemories).where(scope).get()
  if (!existing) return false
  await db.delete(userAgentMemories).where(scope).run()
  return true
}

/** Delete ALL memories of a user+agent pair ("clear this agent's memories"). Returns count deleted. */
export async function deleteUserAgentMemories(userId: string, agentId: string): Promise<number> {
  const scope = and(eq(userAgentMemories.user_id, userId), eq(userAgentMemories.agent_id, agentId))
  const rows = await db.select({ id: userAgentMemories.id }).from(userAgentMemories).where(scope).all()
  if (rows.length > 0) {
    await db.delete(userAgentMemories).where(scope).run()
  }
  return rows.length
}