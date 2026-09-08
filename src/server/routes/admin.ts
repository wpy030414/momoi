import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { sql } from 'drizzle-orm'
import { adminAuthMiddleware, signAdminToken, verifyAdminKey } from '../auth.js'
import { getConfig, updateConfig, listAgents, getAgent, createAgent, updateAgent, deleteAgent } from '../config.js'
import { NEUTRAL_AGENT_ID } from '../../shared/constants.js'
import { db } from '../db.js'
import { conversations, messages } from '../schema.js'
import { skillRegistry } from '../skills/loader.js'
import { cleanMacOSArtifacts, findUnsafeZipEntry, resolveZipRoot, sanitizeSkillName } from '../lib/zip.js'
import { parseAgentPackage, computeConflicts, planCommit, resolveDefaultModel } from '../agents-import/parser.js'
import {
  ImportStageLimitError,
  getStagedImport,
  hashSkillDir,
  installSkillTree,
  stageImport,
  takeStagedImport,
} from '../agents-import/store.js'
import type { AgentImportCommitRequest } from '../../shared/types.js'
import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'

export const adminRoute = new Hono()

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024 // 50MB

// Auth — verify admin key, return JWT
adminRoute.post('/auth', async (c) => {
  const body = await c.req.json<{ key: string }>()
  if (!verifyAdminKey(body.key)) {
    return c.json({ error: 'Invalid key' }, 401)
  }
  const result = await signAdminToken()
  return c.json(result)
})

// Protected routes below
adminRoute.use('/config', adminAuthMiddleware)
adminRoute.use('/agents', adminAuthMiddleware)
adminRoute.use('/agents/*', adminAuthMiddleware)
// Import endpoints: mount both the exact and wildcard forms explicitly
// ('/agents/*' covers them, but exact+wildcard keeps the protection obvious).
adminRoute.use('/agents/import', adminAuthMiddleware)
adminRoute.use('/agents/import/*', adminAuthMiddleware)
adminRoute.use('/skills/*', adminAuthMiddleware)
// '/stats' alone does NOT match sub-paths (e.g. /stats/conversations) in Hono —
// mount both the exact and wildcard forms so every stats endpoint is protected.
adminRoute.use('/stats', adminAuthMiddleware)
adminRoute.use('/stats/*', adminAuthMiddleware)

// Reject over-limit uploads before parseBody reads the whole body into memory
// (Content-Length is checked first; chunked bodies are counted while streaming).
const uploadBodyLimit = bodyLimit({
  maxSize: MAX_UPLOAD_SIZE + 1024 * 1024,
  onError: (c) => c.json({ error: 'File too large (max 50MB)' }, 400),
})
adminRoute.use('/agents/import', uploadBodyLimit)
adminRoute.use('/skills/upload', uploadBodyLimit)

// Get current config
adminRoute.get('/config', async (c) => {
  const config = await getConfig()
  return c.json(config)
})

// Update config
adminRoute.put('/config', async (c) => {
  const body = await c.req.json()
  const config = await updateConfig(body)
  return c.json(config)
})

// ---- Agent CRUD ----

adminRoute.get('/agents', async (c) => {
  const agents = await listAgents()
  return c.json({ agents })
})

adminRoute.post('/agents', async (c) => {
  const body = await c.req.json<{ name: string; model: string; system_prompt: string; avatar?: string }>()
  if (!body.name?.trim()) {
    return c.json({ error: 'Agent name is required' }, 400)
  }
  const agent = await createAgent(body.name.trim(), body.model || '', body.system_prompt || '', body.avatar || '')
  return c.json({ agent })
})

adminRoute.put('/agents/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json<{ name?: string; model?: string; system_prompt?: string; avatar?: string }>()

  // origin 仅由导入路径写入，用户 CRUD 不接受该字段
  delete (body as { origin?: unknown }).origin

  // Neutral agent: only model and system_prompt can be changed
  if (id === NEUTRAL_AGENT_ID) {
    delete body.name
    delete body.avatar
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

// ---- Agent package import (AIP) ----

/** 已装技能摘要：名称 + 文件树哈希，用于技能内容一致性判定 */
function installedSkillHashes() {
  return skillRegistry.getAll().map((skill) => ({ name: skill.manifest.name, contentHash: hashSkillDir(skill.path) }))
}

// Upload an AIP package → parse/validate → conflict preview (nothing is persisted yet)
adminRoute.post('/agents/import', async (c) => {
  const body = await c.req.parseBody()
  const raw = body['file']
  const file = Array.isArray(raw) ? raw[0] : raw

  if (!file || typeof file === 'string') {
    return c.json({ error: 'No file provided' }, 400)
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    return c.json({ error: 'File too large (max 50MB)' }, 400)
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const parsed = parseAgentPackage(buffer)
  if (!parsed.ok) {
    return c.json({ error: parsed.error }, 400)
  }

  const report = computeConflicts(parsed.data, await listAgents(), installedSkillHashes())
  let importId: string
  try {
    importId = stageImport(parsed.data)
  } catch (err) {
    if (err instanceof ImportStageLimitError) {
      return c.json({ error: err.message }, 413)
    }
    throw err
  }

  return c.json({
    import_id: importId,
    package: {
      name: parsed.data.package.name,
      version: parsed.data.package.version,
      host: parsed.data.package.host,
    },
    candidates: report.personas.map((entry) => ({
      id: entry.candidate.id,
      name: entry.candidate.name,
      primary: { file: entry.candidate.primaryFile, bytes: entry.candidate.primaryBytes },
      has_avatar: Boolean(entry.candidate.avatar),
      level_count: entry.candidate.levelCount,
      conflict: entry.conflict
        ? {
            agent_id: entry.conflict.agentId,
            agent_name: entry.conflict.agentName,
            same_origin: entry.conflict.sameOrigin,
          }
        : undefined,
    })),
    skills: report.skills.map((entry) => ({
      name: entry.candidate.name,
      description: entry.candidate.description,
      conflict: {
        installed: entry.conflict.installed,
        content_identical: entry.conflict.contentIdentical,
      },
    })),
    warnings: parsed.data.warnings,
    errors: parsed.data.errors,
  })
})

// Commit a staged import: atomically claim the staging entry, apply persona decisions, install skills
adminRoute.post('/agents/import/:import_id/commit', async (c) => {
  const importId = c.req.param('import_id')
  // 先窥视（不消耗）：请求体畸形或决议非法时仍可修正后重试
  const peeked = getStagedImport(importId)
  if (peeked.state === 'missing') return c.json({ error: 'Import not found' }, 404)
  if (peeked.state === 'expired') return c.json({ error: 'Import expired' }, 410)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json({ error: 'Invalid request body' }, 400)
  }
  const decisions = body as { personas?: unknown; skills?: unknown }
  if (!Array.isArray(decisions.personas) || !Array.isArray(decisions.skills)) {
    return c.json({ error: 'Invalid request body: "personas" and "skills" must be arrays' }, 400)
  }

  const existingAgents = await listAgents()
  const report = computeConflicts(peeked.data, existingAgents, installedSkillHashes())
  const plan = planCommit(peeked.data, body as AgentImportCommitRequest, report, resolveDefaultModel(existingAgents))
  if (plan.requestError) {
    return c.json({ error: plan.requestError }, 400)
  }

  // 原子取用：取出即删除，写入开始后不再回滚。两个并发 commit 只有一个能越过此点，
  // 另一个 404，因此逐条写入期间不会被重复导入。
  const staged = takeStagedImport(importId)
  if (staged.state === 'missing') return c.json({ error: 'Import not found' }, 404)
  if (staged.state === 'expired') return c.json({ error: 'Import expired' }, 410)

  const imported: Array<{ id: string; name: string }> = []
  const overwritten: Array<{ id: string; name: string }> = []
  const skipped: string[] = []
  const skillResult = { installed: [] as string[], overwritten: [] as string[], skipped: [] as string[] }
  const errors = [...plan.errors]

  for (const item of plan.personas) {
    try {
      if (item.kind === 'skip') {
        skipped.push(item.candidate.id)
        continue
      }
      if (item.kind === 'create') {
        const agent = await createAgent(
          item.name,
          item.model,
          item.candidate.systemPrompt,
          item.candidate.avatar ?? '',
          'default',
          item.origin,
        )
        imported.push({ id: agent.id, name: agent.name })
        continue
      }

      const targetId = item.targetAgentId
      const target = targetId ? await getAgent(targetId) : null
      if (!targetId || !target) {
        errors.push(`Persona "${item.candidate.id}": target agent not found`)
        continue
      }
      if (target.id === NEUTRAL_AGENT_ID || target.role === 'neutral') {
        errors.push(`Persona "${item.candidate.id}": the neutral agent cannot be overwritten`)
        continue
      }
      const updated = await updateAgent(targetId, {
        name: item.name,
        model: item.model,
        system_prompt: item.candidate.systemPrompt,
        avatar: item.candidate.avatar ?? '',
        origin: item.origin,
      })
      if (!updated) {
        errors.push(`Persona "${item.candidate.id}": target agent not found`)
        continue
      }
      overwritten.push({ id: updated.id, name: updated.name })
    } catch (err) {
      errors.push(`Persona "${item.candidate.id}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const skillsRoot = path.resolve('skills')
  let skillsChanged = false
  for (const item of plan.skills) {
    try {
      if (item.kind === 'skip') {
        skillResult.skipped.push(item.candidate.name)
        continue
      }
      const result = installSkillTree(skillsRoot, item.candidate.name, item.candidate.files, item.kind === 'overwrite')
      if (!result.ok) {
        errors.push(`Skill "${item.candidate.name}": ${result.error}`)
        continue
      }
      skillsChanged = true
      if (result.outcome === 'overwritten') skillResult.overwritten.push(item.candidate.name)
      else skillResult.installed.push(item.candidate.name)
    } catch (err) {
      errors.push(`Skill "${item.candidate.name}": ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (skillsChanged) skillRegistry.refresh()

  return c.json({ imported, overwritten, skipped, skills: skillResult, errors })
})

// Statistics: overall counts
adminRoute.get('/stats', async (c) => {
  const [userCount] = await db
    .select({ value: sql<number>`count(distinct ${conversations.user_id})` })
    .from(conversations)
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
    messages: msgs.map((m) => ({
      ...m,
      tool_calls: m.tool_calls ? JSON.parse(m.tool_calls) : null,
      suggestions: m.suggestions ? JSON.parse(m.suggestions) : null,
      attachments: m.attachments ? JSON.parse(m.attachments) : null,
    })),
  })
})

// List skills
adminRoute.get('/skills', (c) => {
  return c.json({ skills: skillRegistry.getAll() })
})

// Upload skill from zip
adminRoute.post('/skills/upload', async (c) => {
  // 时间戳 + 随机后缀：并发上传不会共用同一临时目录
  const tmpDir = path.resolve('skills', `__upload_tmp_${Date.now()}_${randomUUID().slice(0, 8)}`)
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

    // 解压前整包拒绝不安全条目：'..' 穿越、':'（盘符 / NTFS 备用数据流）与控制字符。
    // extractAllTo 会把 `evil.txt:payload` 这类名字直接落盘为隐藏数据流，故必须在写盘前拒绝。
    const unsafeEntry = findUnsafeZipEntry(zip)
    if (unsafeEntry) {
      const error = unsafeEntry.includes('..')
        ? 'Invalid zip: path traversal detected'
        : `Invalid zip: unsafe entry name "${unsafeEntry}"`
      return c.json({ error }, 400)
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

    // Parse frontmatter to get skill name (CRLF tolerant, consistent with the import parser)
    const raw = fs.readFileSync(skillPath, 'utf-8')
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
    if (!match) {
      return c.json({ error: 'Invalid SKILL.md: missing frontmatter' }, 400)
    }

    const yamlStr = match[1]
    let skillName = ''
    for (const line of yamlStr.split(/\r?\n/)) {
      const m = line.match(/^name:\s*(.+)$/)
      if (m) {
        skillName = m[1].trim().replace(/^['"]|['"]$/g, '')
        break
      }
    }

    if (!skillName) {
      return c.json({ error: 'Invalid SKILL.md: name is required in frontmatter' }, 400)
    }

    const sanitized = sanitizeSkillName(skillName)
    if (!sanitized.ok) {
      return c.json({ error: `Invalid SKILL.md: ${sanitized.error}` }, 400)
    }

    // Move to final destination
    const destDir = path.resolve('skills', sanitized.name)
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true })
    }
    fs.renameSync(actualDir, destDir)

    skillRegistry.refresh()
    return c.json({ success: true, skills: skillRegistry.getAll() })
  } catch (err: any) {
    console.error('Skill upload failed:', err)
    return c.json({ error: err.message || 'Upload failed' }, 500)
  } finally {
    // 成功/失败（含缺 SKILL.md、缺 frontmatter、缺 name 等早退分支）统一清理临时目录，
    // 不把 skills/__upload_tmp_* 留给 skillRegistry.refresh() 注册
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

// Install skill
adminRoute.post('/skills/install', async (c) => {
  const body = await c.req.json<{ name: string }>()
  const skillDir = path.resolve('skills', body.name)

  if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) {
    return c.json({ error: `Skill "${body.name}" not found or missing SKILL.md` }, 404)
  }

  skillRegistry.refresh()
  return c.json({ success: true, skills: skillRegistry.getAll() })
})

// Uninstall skill
adminRoute.delete('/skills/:name', (c) => {
  const name = c.req.param('name')
  // 路径参数同样必须净化：未净化时 URL 编码的 ../ 可穿越删除 skills/ 之外的目录
  const sanitized = sanitizeSkillName(name)
  if (!sanitized.ok) {
    return c.json({ error: `Invalid skill name: ${sanitized.error}` }, 400)
  }
  const skillDir = path.resolve('skills', sanitized.name)

  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true })
  }

  skillRegistry.refresh()
  return c.json({ success: true, skills: skillRegistry.getAll() })
})
