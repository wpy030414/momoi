/**
 * 配置导入导出（Config transfer）
 *
 * 导出：从 DB 收集「体验 + 智能体（除声线）+ 用户注册设置」为 version 1 的
 * YAML 包（config-output-${Date.now()}.yml）。绝不包含网关密钥与 voice 字段。
 *
 * 导入：YAML 解析（maxAliasCount/merge 防护）→ 白名单严格校验（错误结构化为
 * {path, message}，message 为可被前端 st() 反向翻译的英文句）→ dry-run 摘要 /
 * 正式应用。合并语义：省略 = 不更新（绝非置空）；Agent 按 id upsert；本地
 * 多余 Agent 与 OAuth 供应商一律保留（保护会话/绑定外键）。
 *
 * 依赖注入：编排函数（build/summarize/apply）的 deps 可注入以便单测——
 * 默认实现走动态 import，避免本模块顶层引入 db/index.js（顶层 await 建库），
 * 纯函数（parse/validate/stringify）完全不触 DB，测试零 fixture。
 */

import { randomUUID } from 'crypto'
import YAML from 'yaml'
import { NEUTRAL_AGENT_ID, NEUTRAL_AGENT_NAME } from '@momoi/shared/constants'
import type { Agent, AppConfig, ConfigExportBundle, ImportIssue, ImportSummary, OAuth2Provider } from '@momoi/shared/types'

export const BUNDLE_VERSION = 1
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024

const EXPERIENCE_KEYS = ['app_name', 'app_favicon', 'app_background', 'show_github', 'recommended_questions', 'followup_questions'] as const
const AGENT_KEYS = ['id', 'role', 'name', 'model', 'system_prompt', 'avatar'] as const
const PROVIDER_KEYS = ['id', 'name', 'client_id', 'client_secret', 'authorize_url', 'token_url', 'userinfo_url', 'scopes'] as const

// ---- 错误消息（英文整句；en.json 的 serverSide.admin.configImport.* 需逐字符一致，
// ---- {{param}} 占位符由 st() 的 pattern 匹配还原） ----

const MSG = {
  notMapping: 'Import file must be a YAML mapping',
  tooLarge: 'Import file is too large (max 10MB)',
  invalidYaml: 'Invalid YAML file',
  unknownTopKey: 'Unknown top-level key: {{key}}',
  badVersion: 'Unsupported config format version {{version}}, expected 1',
  badExportedAt: 'exported_at must be a short string or number',
  empty: 'Nothing to import: no settings sections found',
  badSection: '{{section}} must be a mapping',
  badAgentsType: 'agents must be an array',
  unknownExperienceKey: 'Unknown key in experience: {{key}}',
  badAppName: 'app_name must be 1-50 characters',
  badImageUrl: '{{field}} must be empty, a data:image URL, or an http(s) URL',
  badBoolean: '{{field}} must be a boolean',
  notArray: '{{field}} must be an array',
  tooManyQuestions: 'recommended_questions allows at most 3 items',
  tooManyFollowups: 'followup_questions allows at most 5 items',
  badQuestion: '{{field}} items must be 1-20 characters',
  unknownAgentKey: 'Unknown key in agents item: {{key}}',
  badRole: 'Agent role must be "default" or "neutral"',
  badAgentId: 'Agent id must be a valid UUID',
  neutralNameImmutable: 'The neutral agent name cannot be changed by import',
  neutralAvatarIgnored: 'Neutral agent avatar is ignored',
  agentNameRequired: 'Agent name is required when creating a new agent',
  badAgentName: 'Agent name must be 1-30 characters',
  badModel: 'Agent model must be at most 200 characters',
  badSystemPrompt: 'Agent system_prompt is too long (max 100000 characters)',
  duplicateAgentId: 'Duplicate agent id in import file: {{id}}',
  tooManyAgents: 'Too many agents in import file (max 50)',
  unknownUsersKey: 'Unknown key in users: {{key}}',
  tooManyProviders: 'Too many OAuth providers (max 10)',
  badProviderEntry: 'oauth_providers items must be mappings',
  unknownProviderKey: 'Unknown key in oauth_providers item: {{key}}',
  badProviderField: 'OAuth provider {{field}} must be a string',
  badProviderId: 'Invalid OAuth provider id, use 1-64 letters, digits, - or _',
  badProviderName: 'OAuth provider name must be 1-64 characters',
  badProviderUrl: 'OAuth provider {{field}} must be an http(s) URL',
  providerTooLong: 'OAuth provider {{field}} must be at most 500 characters',
  duplicateProviderId: 'Duplicate OAuth provider id: {{id}}',
} as const

function interpolate(tpl: string, params: Record<string, string | number>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(params[k] ?? `{{${k}}}`))
}

// ---- 可注入依赖 ----

export interface TransferDeps {
  getConfig(): Promise<AppConfig>
  updateConfig(partial: Partial<AppConfig>): Promise<AppConfig>
  listAgents(): Promise<Agent[]>
  updateAgent(id: string, partial: Partial<Pick<Agent, 'name' | 'model' | 'system_prompt' | 'avatar'>>): Promise<Agent | null>
  createAgent(name: string, model: string, systemPrompt: string, avatar: string, role: Agent['role'], voiceEnabled: boolean, voiceSampleUrl: string, voiceSettings: string, idOverride?: string): Promise<Agent>
  isDirectRegistrationOpen(): Promise<boolean>
  setDirectRegistrationOpen(open: boolean): Promise<void>
  isOauthRegistrationOpen(): Promise<boolean>
  setOauthRegistrationOpen(open: boolean): Promise<void>
  isExternalImageHostingEnabled(): Promise<boolean>
  uploadToCdn(buffer: Buffer, filename: string, mimeType: string): Promise<string>
}

/** 动态加载真实实现——顶层 import 会连带 db/index.js 的建库副作用，测试注入 fake 时不触达 */
async function loadDefaultDeps(): Promise<TransferDeps> {
  const [config, cdn] = await Promise.all([import('./config.js'), import('./cdn.js')])
  return {
    getConfig: config.getConfig,
    updateConfig: config.updateConfig,
    listAgents: config.listAgents,
    updateAgent: config.updateAgent,
    createAgent: config.createAgent as TransferDeps['createAgent'],
    isDirectRegistrationOpen: config.isDirectRegistrationOpen,
    setDirectRegistrationOpen: config.setDirectRegistrationOpen,
    isOauthRegistrationOpen: config.isOauthRegistrationOpen,
    setOauthRegistrationOpen: config.setOauthRegistrationOpen,
    isExternalImageHostingEnabled: config.isExternalImageHostingEnabled,
    uploadToCdn: cdn.uploadToCdn,
  }
}

// ---- 导出 ----

export async function buildExportBundle(deps?: TransferDeps): Promise<ConfigExportBundle> {
  const d = deps ?? await loadDefaultDeps()
  const config = await d.getConfig()
  const agents = await d.listAgents()
  return {
    version: BUNDLE_VERSION,
    exported_at: new Date().toISOString(),
    // 手工挑白名单字段——绝不整体序列化 AppConfig（含 api_endpoint/api_key）
    experience: {
      app_name: config.app_name,
      app_favicon: config.app_favicon,
      app_background: config.app_background,
      show_github: config.show_github,
      recommended_questions: config.recommended_questions,
      followup_questions: config.followup_questions,
    },
    // 剔除 voice 三字段与 created_at
    agents: agents.map((a) => ({ id: a.id, role: a.role, name: a.name, model: a.model, system_prompt: a.system_prompt, avatar: a.avatar })),
    users: {
      direct_registration_open: await d.isDirectRegistrationOpen(),
      oauth_registration_open: await d.isOauthRegistrationOpen(),
      oauth_providers: config.oauth_providers,
    },
  }
}

/** lineWidth: 0 阻止超长 base64 行被折叠；多行 system_prompt 自动走块标量 */
export function stringifyExportYAML(bundle: ConfigExportBundle): string {
  return YAML.stringify(bundle, { lineWidth: 0 })
}

// ---- 导入：解析 ----

export function parseImportYAML(text: string): { ok: true; data: unknown } | { ok: false; error: ImportIssue } {
  if (Buffer.byteLength(text, 'utf8') > MAX_IMPORT_BYTES) {
    return { ok: false, error: { path: '', message: MSG.tooLarge } }
  }
  try {
    // maxAliasCount 防 YAML 锚点引用爆炸（billion laughs）；merge:false 禁
    // merge key（<<）绕过白名单构造对象；prettyErrors 使异常带定位信息。
    const data = YAML.parse(text, { maxAliasCount: 100, merge: false, prettyErrors: true })
    return { ok: true, data }
  } catch (err) {
    return { ok: false, error: { path: (err as Error).message.split('\n')[0].slice(0, 200), message: MSG.invalidYaml } }
  }
}

// ---- 导入：校验（纯函数） ----

export interface ValidateContext {
  /** 库中中立 Agent 当前名（name 改名检测的唯一 DB 依赖） */
  currentNeutralAgentName: string
  /** 库中全部 agent id（区分新建/更新——新建必须提供 name） */
  existingAgentIds: Set<string>
}

export interface ValidationResult {
  ok: boolean
  bundle?: ConfigExportBundle
  errors: ImportIssue[]
  warnings: ImportIssue[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PROVIDER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 图片字段：空串 | data:image/* | http(s) URL（拒 javascript: 等注入） */
function isValidImageValue(v: string): boolean {
  if (v === '') return true
  if (v.startsWith('data:image/')) return true
  return isHttpUrl(v)
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function validateImportBundle(raw: unknown, ctx: ValidateContext): ValidationResult {
  const errors: ImportIssue[] = []
  const warnings: ImportIssue[] = []

  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ path: '', message: MSG.notMapping }], warnings }
  }

  // --- 顶层白名单 ---
  for (const key of Object.keys(raw)) {
    if (!['version', 'exported_at', 'experience', 'agents', 'users'].includes(key)) {
      errors.push({ path: key, message: interpolate(MSG.unknownTopKey, { key }) })
    }
  }
  // version：缺省视为当前版本（手写最小文件可不写）；出现则必须 === 1
  if (raw.version !== undefined && raw.version !== BUNDLE_VERSION) {
    errors.push({ path: 'version', message: interpolate(MSG.badVersion, { version: String(raw.version) }) })
  }
  if (raw.exported_at !== undefined) {
    const v = raw.exported_at
    const ok = (typeof v === 'string' && v.length <= 40) || typeof v === 'number'
    if (!ok) errors.push({ path: 'exported_at', message: MSG.badExportedAt })
  }

  const experience = raw.experience !== undefined ? validateExperience(raw.experience, errors) : undefined
  const agents = raw.agents !== undefined ? validateAgents(raw.agents, ctx, errors, warnings) : undefined
  const users = raw.users !== undefined ? validateUsers(raw.users, errors) : undefined

  // 段的存在性以原始键为准（而非归一化结果）：段内所有条目/字段均无实际
  // 变更（如中立条目只带 avatar）时归一化产物为空，但该段依然是"有效导入"
  // ——只产生 warning，不构成 empty。
  if (raw.experience === undefined && raw.agents === undefined && raw.users === undefined) {
    errors.push({ path: '', message: MSG.empty })
  }

  if (errors.length > 0) return { ok: false, errors, warnings }

  const bundle: ConfigExportBundle = { version: BUNDLE_VERSION }
  if (raw.exported_at !== undefined) bundle.exported_at = String(raw.exported_at)
  if (experience) bundle.experience = experience
  if (agents) bundle.agents = agents
  if (users) bundle.users = users
  return { ok: true, bundle, errors, warnings }
}

function validateExperience(v: unknown, errors: ImportIssue[]): ConfigExportBundle['experience'] | undefined {
  if (!isPlainObject(v)) {
    errors.push({ path: 'experience', message: interpolate(MSG.badSection, { section: 'experience' }) })
    return undefined
  }
  const out: NonNullable<ConfigExportBundle['experience']> = {}
  for (const key of Object.keys(v)) {
    if (!(EXPERIENCE_KEYS as readonly string[]).includes(key)) {
      errors.push({ path: `experience.${key}`, message: interpolate(MSG.unknownExperienceKey, { key }) })
      continue
    }
    const val = v[key]
    switch (key) {
      case 'app_name': {
        if (typeof val !== 'string' || val.trim().length < 1 || val.trim().length > 50) {
          errors.push({ path: 'experience.app_name', message: MSG.badAppName })
        } else {
          out.app_name = val.trim()
        }
        break
      }
      case 'app_favicon':
      case 'app_background': {
        if (typeof val !== 'string' || !isValidImageValue(val)) {
          errors.push({ path: `experience.${key}`, message: interpolate(MSG.badImageUrl, { field: key }) })
        } else {
          out[key] = val
        }
        break
      }
      case 'show_github': {
        if (typeof val !== 'boolean') {
          errors.push({ path: 'experience.show_github', message: interpolate(MSG.badBoolean, { field: 'show_github' }) })
        } else {
          out.show_github = val
        }
        break
      }
      case 'recommended_questions':
      case 'followup_questions': {
        const max = key === 'recommended_questions' ? 3 : 5
        const maxMsg = key === 'recommended_questions' ? MSG.tooManyQuestions : MSG.tooManyFollowups
        if (!Array.isArray(val)) {
          errors.push({ path: `experience.${key}`, message: interpolate(MSG.notArray, { field: key }) })
        } else if (val.length > max) {
          errors.push({ path: `experience.${key}`, message: maxMsg })
        } else {
          const items: string[] = []
          let valid = true
          for (const q of val) {
            if (typeof q !== 'string' || q.trim().length < 1 || q.trim().length > 20) {
              valid = false
              break
            }
            items.push(q.trim())
          }
          if (!valid) {
            errors.push({ path: `experience.${key}`, message: interpolate(MSG.badQuestion, { field: key }) })
          } else {
            out[key] = items
          }
        }
        break
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function validateAgents(v: unknown, ctx: ValidateContext, errors: ImportIssue[], warnings: ImportIssue[]): ConfigTransferAgentOut[] | undefined {
  if (!Array.isArray(v)) {
    errors.push({ path: 'agents', message: MSG.badAgentsType })
    return undefined
  }
  if (v.length > 50) {
    errors.push({ path: 'agents', message: MSG.tooManyAgents })
    return undefined
  }
  const out: ConfigTransferAgentOut[] = []
  const seenIds = new Set<string>()
  for (let i = 0; i < v.length; i++) {
    const entry = v[i]
    if (!isPlainObject(entry)) {
      errors.push({ path: `agents[${i}]`, message: interpolate(MSG.badSection, { section: `agents[${i}]` }) })
      continue
    }
    for (const key of Object.keys(entry)) {
      if (!(AGENT_KEYS as readonly string[]).includes(key)) {
        errors.push({ path: `agents[${i}].${key}`, message: interpolate(MSG.unknownAgentKey, { key }) })
      }
    }

    const role = entry.role
    if (role !== undefined && role !== 'default' && role !== 'neutral') {
      errors.push({ path: `agents[${i}].role`, message: MSG.badRole })
      continue
    }

    // 中立识别：role 显式声明，或 id 即固定中立 ID（role 优先；其 id 被归一化）
    if (role === 'neutral' || entry.id === NEUTRAL_AGENT_ID) {
      const neutral: ConfigTransferAgentOut = { id: NEUTRAL_AGENT_ID, role: 'neutral' }
      if (entry.name !== undefined) {
        if (typeof entry.name !== 'string' || entry.name.trim() !== ctx.currentNeutralAgentName.trim()) {
          errors.push({ path: `agents[${i}].name`, message: MSG.neutralNameImmutable })
        }
        // 与现值一致 → 不进 bundle（name 永不通过导入修改）
      }
      // 非空 avatar 才提示忽略；空串（导出文件自带）静默跳过，避免噪音
      if (entry.avatar !== undefined && entry.avatar !== '') {
        warnings.push({ path: `agents[${i}].avatar`, message: MSG.neutralAvatarIgnored })
      }
      if (entry.model !== undefined) {
        if (typeof entry.model !== 'string' || entry.model.length > 200) {
          errors.push({ path: `agents[${i}].model`, message: MSG.badModel })
        } else {
          neutral.model = entry.model
        }
      }
      if (entry.system_prompt !== undefined) {
        if (typeof entry.system_prompt !== 'string' || entry.system_prompt.length > 100000) {
          errors.push({ path: `agents[${i}].system_prompt`, message: MSG.badSystemPrompt })
        } else {
          neutral.system_prompt = entry.system_prompt
        }
      }
      if (seenIds.has(NEUTRAL_AGENT_ID)) {
        errors.push({ path: `agents[${i}]`, message: interpolate(MSG.duplicateAgentId, { id: NEUTRAL_AGENT_ID }) })
      }
      seenIds.add(NEUTRAL_AGENT_ID)
      // 无变更字段（name 同名不进、avatar 被忽略、model/system_prompt 缺省）也保留
      // 条目——归一化产物忠实反映文件内容，skip 判断留给 computePlan。
      out.push(neutral)
      continue
    }

    // 普通 Agent
    const agent: ConfigTransferAgentOut = { role: 'default' }
    if (entry.id !== undefined) {
      if (typeof entry.id !== 'string' || !UUID_RE.test(entry.id)) {
        errors.push({ path: `agents[${i}].id`, message: MSG.badAgentId })
        continue
      }
      agent.id = entry.id
    }
    if (entry.name !== undefined) {
      if (typeof entry.name !== 'string' || entry.name.trim().length < 1 || entry.name.trim().length > 30) {
        errors.push({ path: `agents[${i}].name`, message: MSG.badAgentName })
      } else {
        agent.name = entry.name.trim()
      }
    }
    if (entry.model !== undefined) {
      if (typeof entry.model !== 'string' || entry.model.length > 200) {
        errors.push({ path: `agents[${i}].model`, message: MSG.badModel })
      } else {
        agent.model = entry.model
      }
    }
    if (entry.system_prompt !== undefined) {
      if (typeof entry.system_prompt !== 'string' || entry.system_prompt.length > 100000) {
        errors.push({ path: `agents[${i}].system_prompt`, message: MSG.badSystemPrompt })
      } else {
        agent.system_prompt = entry.system_prompt
      }
    }
    if (entry.avatar !== undefined) {
      if (typeof entry.avatar !== 'string' || !isValidImageValue(entry.avatar)) {
        errors.push({ path: `agents[${i}].avatar`, message: interpolate(MSG.badImageUrl, { field: 'avatar' }) })
      } else {
        agent.avatar = entry.avatar
      }
    }
    // 新建（id 缺省或库中不存在）必须提供 name；更新可省略任意字段
    const isNew = agent.id === undefined || !ctx.existingAgentIds.has(agent.id)
    if (isNew && agent.name === undefined) {
      errors.push({ path: `agents[${i}].name`, message: MSG.agentNameRequired })
    }
    if (agent.id !== undefined) {
      if (seenIds.has(agent.id)) {
        errors.push({ path: `agents[${i}]`, message: interpolate(MSG.duplicateAgentId, { id: agent.id }) })
      }
      seenIds.add(agent.id)
    }
    out.push(agent)
  }
  return out.length > 0 ? out : undefined
}

function validateUsers(v: unknown, errors: ImportIssue[]): NonNullable<ConfigExportBundle['users']> | undefined {
  if (!isPlainObject(v)) {
    errors.push({ path: 'users', message: interpolate(MSG.badSection, { section: 'users' }) })
    return undefined
  }
  const out: NonNullable<ConfigExportBundle['users']> = {}
  for (const key of Object.keys(v)) {
    if (!['direct_registration_open', 'oauth_registration_open', 'oauth_providers'].includes(key)) {
      errors.push({ path: `users.${key}`, message: interpolate(MSG.unknownUsersKey, { key }) })
    }
  }
  if (v.direct_registration_open !== undefined) {
    if (typeof v.direct_registration_open !== 'boolean') {
      errors.push({ path: 'users.direct_registration_open', message: interpolate(MSG.badBoolean, { field: 'direct_registration_open' }) })
    } else {
      out.direct_registration_open = v.direct_registration_open
    }
  }
  if (v.oauth_registration_open !== undefined) {
    if (typeof v.oauth_registration_open !== 'boolean') {
      errors.push({ path: 'users.oauth_registration_open', message: interpolate(MSG.badBoolean, { field: 'oauth_registration_open' }) })
    } else {
      out.oauth_registration_open = v.oauth_registration_open
    }
  }
  if (v.oauth_providers !== undefined) {
    const arr = v.oauth_providers
    if (!Array.isArray(arr)) {
      errors.push({ path: 'users.oauth_providers', message: interpolate(MSG.notArray, { field: 'oauth_providers' }) })
    } else if (arr.length > 10) {
      errors.push({ path: 'users.oauth_providers', message: MSG.tooManyProviders })
    } else {
      const providers: Partial<OAuth2Provider>[] = []
      const seen = new Set<string>()
      let valid = true
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i]
        if (!isPlainObject(p)) {
          errors.push({ path: `users.oauth_providers[${i}]`, message: MSG.badProviderEntry })
          valid = false
          continue
        }
        for (const key of Object.keys(p)) {
          if (!(PROVIDER_KEYS as readonly string[]).includes(key)) {
            errors.push({ path: `users.oauth_providers[${i}].${key}`, message: interpolate(MSG.unknownProviderKey, { key }) })
            valid = false
          }
        }
        // id：合并主键，必填
        if (typeof p.id !== 'string' || !PROVIDER_ID_RE.test(p.id)) {
          errors.push({ path: `users.oauth_providers[${i}].id`, message: MSG.badProviderId })
          valid = false
        } else if (seen.has(p.id)) {
          errors.push({ path: `users.oauth_providers[${i}].id`, message: interpolate(MSG.duplicateProviderId, { id: p.id }) })
          valid = false
        } else {
          seen.add(p.id)
        }
        // name：展示名，必填
        if (typeof p.name !== 'string' || p.name.trim().length < 1 || p.name.trim().length > 64) {
          errors.push({ path: `users.oauth_providers[${i}].name`, message: MSG.badProviderName })
          valid = false
        }
        const entry: Partial<OAuth2Provider> = { id: p.id as string, name: (p.name as string).trim() }
        for (const field of ['client_id', 'client_secret', 'scopes'] as const) {
          const val = p[field]
          if (val === undefined) continue
          if (typeof val !== 'string' || val.length > 500) {
            errors.push({ path: `users.oauth_providers[${i}].${field}`, message: interpolate(MSG.providerTooLong, { field }) })
            valid = false
          } else {
            entry[field] = val
          }
        }
        for (const field of ['authorize_url', 'token_url', 'userinfo_url'] as const) {
          const val = p[field]
          if (val === undefined) continue
          if (typeof val !== 'string' || val === '' || !isHttpUrl(val)) {
            errors.push({ path: `users.oauth_providers[${i}].${field}`, message: interpolate(MSG.badProviderUrl, { field }) })
            valid = false
          } else {
            entry[field] = val
          }
        }
        providers.push(entry)
      }
      if (valid) out.oauth_providers = providers
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 校验后的 Agent 条目（普通项字段可缺省，缺省 = 不更新） */
interface ConfigTransferAgentOut {
  id?: string
  role: 'default' | 'neutral'
  name?: string
  model?: string
  system_prompt?: string
  avatar?: string
}

// ---- 导入：摘要 / 应用 ----

/** 外部图床开启时 base64 → CDN；失败保留原值（与 PUT /config 行为一致，不阻塞导入） */
async function maybeUploadDataUrl(value: string, filename: string, deps: TransferDeps): Promise<string> {
  if (!value.startsWith('data:')) return value
  if (!(await deps.isExternalImageHostingEnabled())) return value
  try {
    const { base64ToBuffer } = await import('./cdn.js')
    const { buffer, mimeType } = base64ToBuffer(value)
    return await deps.uploadToCdn(buffer, filename, mimeType)
  } catch (err) {
    console.warn(`Failed to upload ${filename} to CDN during config import, keeping base64:`, (err as Error).message)
    return value
  }
}

interface ImportPlan {
  experience: { changed: string[]; unchanged: string[] } | null
  experienceUpdate: Partial<AppConfig>
  agents: ImportSummary['agents']
  agentOps: Array<{ op: 'update'; id: string; partial: Partial<Pick<Agent, 'name' | 'model' | 'system_prompt' | 'avatar'>> } | { op: 'create'; name: string; model: string; systemPrompt: string; avatar: string; id?: string }>
  users: ImportSummary['users']
  directOpen?: boolean
  oauthOpen?: boolean
  mergedProviders?: Partial<OAuth2Provider>[]
}

/** 计算「将做什么」的完整计划——summarize（dry-run）与 apply 共用，保证两者一致 */
async function computePlan(bundle: ConfigExportBundle, deps: TransferDeps): Promise<ImportPlan> {
  const [config, existingAgents] = await Promise.all([deps.getConfig(), deps.listAgents()])
  const existingById = new Map(existingAgents.map((a) => [a.id, a]))

  // --- experience ---
  let experience: ImportPlan['experience'] = null
  const experienceUpdate: Partial<AppConfig> = {}
  if (bundle.experience) {
    const changed: string[] = []
    const unchanged: string[] = []
    for (const key of EXPERIENCE_KEYS) {
      const incoming = (bundle.experience as Record<string, unknown>)[key]
      if (incoming === undefined) continue
      const current = (config as unknown as Record<string, unknown>)[key]
      if (JSON.stringify(incoming) === JSON.stringify(current)) {
        unchanged.push(key)
      } else {
        changed.push(key)
        ;(experienceUpdate as Record<string, unknown>)[key] = incoming
      }
    }
    experience = { changed, unchanged }
  }

  // --- agents ---
  // 段缺省时摘要为 null（前端据此隐藏整组）；循环始终写非空局部对象
  const agentsOut: NonNullable<ImportSummary['agents']> = { update: [], create: [], skip: [] }
  const agentOps: ImportPlan['agentOps'] = []
  for (const entry of bundle.agents ?? []) {
    if (entry.role === 'neutral') {
      const existing = existingById.get(NEUTRAL_AGENT_ID)
      const partial: Partial<Pick<Agent, 'model' | 'system_prompt'>> = {}
      if (entry.model !== undefined && entry.model !== existing?.model) partial.model = entry.model
      if (entry.system_prompt !== undefined && entry.system_prompt !== existing?.system_prompt) partial.system_prompt = entry.system_prompt
      if (Object.keys(partial).length === 0 || !existing) {
        agentsOut.skip.push({ id: NEUTRAL_AGENT_ID, name: existing?.name ?? NEUTRAL_AGENT_NAME, reason: 'no changes' })
      } else {
        agentsOut.update.push({ id: NEUTRAL_AGENT_ID, name: existing.name, neutral: true })
        agentOps.push({ op: 'update', id: NEUTRAL_AGENT_ID, partial })
      }
      continue
    }
    const existing = entry.id !== undefined ? existingById.get(entry.id) : undefined
    if (existing) {
      const partial: Partial<Pick<Agent, 'name' | 'model' | 'system_prompt' | 'avatar'>> = {}
      if (entry.name !== undefined && entry.name !== existing.name) partial.name = entry.name
      if (entry.model !== undefined && entry.model !== existing.model) partial.model = entry.model
      if (entry.system_prompt !== undefined && entry.system_prompt !== existing.system_prompt) partial.system_prompt = entry.system_prompt
      if (entry.avatar !== undefined && entry.avatar !== existing.avatar) partial.avatar = entry.avatar
      if (Object.keys(partial).length === 0) {
        agentsOut.skip.push({ id: existing.id, name: existing.name, reason: 'no changes' })
      } else {
        agentsOut.update.push({ id: existing.id, name: existing.name, neutral: false })
        agentOps.push({ op: 'update', id: existing.id, partial })
      }
    } else {
      // 新建（id 缺省 → 生成新 UUID；id 存在但库中无 → 按原 id 重建保持跨实例引用）
      agentsOut.create.push({ id: entry.id ?? null, name: entry.name! })
      agentOps.push({ op: 'create', name: entry.name!, model: entry.model ?? '', systemPrompt: entry.system_prompt ?? '', avatar: entry.avatar ?? '', id: entry.id })
    }
  }
  const agents: ImportSummary['agents'] = bundle.agents === undefined ? null : agentsOut

  // --- users ---
  const usersOut: NonNullable<ImportSummary['users']> = {
    direct_registration_open: null,
    oauth_registration_open: null,
    providers_update: 0,
    providers_create: 0,
    providers_skip: 0,
  }
  let directOpen: boolean | undefined
  let oauthOpen: boolean | undefined
  if (bundle.users) {
    if (bundle.users.direct_registration_open !== undefined) {
      const from = await deps.isDirectRegistrationOpen()
      directOpen = bundle.users.direct_registration_open
      if (from !== directOpen) usersOut.direct_registration_open = { from, to: directOpen }
    }
    if (bundle.users.oauth_registration_open !== undefined) {
      const from = await deps.isOauthRegistrationOpen()
      oauthOpen = bundle.users.oauth_registration_open
      if (from !== oauthOpen) usersOut.oauth_registration_open = { from, to: oauthOpen }
    }
  }

  let mergedProviders: Partial<OAuth2Provider>[] | undefined
  if (bundle.users?.oauth_providers !== undefined) {
    const incoming = bundle.users.oauth_providers
    const existingProviders = config.oauth_providers
    const byId = new Map(incoming.map((p) => [p.id as string, p]))
    mergedProviders = existingProviders.map((p) => {
      const inc = byId.get(p.id)
      if (!inc) {
        usersOut.providers_skip++
        return p as Partial<OAuth2Provider>
      }
      usersOut.providers_update++
      // 字段级合并：省略字段保留原值（总原则：省略 = 不更新）
      return { ...p, ...inc } as Partial<OAuth2Provider>
    })
    const existingIds = new Set(existingProviders.map((p) => p.id))
    for (const p of incoming) {
      if (!existingIds.has(p.id as string)) {
        usersOut.providers_create++
        // 新建：缺省字段补空串
        mergedProviders.push({ client_id: '', client_secret: '', authorize_url: '', token_url: '', userinfo_url: '', scopes: '', ...p })
      }
    }
  }
  // 段缺省时摘要为 null（与 agents 同语义）
  const users: ImportSummary['users'] = bundle.users === undefined ? null : usersOut

  return { experience, experienceUpdate, agents, agentOps, users, directOpen, oauthOpen, mergedProviders }
}

function planToSummary(plan: ImportPlan): ImportSummary {
  return {
    experience: plan.experience,
    agents: plan.agents,
    users: plan.users,
  }
}

/** dry-run：只计算将发生的变更，不落库 */
export async function summarizeImport(bundle: ConfigExportBundle, deps?: TransferDeps): Promise<ImportSummary> {
  const d = deps ?? await loadDefaultDeps()
  return planToSummary(await computePlan(bundle, d))
}

/** 正式导入：experience → users → agents 顺序应用（无事务，fail-fast） */
export async function applyImportBundle(bundle: ConfigExportBundle, deps?: TransferDeps): Promise<ImportSummary> {
  const d = deps ?? await loadDefaultDeps()
  const plan = await computePlan(bundle, d)

  // experience：图片字段过外部图床转换后写入
  if (plan.experienceUpdate.app_favicon !== undefined) {
    plan.experienceUpdate.app_favicon = await maybeUploadDataUrl(plan.experienceUpdate.app_favicon, 'favicon.png', d)
  }
  if (plan.experienceUpdate.app_background !== undefined) {
    plan.experienceUpdate.app_background = await maybeUploadDataUrl(plan.experienceUpdate.app_background, 'background.png', d)
  }
  if (Object.keys(plan.experienceUpdate).length > 0) {
    await d.updateConfig(plan.experienceUpdate)
  }

  // users：注册开关 + OAuth 供应商（合并后整表写回，updateConfig 自动失效配置缓存）
  if (plan.directOpen !== undefined) await d.setDirectRegistrationOpen(plan.directOpen)
  if (plan.oauthOpen !== undefined) await d.setOauthRegistrationOpen(plan.oauthOpen)
  if (plan.mergedProviders !== undefined) {
    await d.updateConfig({ oauth_providers: plan.mergedProviders as OAuth2Provider[] })
  }

  // agents：upsert（只传文件中出现的字段；avatar 过图床转换）
  for (const op of plan.agentOps) {
    if (op.op === 'update') {
      if (op.partial.avatar !== undefined) {
        op.partial.avatar = await maybeUploadDataUrl(op.partial.avatar, 'avatar.png', d)
      }
      await d.updateAgent(op.id, op.partial)
    } else {
      const avatar = await maybeUploadDataUrl(op.avatar, 'avatar.png', d)
      await d.createAgent(op.name, op.model, op.systemPrompt, avatar, 'default', false, '', '{}', op.id)
    }
  }

  return planToSummary(plan)
}
