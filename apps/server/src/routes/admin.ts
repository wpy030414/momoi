import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { eq } from 'drizzle-orm'
import { ErrCode } from '@momoi/shared/errors'
import { adminAuthMiddleware } from '../lib/auth.js'
import { ApiError } from '../lib/apiError.js'
import { getConfig, updateConfig, listAgents, createAgent, updateAgent, deleteAgent, listMcpServers, getMcpServer, createMcpServer, updateMcpServer, deleteMcpServer, isDirectRegistrationOpen, setDirectRegistrationOpen, isOauthRegistrationOpen, setOauthRegistrationOpen, isExternalImageHostingEnabled, getTtsConfig, updateTtsConfig, deleteUserMemories } from '../lib/config.js'
import { base64ToBuffer, uploadToCdn } from '../lib/cdn.js'
import { DEFAULT_API_ENDPOINT, DEFAULT_MODEL } from '@momoi/shared/constants'
import fs from 'fs'
import path from 'path'
import { NEUTRAL_AGENT_ID, NEUTRAL_AGENT_NAME } from '@momoi/shared/constants'
import { db, conversations, messages, users, userOauthBindings, agents, wechatBindings, qqBindings, qqGroupConversations, userAgentMemories } from '../db/index.js'
import { skillRegistry } from '../skills/loader.js'
import { buildExportBundle, stringifyExportYAML, parseImportYAML, validateImportBundle, summarizeImport, applyImportBundle } from '../lib/config-transfer.js'
import AdmZip from 'adm-zip'
import { stopBotForUser, stopAllBotsForUser } from '../im/qq/manager.js'
import { promptsRoute } from './prompts.js'

import { repoRoot } from '../lib/paths.js'

export const adminRoute = new Hono()

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024 // 50MB

// All admin endpoints authenticate with the ordinary user JWT; the middleware
// additionally requires the username to be in the ADMIN env list (401/403).
adminRoute.use('/config', adminAuthMiddleware)
// Hono 的 use('/config') 是精确匹配，不覆盖子路径——补通配形式保护
// /config/env-gateway（返回 OPENAI_API_KEY）及后续 /config/* 端点。
adminRoute.use('/config/*', adminAuthMiddleware)
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
adminRoute.use('/prompts', adminAuthMiddleware)
adminRoute.use('/prompts/*', adminAuthMiddleware)

// 提示词目录与预览（提示词规则引擎的运行时入口，见 routes/prompts.ts）
adminRoute.route('/prompts', promptsRoute)

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

// ---- Config transfer（配置导入导出，见 lib/config-transfer.ts） ----

// Export the limited settings bundle as a downloadable YAML file.
adminRoute.get('/config/export', async (c) => {
  const bundle = await buildExportBundle()
  const yamlText = stringifyExportYAML(bundle)
  return c.body(yamlText, 200, {
    'Content-Type': 'application/x-yaml; charset=utf-8',
    'Content-Disposition': `attachment; filename="config-output-${Date.now()}.yml"`,
  })
})

// Import (validate + apply). `?dry_run=1` only validates and returns the
// change summary. Validation failures also return HTTP 200 with the full
// structured error list — the client's generic error path would collapse
// them into a single message.
adminRoute.post('/config/import', async (c) => {
  const body = await c.req.json<{ content?: unknown }>().catch(() => null)
  if (!body || typeof body.content !== 'string' || body.content.trim() === '') {
    throw new ApiError(ErrCode.ADMIN_CONTENT_REQUIRED)
  }
  const dryRun = c.req.query('dry_run') === '1'

  const parsed = parseImportYAML(body.content)
  if (!parsed.ok) {
    return c.json({ ok: false, errors: [parsed.error], warnings: [] })
  }

  // 校验上下文：当前中立 Agent 名 + 既有 agent id 集（区分新建/更新）
  const validateWith = async () => {
    const all = await listAgents()
    const neutral = all.find((a) => a.id === NEUTRAL_AGENT_ID)
    return validateImportBundle(parsed.data, {
      currentNeutralAgentName: neutral?.name ?? NEUTRAL_AGENT_NAME,
      existingAgentIds: new Set(all.map((a) => a.id)),
    })
  }

  const validation = await validateWith()
  if (!validation.ok || !validation.bundle) {
    return c.json({ ok: false, errors: validation.errors, warnings: validation.warnings })
  }

  if (dryRun) {
    const summary = await summarizeImport(validation.bundle)
    return c.json({ ok: true, errors: [], warnings: validation.warnings, summary })
  }

  // 正式导入前重跑完整校验：dry-run 与确认之间服务端状态可能被并发修改
  //（如中立 Agent 已被改名），fail-fast 而不是应用过期数据。
  const revalidation = await validateWith()
  if (!revalidation.ok || !revalidation.bundle) {
    return c.json({ ok: false, errors: revalidation.errors, warnings: validation.warnings })
  }
  const applied = await applyImportBundle(revalidation.bundle)
  return c.json({ ok: true, errors: [], warnings: revalidation.warnings, applied })
})

// ---- Agent CRUD ----

adminRoute.get('/agents', async (c) => {
  const agents = await listAgents()
  return c.json({ agents })
})

adminRoute.post('/agents', async (c) => {
  const body = await c.req.json<{ name: string; model: string; system_prompt: string; avatar?: string; voice_enabled?: boolean; voice_sample_url?: string; voice_settings?: string }>()
  if (!body.name?.trim()) {
    throw new ApiError(ErrCode.ADMIN_AGENT_NAME_REQUIRED)
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
    throw new ApiError(ErrCode.ADMIN_AGENT_NOT_FOUND)
  }
  return c.json({ agent })
})

adminRoute.delete('/agents/:id', async (c) => {
  const id = c.req.param('id')

  // Neutral agent cannot be deleted
  if (id === NEUTRAL_AGENT_ID) {
    throw new ApiError(ErrCode.ADMIN_NEUTRAL_AGENT_DELETE)
  }

  const ok = await deleteAgent(id)
  if (!ok) {
    throw new ApiError(ErrCode.ADMIN_AGENT_NOT_FOUND)
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
    throw new ApiError(ErrCode.CONV_NOT_FOUND)
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
    ? await db.select().from(userOauthBindings)
        .where(sql`${userOauthBindings.user_id} IN (${sql.join(usernames.map((u: string) => sql`${u}`), sql`, `)})`)
        .all()
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
    throw new ApiError(ErrCode.ADMIN_CANNOT_BAN_SELF)
  }

  const { banned } = await c.req.json<{ banned: boolean }>()
  const existing = await db.select().from(users).where(eq(users.username, username)).get()
  if (!existing) {
    throw new ApiError(ErrCode.ADMIN_USER_NOT_FOUND)
  }

  await db.update(users).set({ banned }).where(eq(users.username, username)).run()
  return c.json({ success: true, banned })
})

// Delete a user and all their data
adminRoute.delete('/users/:username', async (c) => {
  const username = c.req.param('username')
  const adminUser = (c as any).get('userId') as string

  if (username === adminUser) {
    throw new ApiError(ErrCode.ADMIN_CANNOT_DELETE_SELF)
  }

  const userRow = await db.select().from(users).where(eq(users.username, username)).get()
  if (!userRow) {
    throw new ApiError(ErrCode.ADMIN_USER_NOT_FOUND)
  }

  // Delete all conversations (cascades to messages, group_conversation_agents)
  await db.delete(conversations).where(eq(conversations.user_id, username)).run()
  // Delete WeChat binding (sql.js has foreign_keys OFF by default,
  // so cascade cannot be relied on — clean up explicitly).
  await db.delete(wechatBindings).where(eq(wechatBindings.user_id, username)).run()
  // Delete QQ binding(s) + stop gateway connections for this user.
  // Batch delete qqGroupConversations instead of per-binding loop.
  const allQqBindings = await db.select().from(qqBindings)
    .where(eq(qqBindings.user_id, username)).all()
  const appIds = [...new Set(allQqBindings.map((b: typeof qqBindings.$inferSelect) => b.app_id).filter(Boolean))] as string[]
  for (const b of allQqBindings) stopBotForUser(username, b.agent_id)
  if (appIds.length > 0) {
    await db.delete(qqGroupConversations)
      .where(sql`${qqGroupConversations.app_id} IN (${sql.join(appIds.map((a: string) => sql`${a}`), sql`, `)})`)
      .run()
  }
  await db.delete(qqBindings).where(eq(qqBindings.user_id, username)).run()
  // Delete user-agent memories
  await db.delete(userAgentMemories).where(eq(userAgentMemories.user_id, username)).run()
  // Delete user record
  await db.delete(users).where(eq(users.username, username)).run()

  return c.json({ success: true })
})

// Delete all user-agent memories for a user ("遗忘" / Forget)
adminRoute.post('/users/:username/forget-memories', async (c) => {
  const username = c.req.param('username')
  const adminUser = (c as any).get('userId') as string

  if (username === adminUser) {
    throw new ApiError(ErrCode.ADMIN_CANNOT_FORGET_OWN)
  }

  const userRow = await db.select().from(users).where(eq(users.username, username)).get()
  if (!userRow) {
    throw new ApiError(ErrCode.ADMIN_USER_NOT_FOUND)
  }

  const count = await deleteUserMemories(username)
  return c.json({ success: true, deleted: count })
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
      throw new ApiError(ErrCode.ADMIN_SKILL_NO_FILE)
    }

    if (file.size > MAX_UPLOAD_SIZE) {
      throw new ApiError(ErrCode.ADMIN_SKILL_FILE_TOO_LARGE, { limit: '50MB' })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const zip = new AdmZip(buffer)

    // Zip slip protection
    for (const entry of zip.getEntries()) {
      if (entry.entryName.includes('..')) {
        throw new ApiError(ErrCode.ADMIN_SKILL_ZIP_TRAVERSAL)
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
      throw new ApiError(ErrCode.ADMIN_SKILL_NO_SKILL_MD)
    }

    // Parse frontmatter to get skill name
    const raw = fs.readFileSync(skillPath, 'utf-8')
    const match = raw.match(/^---\n([\s\S]*?)\n---\n/)
    if (!match) {
      throw new ApiError(ErrCode.ADMIN_SKILL_NO_FRONTMATTER)
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
      throw new ApiError(ErrCode.ADMIN_SKILL_NAME_REQUIRED)
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
    if (err instanceof ApiError) throw err
    throw new ApiError(
      ErrCode.UPLOAD_FAILED,
      { detail: (err.message || 'Upload failed').slice(0, 300) },
      { log: 'skill upload failed', cause: err },
    )
  }
})

// Install skill
adminRoute.post('/skills/install', async (c) => {
  const body = await c.req.json<{ name: string }>()
  const skillDir = path.resolve(repoRoot(), 'skills', body.name)

  if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
    throw new ApiError(ErrCode.ADMIN_SKILL_NOT_FOUND, { name: body.name })
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
    throw new ApiError(ErrCode.ADMIN_MCP_FIELDS_REQUIRED)
  }
  const server = await createMcpServer(body.name.trim(), body.url.trim())
  return c.json({ server })
})

adminRoute.put('/mcp-servers/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ name?: string; url?: string; enabled?: boolean }>()
  const server = await updateMcpServer(id, body)
  if (!server) throw new ApiError(ErrCode.ADMIN_MCP_NOT_FOUND)
  return c.json({ server })
})

adminRoute.delete('/mcp-servers/:id', async (c) => {
  const id = c.req.param('id')
  const ok = await deleteMcpServer(id)
  if (!ok) throw new ApiError(ErrCode.ADMIN_MCP_NOT_FOUND)
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
  if (!agent) throw new ApiError(ErrCode.ADMIN_AGENT_NOT_FOUND)

  const body = await c.req.parseBody()
  const file = body['file']
  if (!file || typeof file === 'string') {
    throw new ApiError(ErrCode.ADMIN_VOICE_NO_FILE)
  }

  const MAX_AUDIO_SIZE = 10 * 1024 * 1024 // 10MB
  if (file.size > MAX_AUDIO_SIZE) {
    throw new ApiError(ErrCode.ADMIN_VOICE_FILE_TOO_LARGE, { limit: '10MB' })
  }

  // Validate audio type
  const ext = path.extname(file.name).toLowerCase()
  const allowedExts = ['.wav', '.mp3', '.ogg', '.m4a', '.flac']
  if (!allowedExts.includes(ext)) {
    throw new ApiError(ErrCode.ADMIN_VOICE_FORMAT_UNSUPPORTED, { ext, allowed: allowedExts.join(', ') })
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
  if (!agent) throw new ApiError(ErrCode.ADMIN_AGENT_NOT_FOUND)

  const samplePath = path.resolve(repoRoot(), 'data', 'voice', id, 'sample.wav')
  if (!fs.existsSync(samplePath)) {
    // Try mp3
    const mp3Path = path.resolve(repoRoot(), 'data', 'voice', id, 'sample.mp3')
    if (!fs.existsSync(mp3Path)) {
      throw new ApiError(ErrCode.ADMIN_VOICE_NO_SAMPLE)
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
    if (err instanceof ApiError) throw err
    throw new ApiError(
      ErrCode.ADMIN_VOICE_CLONE_FAILED,
      { detail: String(err.message ?? '').slice(0, 300) },
      { log: 'voice clone failed', cause: err },
    )
  }
})

adminRoute.get('/agents/:id/voice/status', async (c) => {
  const id = c.req.param('id')
  const agent = await getAgentStub(id)
  if (!agent) throw new ApiError(ErrCode.ADMIN_AGENT_NOT_FOUND)

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
  if (!agent) throw new ApiError(ErrCode.ADMIN_AGENT_NOT_FOUND)

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
    voice_enabled: row.voice_enabled,
    voice_sample_url: row.voice_sample_url,
    voice_settings: row.voice_settings,
  }
}

function parseOrEmpty(json: string): Record<string, any> {
  try { return JSON.parse(json) } catch { return {} }
}
