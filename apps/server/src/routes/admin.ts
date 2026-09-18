import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { eq } from 'drizzle-orm'
import { adminAuthMiddleware } from '../auth.js'
import { getConfig, updateConfig, listAgents, createAgent, updateAgent, deleteAgent, listMcpServers, getMcpServer, createMcpServer, updateMcpServer, deleteMcpServer, isDirectRegistrationOpen, setDirectRegistrationOpen, isOauthRegistrationOpen, setOauthRegistrationOpen, isExternalImageHostingEnabled, getTtsConfig, updateTtsConfig } from '../config.js'
import { base64ToBuffer, uploadToCdn } from '../cdn.js'
import { DEFAULT_API_ENDPOINT, DEFAULT_MODEL } from '@momoi/shared/constants'
import fs from 'fs'
import path from 'path'
import { NEUTRAL_AGENT_ID } from '@momoi/shared/constants'
import { db, conversations, messages, users, userOauthBindings, agents, wechatBindings, qqBindings, qqGroupConversations } from '../db.js'
import { skillRegistry } from '../skills/loader.js'
import AdmZip from 'adm-zip'
import { stopBotForUser, stopAllBotsForUser } from '../qq/manager.js'

import { repoRoot } from '../paths.js'

export const adminRoute = new Hono()

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024 // 50MB

// All admin endpoints authenticate with the ordinary user JWT; the middleware
// additionally requires the username to be in the ADMIN env list (401/403).
adminRoute.use('/config', adminAuthMiddleware)
adminRoute.use('/agents', adminAuthMiddleware)
adminRoute.use('/agents/*', adminAuthMiddleware)
adminRoute.use('/skills/*', adminAuthMiddleware)
adminRoute.use('/mcp-servers', adminAuthMiddleware)
adminRoute.use('/mcp-servers/*', adminAuthMiddleware)
// '/stats' alone does NOT match sub-paths (e.g. /stats/conversations) in Hono —
// mount both the exact and wildcard forms so every stats endpoint is protected.
adminRoute.use('/stats', adminAuthMiddleware)
adminRoute.use('/stats/*', adminAuthMiddleware)
adminRoute.use('/users', adminAuthMiddleware)
adminRoute.use('/users/*', adminAuthMiddleware)
adminRoute.use('/tts', adminAuthMiddleware)
adminRoute.use('/tts/*', adminAuthMiddleware)
adminRoute.use('/direct-registration', adminAuthMiddleware)
adminRoute.use('/oauth-registration', adminAuthMiddleware)

// Get current config
adminRoute.get('/config', async (c) => {
  const config = await getConfig()
  return c.json(config)
})

// Update config
adminRoute.put('/config', async (c) => {
  const body = await c.req.json()

  // External image hosting: convert base64 images → CDN URLs before saving
  if (await isExternalImageHostingEnabled()) {
    for (const key of ['app_favicon', 'app_background'] as const) {
      const val = body[key]
      if (val && typeof val === 'string' && val.startsWith('data:')) {
        try {
          const { buffer, mimeType } = base64ToBuffer(val)
          body[key] = await uploadToCdn(buffer, key === 'app_favicon' ? 'favicon.png' : 'background.png', mimeType)
        } catch (err) {
          console.warn(`Failed to upload ${key} to CDN, keeping base64:`, (err as Error).message)
        }
      }
    }
  }

  const config = await updateConfig(body)
  return c.json(config)
})

// Get gateway defaults from .env (real-time file read, not cached)
adminRoute.get('/config/env-gateway', async (c) => {
  const envPath = path.resolve(repoRoot(), '.env')
  const envVars: Record<string, string> = {}
  try {
    const raw = fs.readFileSync(envPath, 'utf-8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const val = trimmed.slice(eqIdx + 1).trim()
      envVars[key] = val
    }
  } catch {
    // .env not found, fall back to process.env
  }

  return c.json({
    api_endpoint: envVars['OPENAI_BASE_URL'] || process.env.OPENAI_BASE_URL || DEFAULT_API_ENDPOINT,
    api_key: envVars['OPENAI_API_KEY'] || process.env.OPENAI_API_KEY || '',
    model: envVars['OPENAI_MODEL'] || process.env.OPENAI_MODEL || DEFAULT_MODEL,
  })
})

// ---- Agent CRUD ----

adminRoute.get('/agents', async (c) => {
  const agents = await listAgents()
  return c.json({ agents })
})

adminRoute.post('/agents', async (c) => {
  const body = await c.req.json<{ name: string; model: string; system_prompt: string; avatar?: string; voice_enabled?: boolean; voice_sample_url?: string; voice_settings?: string }>()
  if (!body.name?.trim()) {
    return c.json({ error: 'Agent name is required' }, 400)
  }

  // External image hosting: convert base64 avatar → CDN URL
  if (body.avatar && body.avatar.startsWith('data:') && await isExternalImageHostingEnabled()) {
    try {
      const { buffer, mimeType } = base64ToBuffer(body.avatar)
      body.avatar = await uploadToCdn(buffer, 'avatar.png', mimeType)
    } catch (err) {
      console.warn('Failed to upload agent avatar to CDN, keeping base64:', (err as Error).message)
    }
  }

  const agent = await createAgent(body.name.trim(), body.model || '', body.system_prompt || '', body.avatar || '', 'default', body.voice_enabled ?? false, body.voice_sample_url || '', body.voice_settings || '{}')
  return c.json({ agent })
})

adminRoute.put('/agents/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ name?: string; model?: string; system_prompt?: string; avatar?: string; voice_enabled?: boolean; voice_sample_url?: string; voice_settings?: string }>()

  // Neutral agent: only model, system_prompt can be changed (and voice fields)
  if (id === NEUTRAL_AGENT_ID) {
    delete body.name
    delete body.avatar
  }

  // External image hosting: convert base64 avatar → CDN URL
  if (body.avatar && body.avatar.startsWith('data:') && await isExternalImageHostingEnabled()) {
    try {
      const { buffer, mimeType } = base64ToBuffer(body.avatar)
      body.avatar = await uploadToCdn(buffer, 'avatar.png', mimeType)
    } catch (err) {
      console.warn('Failed to upload agent avatar to CDN, keeping base64:', (err as Error).message)
    }
  }

  const agent = await updateAgent(id, body)
  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404)
  }
  return c.json({ agent })
})

adminRoute.delete('/agents/:id', async (c) => {
  const id = c.req.param('id')

  // Neutral agent cannot be deleted
  if (id === NEUTRAL_AGENT_ID) {
    return c.json({ error: 'Neutral agent cannot be deleted' }, 403)
  }

  const ok = await deleteAgent(id)
  if (!ok) {
    return c.json({ error: 'Agent not found' }, 404)
  }
  return c.json({ success: true })
})

// Statistics: overall counts
adminRoute.get('/stats', async (c) => {
  const [userCount] = await db
    .select({ value: sql<number>`count(*)` })
    .from(users)
    .all()

  const [convCount] = await db
    .select({ value: sql<number>`count(*)` })
    .from(conversations)
    .all()

  const [msgCount] = await db
    .select({ value: sql<number>`count(*)` })
    .from(messages)
    .all()

  return c.json({
    total_users: userCount?.value ?? 0,
    total_conversations: convCount?.value ?? 0,
    total_messages: msgCount?.value ?? 0,
  })
})

// Statistics: all conversations with user info and message counts
adminRoute.get('/stats/conversations', async (c) => {
  const rows = await db
    .select({
      id: conversations.id,
      user_id: conversations.user_id,
      title: conversations.title,
      created_at: conversations.created_at,
      updated_at: conversations.updated_at,
      message_count: sql<number>`count(${messages.id})`,
    })
    .from(conversations)
    .leftJoin(messages, sql`${messages.conversation_id} = ${conversations.id}`)
    .groupBy(conversations.id)
    .orderBy(sql`${conversations.updated_at} desc`)
    .all()

  return c.json({ conversations: rows })
})

// Statistics: get messages for a specific conversation
adminRoute.get('/stats/conversations/:id/messages', async (c) => {
  const id = c.req.param('id')

  const conv = await db
    .select()
    .from(conversations)
    .where(sql`${conversations.id} = ${id}`)
    .get()

  if (!conv) {
    return c.json({ error: 'Conversation not found' }, 404)
  }

  const msgs = await db
    .select()
    .from(messages)
    .where(sql`${messages.conversation_id} = ${id}`)
    .orderBy(sql`${messages.created_at} asc`)
    .all()

  return c.json({
    conversation: conv,
    messages: msgs.map((m: typeof messages.$inferSelect) => ({
      ...m,
      tool_calls: m.tool_calls ? JSON.parse(m.tool_calls) : null,
      suggestions: m.suggestions ? JSON.parse(m.suggestions) : null,
      attachments: m.attachments ? JSON.parse(m.attachments) : null,
    })),
  })
})

// ---- User Management ----

// List all users (paginated)
adminRoute.get('/users', async (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10))
  const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('page_size') || '10', 10)))
  const offset = (page - 1) * pageSize

  const [total] = await db.select({ count: sql<number>`count(*)` }).from(users).all()
  const rows = await db
    .select()
    .from(users)
    .orderBy(users.first_login_at)
    .limit(pageSize)
    .offset(offset)
    .all()

  // Fetch OAuth2 bindings for all listed users
  const usernames = rows.map((r: typeof users.$inferSelect) => r.username)
  const allBindings = usernames.length > 0
    ? await db.select().from(userOauthBindings).all()
    : []
  const bindingsByUser = new Map<string, string[]>()
  for (const b of allBindings) {
    if (!bindingsByUser.has(b.user_id)) bindingsByUser.set(b.user_id, [])
    bindingsByUser.get(b.user_id)!.push(b.provider_id)
  }

  return c.json({
    users: rows.map((r: typeof users.$inferSelect) => ({
      username: r.username,
      first_login_at: r.first_login_at,
      last_login_at: r.last_login_at,
      last_active_at: r.last_active_at ?? null,
      banned: r.banned,
      oauth_providers: bindingsByUser.get(r.username) ?? [],
    })),
    total: total?.count ?? 0,
    page,
    page_size: pageSize,
  })
})

// Ban / unban a user
adminRoute.put('/users/:username/ban', async (c) => {
  const username = c.req.param('username')
  const adminUser = (c as any).get('userId') as string

  if (username === adminUser) {
    return c.json({ error: 'Cannot ban yourself' }, 403)
  }

  const { banned } = await c.req.json<{ banned: boolean }>()
  const existing = await db.select().from(users).where(eq(users.username, username)).get()
  if (!existing) {
    return c.json({ error: 'User not found' }, 404)
  }

  await db.update(users).set({ banned }).where(eq(users.username, username)).run()
  return c.json({ success: true, banned })
})

// Delete a user and all their data
adminRoute.delete('/users/:username', async (c) => {
  const username = c.req.param('username')
  const adminUser = (c as any).get('userId') as string

  if (username === adminUser) {
    return c.json({ error: 'Cannot delete yourself' }, 403)
  }

  const userRow = await db.select().from(users).where(eq(users.username, username)).get()
  if (!userRow) {
    return c.json({ error: 'User not found' }, 404)
  }

  // Delete all conversations (cascades to messages, group_conversation_agents)
  await db.delete(conversations).where(eq(conversations.user_id, username)).run()
  // Delete WeChat binding (sql.js has foreign_keys OFF by default,
  // so cascade cannot be relied on — clean up explicitly).
  await db.delete(wechatBindings).where(eq(wechatBindings.user_id, username)).run()
  // Delete QQ binding + stop all gateway connections for this user.
  // With per-agent bindings, there may be multiple connections to tear down.
  const allQqBindings = await db.select().from(qqBindings)
    .where(eq(qqBindings.user_id, username)).all()
  for (const b of allQqBindings) {
    stopBotForUser(username, b.agent_id)
    if (b.app_id) {
      await db.delete(qqGroupConversations)
        .where(eq(qqGroupConversations.app_id, b.app_id)).run()
    }
  }
  await db.delete(qqBindings).where(eq(qqBindings.user_id, username)).run()
  // Delete user record
  await db.delete(users).where(eq(users.username, username)).run()

  return c.json({ success: true })
})

// Direct registration toggle
adminRoute.get('/direct-registration', async (c) => {
  const open = await isDirectRegistrationOpen()
  return c.json({ direct_registration_open: open })
})

adminRoute.put('/direct-registration', async (c) => {
  const { open } = await c.req.json<{ open: boolean }>()
  await setDirectRegistrationOpen(open)
  return c.json({ direct_registration_open: open })
})

// OAuth registration toggle
adminRoute.get('/oauth-registration', async (c) => {
  const open = await isOauthRegistrationOpen()
  return c.json({ oauth_registration_open: open })
})

adminRoute.put('/oauth-registration', async (c) => {
  const { open } = await c.req.json<{ open: boolean }>()
  await setOauthRegistrationOpen(open)
  return c.json({ oauth_registration_open: open })
})

// List skills
adminRoute.get('/skills', (c) => {
  return c.json({ skills: skillRegistry.getAll() })
})

// Upload skill from zip
adminRoute.post('/skills/upload', async (c) => {
  const tmpDir = path.resolve(repoRoot(), 'skills', `__upload_tmp_${Date.now()}`)
  try {
    const body = await c.req.parseBody()
    const file = body['file']

    if (!file || typeof file === 'string') {
      return c.json({ error: 'No file provided' }, 400)
    }

    if (file.size > MAX_UPLOAD_SIZE) {
      return c.json({ error: 'File too large (max 50MB)' }, 400)
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const zip = new AdmZip(buffer)

    // Zip slip protection
    for (const entry of zip.getEntries()) {
      if (entry.entryName.includes('..')) {
        return c.json({ error: 'Invalid zip: path traversal detected' }, 400)
      }
    }

    // Detect wrapper directory
    const { wrapperDir } = resolveZipRoot(zip)

    // Extract to temp directory
    fs.mkdirSync(tmpDir, { recursive: true })
    zip.extractAllTo(tmpDir, true)

    // Determine actual content directory
    const actualDir = wrapperDir ? path.join(tmpDir, wrapperDir) : tmpDir

    // Clean up macOS artifacts
    cleanMacOSArtifacts(actualDir)

    // Validate SKILL.md exists
    const skillPath = path.join(actualDir, 'SKILL.md')
    if (!fs.existsSync(skillPath)) {
      return c.json({ error: 'No valid SKILL.md found in archive' }, 400)
    }

    // Parse frontmatter to get skill name
    const raw = fs.readFileSync(skillPath, 'utf-8')
    const match = raw.match(/^---\n([\s\S]*?)\n---\n/)
    if (!match) {
      return c.json({ error: 'Invalid SKILL.md: missing frontmatter' }, 400)
    }

    const yamlStr = match[1]
    let skillName = ''
    for (const line of yamlStr.split('\n')) {
      const m = line.match(/^name:\s*(.+)$/)
      if (m) {
        skillName = m[1].replace(/^['"]|['"]$/g, '')
        break
      }
    }

    if (!skillName) {
      return c.json({ error: 'Invalid SKILL.md: name is required in frontmatter' }, 400)
    }

    // Move to final destination
    const destDir = path.resolve(repoRoot(), 'skills', skillName)
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true })
    }
    fs.renameSync(actualDir, destDir)

    // Clean up temp directory
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true })
    }

    skillRegistry.refresh()
    return c.json({ success: true, skills: skillRegistry.getAll() })
  } catch (err: any) {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true })
    }
    console.error('Skill upload failed:', err)
    return c.json({ error: err.message || 'Upload failed' }, 500)
  }
})

// Install skill
adminRoute.post('/skills/install', async (c) => {
  const body = await c.req.json<{ name: string }>()
  const skillDir = path.resolve(repoRoot(), 'skills', body.name)

  if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
    return c.json({ error: `Skill "${body.name}" not found or missing SKILL.md` }, 404)
  }

  skillRegistry.refresh()
  return c.json({ success: true, skills: skillRegistry.getAll() })
})

// Uninstall skill
adminRoute.delete('/skills/:name', (c) => {
  const name = c.req.param('name')
  const skillDir = path.resolve(repoRoot(), 'skills', name)

  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true })
  }

  skillRegistry.refresh()
  return c.json({ success: true, skills: skillRegistry.getAll() })
})

// ---- MCP Server CRUD ----

adminRoute.get('/mcp-servers', async (c) => {
  const servers = await listMcpServers()
  return c.json({ servers })
})

adminRoute.post('/mcp-servers', async (c) => {
  const body = await c.req.json<{ name: string; url: string }>()
  if (!body.name?.trim() || !body.url?.trim()) {
    return c.json({ error: 'Name and URL are required' }, 400)
  }
  const server = await createMcpServer(body.name.trim(), body.url.trim())
  return c.json({ server })
})

adminRoute.put('/mcp-servers/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ name?: string; url?: string; enabled?: boolean }>()
  const server = await updateMcpServer(id, body)
  if (!server) return c.json({ error: 'MCP server not found' }, 404)
  return c.json({ server })
})

adminRoute.delete('/mcp-servers/:id', async (c) => {
  const id = c.req.param('id')
  const ok = await deleteMcpServer(id)
  if (!ok) return c.json({ error: 'MCP server not found' }, 404)
  return c.json({ success: true })
})

// --- Helpers ---

/** Determine if a zip has a single wrapper directory */
function resolveZipRoot(zip: AdmZip): { wrapperDir: string | null } {
  const entries = zip.getEntries().filter(
    (e) => !e.entryName.startsWith('__MACOSX') && !e.entryName.endsWith('.DS_Store')
  )
  if (entries.length === 0) return { wrapperDir: null }

  const topDirs = new Set<string>()
  let hasRootFile = false

  for (const entry of entries) {
    const parts = entry.entryName.split('/')
    if (parts.length <= 1) {
      hasRootFile = true
      break
    }
    topDirs.add(parts[0])
  }

  if (hasRootFile || topDirs.size !== 1) return { wrapperDir: null }
  return { wrapperDir: [...topDirs][0] }
}

/** Remove __MACOSX directories and .DS_Store files */
function cleanMacOSArtifacts(dir: string): void {
  const macosDir = path.join(dir, '__MACOSX')
  if (fs.existsSync(macosDir)) {
    fs.rmSync(macosDir, { recursive: true })
  }

  function removeDSStore(d: string) {
    const dsStore = path.join(d, '.DS_Store')
    if (fs.existsSync(dsStore)) fs.unlinkSync(dsStore)
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) removeDSStore(path.join(d, entry.name))
    }
  }
  removeDSStore(dir)
}

// ---- TTS Config ----

adminRoute.get('/tts/config', async (c) => {
  const config = await getTtsConfig()
  return c.json(config)
})

adminRoute.put('/tts/config', async (c) => {
  const body = await c.req.json<{ endpoint?: string; provider?: string }>()
  const config = await updateTtsConfig(body)
  return c.json(config)
})

// ---- Agent Voice Management ----

adminRoute.post('/agents/:id/voice/upload', async (c) => {
  const id = c.req.param('id')
  const agent = await getAgentStub(id)
  if (!agent) return c.json({ error: 'Agent not found' }, 404)

  const body = await c.req.parseBody()
  const file = body['file']
  if (!file || typeof file === 'string') {
    return c.json({ error: 'No audio file provided' }, 400)
  }

  const MAX_AUDIO_SIZE = 10 * 1024 * 1024 // 10MB
  if (file.size > MAX_AUDIO_SIZE) {
    return c.json({ error: 'File too large (max 10MB)' }, 400)
  }

  // Validate audio type
  const ext = path.extname(file.name).toLowerCase()
  const allowedExts = ['.wav', '.mp3', '.ogg', '.m4a', '.flac']
  if (!allowedExts.includes(ext)) {
    return c.json({ error: `Unsupported audio format: ${ext}. Allowed: ${allowedExts.join(', ')}` }, 400)
  }

  const voiceDir = path.resolve(repoRoot(), 'data', 'voice', id)
  if (!fs.existsSync(voiceDir)) fs.mkdirSync(voiceDir, { recursive: true })

  const filename = `sample${ext}`
  const filePath = path.join(voiceDir, filename)
  const buffer = Buffer.from(await file.arrayBuffer())
  fs.writeFileSync(filePath, buffer)

  const sampleUrl = `/api/assets/voice/${id}/${filename}`
  await updateAgent(id, { voice_sample_url: sampleUrl })

  return c.json({ success: true, sample_url: sampleUrl })
})

adminRoute.post('/agents/:id/voice/clone', async (c) => {
  const id = c.req.param('id')
  const agent = await getAgentStub(id)
  if (!agent) return c.json({ error: 'Agent not found' }, 404)

  const samplePath = path.resolve(repoRoot(), 'data', 'voice', id, 'sample.wav')
  if (!fs.existsSync(samplePath)) {
    // Try mp3
    const mp3Path = path.resolve(repoRoot(), 'data', 'voice', id, 'sample.mp3')
    if (!fs.existsSync(mp3Path)) {
      return c.json({ error: 'No voice sample uploaded. Please upload a reference audio first.' }, 400)
    }
  }

  const ttsConfig = await getTtsConfig()
  try {
    const { createTtsProvider } = await import('../ai/tts.js')
    const provider = createTtsProvider({ endpoint: ttsConfig.endpoint, type: ttsConfig.provider })
    const audioPath = fs.existsSync(samplePath) ? samplePath : path.resolve(repoRoot(), 'data', 'voice', id, 'sample.mp3')
    const speakerId = await provider.registerVoice(audioPath)

    const currentVoice = parseOrEmpty(agent.voice_settings)
    currentVoice.speakerId = speakerId
    currentVoice.provider = ttsConfig.provider
    await updateAgent(id, { voice_settings: JSON.stringify(currentVoice) })

    return c.json({ success: true, speaker_id: speakerId })
  } catch (err: any) {
    console.error('Voice clone failed:', err)
    return c.json({ error: `Voice clone failed: ${err.message}` }, 500)
  }
})

adminRoute.get('/agents/:id/voice/status', async (c) => {
  const id = c.req.param('id')
  const agent = await getAgentStub(id)
  if (!agent) return c.json({ error: 'Agent not found' }, 404)

  const settings = parseOrEmpty(agent.voice_settings)
  return c.json({
    speaker_id: settings.speakerId || null,
    sample_url: agent.voice_sample_url || null,
    voice_enabled: agent.voice_enabled,
  })
})

adminRoute.delete('/agents/:id/voice', async (c) => {
  const id = c.req.param('id')
  const agent = await getAgentStub(id)
  if (!agent) return c.json({ error: 'Agent not found' }, 404)

  const voiceDir = path.resolve(repoRoot(), 'data', 'voice', id)
  if (fs.existsSync(voiceDir)) {
    fs.rmSync(voiceDir, { recursive: true })
  }

  await updateAgent(id, { voice_enabled: false, voice_sample_url: '', voice_settings: '{}' })
  return c.json({ success: true })
})

// Helper: get agent without full import cycle
async function getAgentStub(id: string): Promise<import('@momoi/shared/types').Agent | null> {
  const row = await db.select().from(agents).where(eq(agents.id, id)).get()
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    model: row.model,
    system_prompt: row.system_prompt,
    avatar: row.avatar,
    role: row.role as any,
    created_at: row.created_at,
    voice_enabled: (row as any).voice_enabled ?? false,
    voice_sample_url: (row as any).voice_sample_url ?? '',
    voice_settings: (row as any).voice_settings ?? '{}',
  }
}

function parseOrEmpty(json: string): Record<string, any> {
  try { return JSON.parse(json) } catch { return {} }
}
