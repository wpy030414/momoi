// ============================================================
// config-transfer 单元测试 —— 配置导入导出
// ============================================================
//
// 校验契约（严格白名单 + 报错拒绝）：
//   · 字段级可选：任何段/键可省略，省略 = 不更新（绝非置空）
//   · 中立 Agent：name 与库中现值不同 → 拒绝；avatar → warning 忽略
//   · 推荐/追问问题：≤3 / ≤5 条，每条 trim 后 1-20 字符
//   · 普通 Agent：id 可省略（视为新建，须提供 name），提供则须 UUID
//   · 合并语义：Agent/OAuth 供应商按 id upsert，本地多余一律保留
//
// 全部通过 fake deps 注入，不触发 db/index.js 的建库副作用。

import { describe, it, expect } from 'vitest'
import { ErrCode } from '@momoi/shared/errors'
import {
  stringifyExportYAML,
  parseImportYAML,
  validateImportBundle,
  buildExportBundle,
  summarizeImport,
  applyImportBundle,
  MAX_IMPORT_BYTES,
  type TransferDeps,
  type ValidateContext,
} from '../src/lib/config-transfer.js'
import type { Agent, AppConfig, ConfigExportBundle, OAuth2Provider, ImportIssue } from '@momoi/shared/types'
import { NEUTRAL_AGENT_ID, NEUTRAL_AGENT_NAME } from '@momoi/shared/constants'

// ---- 测试脚手架 ----

const UUID_A = '3f2c1b8e-9a7d-4c1e-8f2a-1b2c3d4e5f60'
const UUID_B = '8e1a2b3c-4d5e-6f70-8a9b-0c1d2e3f4a5b'

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    app_name: 'Momoi',
    app_favicon: '',
    app_background: '',
    api_endpoint: 'https://api.openai.com/v1',
    api_key: 'sk-secret',
    support_attachments: true,
    support_infinite_mode: true,
    allow_im_conversations: true,
    show_github: true,
    use_external_image_hosting: false,
    recommended_questions: ['你好'],
    followup_questions: [],
    oauth_providers: [],
    ...overrides,
  }
}

function makeAgent(partial: Partial<Agent> & { id: string }): Agent {
  return {
    name: 'Agent',
    model: 'gpt-4o',
    system_prompt: '',
    avatar: '',
    role: 'default',
    created_at: 0,
    voice_enabled: false,
    voice_sample_url: '',
    voice_settings: '{}',
    ...partial,
  }
}

function defaultAgents(): Agent[] {
  return [
    makeAgent({ id: NEUTRAL_AGENT_ID, role: 'neutral', name: NEUTRAL_AGENT_NAME, model: 'gpt-4o', system_prompt: 'neutral prompt' }),
    makeAgent({ id: UUID_A, name: 'Momoi', model: 'gpt-4o', system_prompt: 'hello\nworld' }),
  ]
}

/** fake 工厂的可注入初始状态（__ 前缀）与可覆盖的个别 dep 函数 */
interface Overrides {
  __config?: AppConfig
  __agents?: Agent[]
  __directOpen?: boolean
  __oauthOpen?: boolean
  __externalHosting?: boolean
  __cdnShouldFail?: boolean
}

function makeDeps(overrides: Overrides = {}): Fixture {
  let config = overrides.__config ?? makeConfig()
  let agents = overrides.__agents ?? defaultAgents()
  let directOpen = overrides.__directOpen ?? true
  let oauthOpen = overrides.__oauthOpen ?? true
  let externalHosting = overrides.__externalHosting ?? false
  let cdnShouldFail = overrides.__cdnShouldFail ?? false

  const calls = {
    updateConfig: [] as Array<Partial<AppConfig>>,
    updateAgent: [] as Array<[string, Record<string, unknown>]>,
    createAgent: [] as Array<{ name: string; idOverride?: string }>,
    setDirectRegistrationOpen: [] as boolean[],
    setOauthRegistrationOpen: [] as boolean[],
    cdnUploads: [] as string[],
  }

  const deps: TransferDeps = {
    getConfig: async () => config,
    updateConfig: async (partial) => {
      calls.updateConfig.push(partial)
      config = { ...config, ...partial }
      return config
    },
    listAgents: async () => agents,
    updateAgent: async (id, partial) => {
      calls.updateAgent.push([id, { ...partial }])
      const a = agents.find((x) => x.id === id)
      if (!a) return null
      Object.assign(a, partial)
      return a
    },
    createAgent: async (name, model, systemPrompt, avatar, role, _ve, _vsu, _vs, idOverride) => {
      calls.createAgent.push({ name, idOverride })
      const agent = makeAgent({ id: idOverride || `gen-${calls.createAgent.length}`, name, model, system_prompt: systemPrompt, avatar, role })
      agents.push(agent)
      return agent
    },
    isDirectRegistrationOpen: async () => directOpen,
    setDirectRegistrationOpen: async (open) => { calls.setDirectRegistrationOpen.push(open); directOpen = open },
    isOauthRegistrationOpen: async () => oauthOpen,
    setOauthRegistrationOpen: async (open) => { calls.setOauthRegistrationOpen.push(open); oauthOpen = open },
    isExternalImageHostingEnabled: async () => externalHosting,
    uploadToCdn: async (_buffer, filename) => {
      if (cdnShouldFail) throw new Error('CDN down')
      calls.cdnUploads.push(filename)
      return `https://cdn.example/${filename}`
    },
  }

  return {
    deps,
    calls,
    get config() { return config },
    get agents() { return agents },
    get directOpen() { return directOpen },
    get oauthOpen() { return oauthOpen },
  }
}

interface Fixture {
  deps: TransferDeps
  calls: {
    updateConfig: Array<Partial<AppConfig>>
    updateAgent: Array<[string, Record<string, unknown>]>
    createAgent: Array<{ name: string; idOverride?: string }>
    setDirectRegistrationOpen: boolean[]
    setOauthRegistrationOpen: boolean[]
    cdnUploads: string[]
  }
  readonly config: AppConfig
  readonly agents: Agent[]
  readonly directOpen: boolean
  readonly oauthOpen: boolean
}

function makeCtx(existingIds: string[] = [NEUTRAL_AGENT_ID, UUID_A]): ValidateContext {
  return { currentNeutralAgentName: NEUTRAL_AGENT_NAME, existingAgentIds: new Set(existingIds) }
}

/** 走完整导入管线：YAML 文本 → parse → validate，返回校验结果 */
function validateYAML(text: string, ctx = makeCtx()) {
  const parsed = parseImportYAML(text)
  if (!parsed.ok) return { parseFailed: true as const, error: parsed.error }
  return { parseFailed: false as const, ...validateImportBundle(parsed.data, ctx) }
}

function codes(issues: ImportIssue[]): ErrCode[] {
  return issues.map((e) => e.code)
}

// ---- parseImportYAML ----

describe('parseImportYAML', () => {
  it('解析合法 YAML 为对象', () => {
    const r = parseImportYAML('version: 1\nexperience:\n  app_name: Momoi')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data).toMatchObject({ version: 1 })
  })

  it('拒绝超过 10MB 的文本', () => {
    const r = parseImportYAML('x: ' + 'a'.repeat(MAX_IMPORT_BYTES))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe(ErrCode.CONFIG_IMPORT_TOO_LARGE)
  })

  it('拒绝语法错误的 YAML', () => {
    const r = parseImportYAML('a: [unclosed')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe(ErrCode.CONFIG_IMPORT_INVALID_YAML)
      // path 携带解析器报错首行（≤200 字符）供定位
      expect(r.error.path.length).toBeGreaterThan(0)
    }
  })

  it('拒绝锚点引用爆炸（maxAliasCount）', () => {
    // 少量锚点指数展开引用，超过 alias 上限时 yaml 库抛错
    const bomb = ['a0: &a0 [x]']
    for (let i = 1; i < 10; i++) bomb.push(`a${i}: &a${i} [*a${i - 1}, *a${i - 1}, *a${i - 1}, *a${i - 1}]`)
    const r = parseImportYAML(bomb.join('\n'))
    expect(r.ok).toBe(false)
  })

  it('空文件（解析为 null）不在此处崩溃', () => {
    const r = parseImportYAML('')
    expect(r.ok).toBe(true) // null 进入 validate 后被 notMapping 拒绝
  })
})

// ---- validateImportBundle ----

describe('validateImportBundle — 顶层', () => {
  it('拒绝非 mapping（数组/纯文本/null）', () => {
    for (const raw of [['a'], 'hello', null, 42]) {
      const r = validateImportBundle(raw, makeCtx())
      expect(r.ok).toBe(false)
      expect(codes(r.errors)).toContain(ErrCode.CONFIG_IMPORT_NOT_MAPPING)
    }
  })

  it('拒绝未知顶层键', () => {
    const r = validateYAML('version: 1\nmcp_servers: []')
    expect(r.parseFailed).toBe(false)
    if (!r.parseFailed) {
      expect(r.ok).toBe(false)
      expect(r.errors).toContainEqual({
        path: 'mcp_servers',
        code: ErrCode.CONFIG_IMPORT_UNKNOWN_TOP_KEY,
        params: { key: 'mcp_servers' },
      })
    }
  })

  it('拒绝 version 2；缺省 version 视为 1（手写最小文件）', () => {
    expect(validateYAML('version: 2\nexperience: {}').ok ?? false).toBe(false)
    const r = validateYAML('experience:\n  app_name: Momoi')
    expect(r.parseFailed).toBe(false)
    if (!r.parseFailed) expect(r.ok).toBe(true)
  })

  it('三段全缺拒绝', () => {
    const r = validateYAML('version: 1')
    expect(r.parseFailed).toBe(false)
    if (!r.parseFailed) {
      expect(r.ok).toBe(false)
      expect(codes(r.errors)).toContain(ErrCode.CONFIG_IMPORT_EMPTY)
    }
  })
})

describe('validateImportBundle — experience', () => {
  it('拒绝未知键 / 非法 app_name', () => {
    const r = validateYAML('experience:\n  api_key: sk-x\n  app_name: ""')
    expect(r.parseFailed).toBe(false)
    if (!r.parseFailed) {
      expect(r.ok).toBe(false)
      expect(r.errors).toContainEqual({
        path: 'experience.api_key',
        code: ErrCode.CONFIG_IMPORT_UNKNOWN_EXPERIENCE_KEY,
        params: { key: 'api_key' },
      })
      expect(codes(r.errors)).toContain(ErrCode.CONFIG_IMPORT_BAD_APP_NAME)
    }
  })

  it('app_name 51 字符拒绝，50 通过并 trim', () => {
    const bad = validateYAML(`experience:\n  app_name: "${'a'.repeat(51)}"`)
    expect(bad.parseFailed || bad.ok).toBe(false)
    const good = validateYAML(`experience:\n  app_name: " ${'a'.repeat(50)} "`)
    expect(good.parseFailed).toBe(false)
    if (!good.parseFailed) {
      expect(good.ok).toBe(true)
      expect(good.bundle?.experience?.app_name).toBe('a'.repeat(50))
    }
  })

  it('图片字段：javascript: / data:text/html 拒绝，data:image / https / 空串通过', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,<script>', 'ftp://x/y.png']) {
      const r = validateYAML(`experience:\n  app_favicon: "${bad}"`)
      expect(r.parseFailed || r.ok).toBe(false)
    }
    for (const good of ['data:image/png;base64,iVBOR', 'https://cdn.example/x.png', '']) {
      const r = validateYAML(`experience:\n  app_favicon: "${good}"`)
      expect(r.parseFailed).toBe(false)
      if (!r.parseFailed) expect(r.ok).toBe(true)
    }
  })

  it('show_github 非 boolean 拒绝', () => {
    const r = validateYAML('experience:\n  show_github: "yes"')
    expect(r.parseFailed || r.ok).toBe(false)
  })

  it('推荐问题 4 项拒绝；追问 6 项拒绝；单条 21 字符/纯空格拒绝', () => {
    const tooManyRq = validateYAML('experience:\n  recommended_questions: ["a", "b", "c", "d"]')
    expect(tooManyRq.parseFailed || tooManyRq.ok).toBe(false)
    const tooManyFq = validateYAML('experience:\n  followup_questions: ["1", "2", "3", "4", "5", "6"]')
    expect(tooManyFq.parseFailed || tooManyFq.ok).toBe(false)
    const tooLong = validateYAML('experience:\n  recommended_questions: ["123456789012345678901"]')
    expect(tooLong.parseFailed).toBe(false)
    if (!tooLong.parseFailed) expect(tooLong.errors).toContainEqual({
      path: 'experience.recommended_questions',
      code: ErrCode.CONFIG_IMPORT_BAD_QUESTION,
      params: { field: 'recommended_questions' },
    })
    const blank = validateYAML('experience:\n  recommended_questions: ["   "]')
    expect(blank.parseFailed || blank.ok).toBe(false)
  })
})

describe('validateImportBundle — agents', () => {
  it('中立 Agent：改名拒绝、同名通过、avatar 产生 warning', () => {
    const renamed = validateYAML(`agents:\n  - id: ${NEUTRAL_AGENT_ID}\n    name: 黑客`)
    expect(renamed.parseFailed).toBe(false)
    if (!renamed.parseFailed) {
      expect(renamed.ok).toBe(false)
      expect(codes(renamed.errors)).toContain(ErrCode.CONFIG_IMPORT_NEUTRAL_NAME_IMMUTABLE)
    }
    const same = validateYAML(`agents:\n  - id: ${NEUTRAL_AGENT_ID}\n    name: ${NEUTRAL_AGENT_NAME}\n    model: gpt-4o`)
    expect(same.parseFailed).toBe(false)
    if (!same.parseFailed) expect(same.ok).toBe(true)

    const withAvatar = validateYAML(`agents:\n  - role: neutral\n    avatar: https://x/y.png`)
    expect(withAvatar.parseFailed).toBe(false)
    if (!withAvatar.parseFailed) {
      expect(withAvatar.ok).toBe(true)
      expect(codes(withAvatar.warnings)).toContain(ErrCode.CONFIG_IMPORT_NEUTRAL_AVATAR_IGNORED)
      // avatar 被忽略——不进 bundle
      expect(withAvatar.bundle?.agents?.[0]?.avatar).toBeUndefined()
    }

    // 空串 avatar（导出文件自带）不产生 warning 噪音
    const emptyAvatar = validateYAML(`agents:\n  - role: neutral\n    avatar: ""`)
    expect(emptyAvatar.parseFailed).toBe(false)
    if (!emptyAvatar.parseFailed) expect(emptyAvatar.warnings).toEqual([])
  })

  it('普通 Agent：id 非 UUID 拒绝；省略 id 通过（新建）', () => {
    const bad = validateYAML('agents:\n  - id: abc\n    name: X')
    expect(bad.parseFailed || bad.ok).toBe(false)
    const good = validateYAML('agents:\n  - name: 新角色\n    model: gpt-4o')
    expect(good.parseFailed).toBe(false)
    if (!good.parseFailed) {
      expect(good.ok).toBe(true)
      expect(good.bundle?.agents?.[0]?.id).toBeUndefined()
    }
  })

  it('新建（id 缺省或库中不存在）必须提供 name；已存在者可省略全部字段以外的键', () => {
    const noNameNew = validateYAML('agents:\n  - model: gpt-4o')
    expect(noNameNew.parseFailed).toBe(false)
    if (!noNameNew.parseFailed) expect(codes(noNameNew.errors)).toContain(ErrCode.CONFIG_IMPORT_AGENT_NAME_REQUIRED)

    const noNameUnknownId = validateYAML(`agents:\n  - id: ${UUID_B}\n    model: gpt-4o`)
    expect(noNameUnknownId.parseFailed).toBe(false)
    if (!noNameUnknownId.parseFailed) expect(codes(noNameUnknownId.errors)).toContain(ErrCode.CONFIG_IMPORT_AGENT_NAME_REQUIRED)

    // UUID_A 已存在：只给 model，省略 name → 通过
    const partialUpdate = validateYAML(`agents:\n  - id: ${UUID_A}\n    model: claude`)
    expect(partialUpdate.parseFailed).toBe(false)
    if (!partialUpdate.parseFailed) expect(partialUpdate.ok).toBe(true)
  })

  it('name 31 字符拒绝；role 非法拒绝；未知键拒绝', () => {
    const longName = validateYAML(`agents:\n  - id: ${UUID_A}\n    name: "${'a'.repeat(31)}"`)
    expect(longName.parseFailed || longName.ok).toBe(false)
    const badRole = validateYAML(`agents:\n  - id: ${UUID_A}\n    name: X\n    role: admin`)
    expect(badRole.parseFailed || badRole.ok).toBe(false)
    const unknownKey = validateYAML(`agents:\n  - id: ${UUID_A}\n    voice_enabled: true`)
    expect(unknownKey.parseFailed).toBe(false)
    if (!unknownKey.parseFailed) expect(unknownKey.errors).toContainEqual({
      path: 'agents[0].voice_enabled',
      code: ErrCode.CONFIG_IMPORT_UNKNOWN_AGENT_KEY,
      params: { key: 'voice_enabled' },
    })
  })

  it('51 个 agent 拒绝；文件内重复 id 拒绝', () => {
    const many = 'agents:\n' + Array.from({ length: 51 }, (_, i) => `  - name: A${i}`).join('\n')
    const tooMany = validateYAML(many)
    expect(tooMany.parseFailed).toBe(false)
    if (!tooMany.parseFailed) expect(codes(tooMany.errors)).toContain(ErrCode.CONFIG_IMPORT_TOO_MANY_AGENTS)

    const dup = validateYAML(`agents:\n  - id: ${UUID_A}\n    name: A\n  - id: ${UUID_A}\n    name: B`)
    expect(dup.parseFailed).toBe(false)
    if (!dup.parseFailed) expect(dup.errors).toContainEqual({
      path: 'agents[1]',
      code: ErrCode.CONFIG_IMPORT_DUPLICATE_AGENT_ID,
      params: { id: UUID_A },
    })
  })

  it('普通条目带 role: neutral 之外的中立 id 伪装——id 即中立 ID 时按中立处理', () => {
    // id 是 neutral-agent 但 role 缺省 → 中立分支（name 校验、avatar 忽略）
    const r = validateYAML(`agents:\n  - id: ${NEUTRAL_AGENT_ID}\n    name: ${NEUTRAL_AGENT_NAME}\n    avatar: https://x/y.png`)
    expect(r.parseFailed).toBe(false)
    if (!r.parseFailed) {
      expect(r.ok).toBe(true)
      expect(r.bundle?.agents?.[0]?.role).toBe('neutral')
    }
  })
})

describe('validateImportBundle — users', () => {
  const baseProvider = 'oauth_providers:\n    - id: github\n      name: GitHub\n      authorize_url: https://github.com/a\n      token_url: https://github.com/t\n      userinfo_url: https://api.github.com/user\n      scopes: read:user'

  it('未知键拒绝；开关非 boolean 拒绝', () => {
    const r = validateYAML('users:\n  mcp: true\n  direct_registration_open: "yes"')
    expect(r.parseFailed).toBe(false)
    if (!r.parseFailed) {
      expect(r.errors).toContainEqual({
        path: 'users.mcp',
        code: ErrCode.CONFIG_IMPORT_UNKNOWN_USERS_KEY,
        params: { key: 'mcp' },
      })
      expect(r.errors).toContainEqual({
        path: 'users.direct_registration_open',
        code: ErrCode.CONFIG_IMPORT_BAD_BOOLEAN,
        params: { field: 'direct_registration_open' },
      })
    }
  })

  it('provider id 含 / 或 65 字符拒绝；URL 非 http(s) 拒绝；第九字段拒绝；重复 id 拒绝；11 个拒绝', () => {
    const badId = validateYAML('users:\n  oauth_providers:\n    - id: "a/b"\n      name: X')
    expect(badId.parseFailed || badId.ok).toBe(false)
    const longId = validateYAML(`users:\n  oauth_providers:\n    - id: "${'a'.repeat(65)}"\n      name: X`)
    expect(longId.parseFailed || longId.ok).toBe(false)
    const badUrl = validateYAML('users:\n  oauth_providers:\n    - id: gh\n      name: X\n      authorize_url: ftp://x')
    expect(badUrl.parseFailed).toBe(false)
    if (!badUrl.parseFailed) expect(badUrl.errors).toContainEqual({
      path: 'users.oauth_providers[0].authorize_url',
      code: ErrCode.CONFIG_IMPORT_BAD_PROVIDER_URL,
      params: { field: 'authorize_url' },
    })
    const unknownField = validateYAML('users:\n  oauth_providers:\n    - id: gh\n      name: X\n      extra: 1')
    expect(unknownField.parseFailed).toBe(false)
    if (!unknownField.parseFailed) expect(unknownField.errors).toContainEqual({
      path: 'users.oauth_providers[0].extra',
      code: ErrCode.CONFIG_IMPORT_UNKNOWN_PROVIDER_KEY,
      params: { key: 'extra' },
    })
    const dup = validateYAML('users:\n  oauth_providers:\n    - id: gh\n      name: X\n    - id: gh\n      name: Y')
    expect(dup.parseFailed).toBe(false)
    if (!dup.parseFailed) expect(dup.errors).toContainEqual({
      path: 'users.oauth_providers[1].id',
      code: ErrCode.CONFIG_IMPORT_DUPLICATE_PROVIDER_ID,
      params: { id: 'gh' },
    })
    const many = 'users:\n  oauth_providers:\n' + Array.from({ length: 11 }, (_, i) => `    - id: p${i}\n      name: P${i}`).join('\n')
    const tooMany = validateYAML(many)
    expect(tooMany.parseFailed).toBe(false)
    if (!tooMany.parseFailed) expect(codes(tooMany.errors)).toContain(ErrCode.CONFIG_IMPORT_TOO_MANY_PROVIDERS)
  })

  it('合法 provider 通过，省略的可选字段不进 bundle', () => {
    const r = validateYAML(`users:\n  ${baseProvider}`)
    expect(r.parseFailed).toBe(false)
    if (!r.parseFailed) {
      expect(r.ok).toBe(true)
      const p = r.bundle?.users?.oauth_providers?.[0]
      expect(p?.id).toBe('github')
      expect(p?.client_id).toBeUndefined()
    }
  })
})

// ---- 导出 / 往返 ----

describe('buildExportBundle + stringify + parse 往返', () => {
  it('导出只含白名单字段：无 api_key/api_endpoint/voice/created_at', async () => {
    const fx = makeDeps()
    const bundle = await buildExportBundle(fx.deps)
    const text = stringifyExportYAML(bundle)
    expect(text).not.toContain('sk-secret')
    expect(text).not.toContain('api.openai.com')
    expect(text).not.toContain('voice_')
    expect(text).not.toContain('created_at')
    expect(text).not.toContain('support_attachments')
  })

  it('多行 system_prompt、空数组、空串、OAuth provider 完整往返', async () => {
    const provider: OAuth2Provider = {
      id: 'github', name: 'GitHub', client_id: 'Iv1.abc', client_secret: 'ghp_x',
      authorize_url: 'https://github.com/a', token_url: 'https://github.com/t',
      userinfo_url: 'https://api.github.com/user', scopes: 'read:user',
    }
    const fx = makeDeps({
      __config: makeConfig({
        app_favicon: 'data:image/png;base64,iVBOR',
        app_background: '',
        recommended_questions: ['你好', '介绍你自己'],
        followup_questions: [],
        oauth_providers: [provider],
      }),
    })
    const bundle = await buildExportBundle(fx.deps)
    const text = stringifyExportYAML(bundle)

    // 自己导出的文件必须能通过完整导入管线
    const parsed = parseImportYAML(text)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const v = validateImportBundle(parsed.data, makeCtx([NEUTRAL_AGENT_ID, UUID_A]))
    expect(v.ok).toBe(true)
    if (!v.ok) return

    expect(v.bundle?.experience?.app_name).toBe('Momoi')
    expect(v.bundle?.experience?.app_favicon).toBe('data:image/png;base64,iVBOR')
    expect(v.bundle?.experience?.recommended_questions).toEqual(['你好', '介绍你自己'])
    expect(v.bundle?.experience?.followup_questions).toEqual([])
    // 多行 system_prompt 块标量往返无损
    expect(v.bundle?.agents?.find((a) => a.id === UUID_A)?.system_prompt).toBe('hello\nworld')
    expect(v.bundle?.users?.oauth_providers).toEqual([provider])
  })
})

// ---- summarize / apply ----

describe('summarizeImport（dry-run）', () => {
  it('部分文件：只写 app_name，摘要只含该键，省略键不动', async () => {
    const fx = makeDeps()
    const bundle: ConfigExportBundle = { version: 1, experience: { app_name: 'New Name' } }
    const summary = await summarizeImport(bundle, fx.deps)
    expect(summary.experience?.changed).toEqual(['app_name'])
    expect(summary.experience?.unchanged).toEqual([]) // unchanged 只含文件中出现的键
    expect(summary.agents).toBeNull()
    expect(summary.users).toBeNull()
  })

  it('agent 摘要：更新 / 新建 / 跳过 / 中立', async () => {
    const fx = makeDeps()
    const summary = await summarizeImport({
      version: 1,
      agents: [
        { id: NEUTRAL_AGENT_ID, role: 'neutral', model: 'claude' },       // 中立 model 变化 → update
        { id: UUID_A, name: 'Momoi', model: 'gpt-4o', system_prompt: 'hello\nworld' }, // 与库一致 → skip
        { name: '全新角色', model: 'x' },                                  // 无 id → create
      ],
    }, fx.deps)
    expect(summary.agents?.update).toEqual([{ id: NEUTRAL_AGENT_ID, name: NEUTRAL_AGENT_NAME, neutral: true }])
    expect(summary.agents?.skip).toEqual([{ id: UUID_A, name: 'Momoi', reason: 'no changes' }])
    expect(summary.agents?.create).toEqual([{ id: null, name: '全新角色' }])
  })

  it('users 摘要：开关 from→to、供应商合并计数', async () => {
    const fx = makeDeps({
      __config: makeConfig({
        oauth_providers: [makeProvider('old', 'Old'), makeProvider('keep', 'Keep')],
      }),
      __directOpen: true,
    })
    const bundle: ConfigExportBundle = {
      version: 1,
      users: {
        direct_registration_open: false,
        oauth_providers: [makeProvider('keep', 'Keep2'), makeProvider('new', 'New')],
      },
    }
    const summary = await summarizeImport(bundle, fx.deps)
    expect(summary.users?.direct_registration_open).toEqual({ from: true, to: false })
    expect(summary.users?.oauth_registration_open).toBeNull() // 未提供 → null
    expect(summary.users?.providers_update).toBe(1)
    expect(summary.users?.providers_create).toBe(1)
    expect(summary.users?.providers_skip).toBe(1)
  })
})

function makeProvider(id: string, name: string): OAuth2Provider {
  return { id, name, client_id: 'cid', client_secret: 'sec', authorize_url: 'https://a', token_url: 'https://t', userinfo_url: 'https://u', scopes: 's' }
}

function emptyProvider(): OAuth2Provider {
  return { id: '', name: '', client_id: '', client_secret: '', authorize_url: '', token_url: '', userinfo_url: '', scopes: '' }
}

describe('applyImportBundle', () => {
  it('experience 只覆盖出现的字段，省略键不动', async () => {
    const fx = makeDeps()
    await applyImportBundle({ version: 1, experience: { app_name: 'New' } }, fx.deps)
    expect(fx.calls.updateConfig).toHaveLength(1)
    expect(fx.calls.updateConfig[0]).toEqual({ app_name: 'New' })
    expect(fx.config.show_github).toBe(true) // 未动
  })

  it('updateAgent 只收到文件中出现的字段；无变化条目跳过；不触发删除', async () => {
    const fx = makeDeps()
    await applyImportBundle({
      version: 1,
      agents: [
        { id: UUID_A, model: 'claude' }, // 只改 model——name/system_prompt 不应出现在 partial
        { id: UUID_A, name: 'Momoi', model: 'gpt-4o', system_prompt: 'hello\nworld' }, // 与库初始状态一致 → skip（计划先于执行，比较基于快照）
      ],
    }, fx.deps)
    expect(fx.calls.updateAgent).toEqual([[UUID_A, { model: 'claude' }]])
    expect(fx.agents).toHaveLength(2) // 没有删除/新建
  })

  it('中立条目只应用 model/system_prompt，name/avatar 不写入', async () => {
    const fx = makeDeps()
    await applyImportBundle({
      version: 1,
      agents: [{ id: NEUTRAL_AGENT_ID, role: 'neutral', name: NEUTRAL_AGENT_NAME, model: 'new-model' }],
    }, fx.deps)
    expect(fx.calls.updateAgent).toEqual([[NEUTRAL_AGENT_ID, { model: 'new-model' }]])
    const neutral = fx.agents.find((a) => a.id === NEUTRAL_AGENT_ID)
    expect(neutral?.name).toBe(NEUTRAL_AGENT_NAME)
  })

  it('新建：带 id 传 idOverride（保留原 id），省略 id 无 idOverride', async () => {
    const fx = makeDeps()
    await applyImportBundle({
      version: 1,
      agents: [
        { id: UUID_B, name: 'By Id', model: 'm' },
        { name: 'No Id', model: 'm' },
      ],
    }, fx.deps)
    expect(fx.calls.createAgent).toEqual([
      { name: 'By Id', idOverride: UUID_B },
      { name: 'No Id', idOverride: undefined },
    ])
  })

  it('OAuth 供应商合并：同 id 字段级覆盖、新 id 追加、库中多余保留', async () => {
    const fx = makeDeps({
      __config: makeConfig({ oauth_providers: [makeProvider('old', 'Old'), makeProvider('keep', 'Keep')] }),
    })
    await applyImportBundle({
      version: 1,
      users: { oauth_providers: [{ id: 'keep', name: 'Keep2', scopes: 'new-scope' }, { id: 'new', name: 'New' }] },
    }, fx.deps)
    const written = fx.calls.updateConfig.find((c) => 'oauth_providers' in c)?.oauth_providers
    expect(written).toEqual([
      makeProvider('old', 'Old'),                            // 多余保留
      { ...makeProvider('keep', 'Keep'), name: 'Keep2', scopes: 'new-scope' }, // 字段级合并：省略字段保留原值
      { ...emptyProvider(), id: 'new', name: 'New' },        // 新建：缺省字段空串
    ])
  })

  it('开关出现才写入', async () => {
    const fx = makeDeps()
    await applyImportBundle({ version: 1, users: { oauth_registration_open: false } }, fx.deps)
    expect(fx.calls.setDirectRegistrationOpen).toHaveLength(0)
    expect(fx.calls.setOauthRegistrationOpen).toEqual([false])
  })

  it('外部图床开启：data: 图片转 CDN；CDN 失败保留原值', async () => {
    const ok = makeDeps({ __externalHosting: true })
    await applyImportBundle({
      version: 1,
      experience: { app_favicon: 'data:image/png;base64,iVBOR' },
      agents: [{ id: UUID_A, avatar: 'data:image/png;base64,iVBOR' }],
    }, ok.deps)
    expect(ok.calls.cdnUploads).toEqual(['favicon.png', 'avatar.png'])
    expect(ok.calls.updateConfig[0]).toMatchObject({ app_favicon: 'https://cdn.example/favicon.png' })

    const failing = makeDeps({ __externalHosting: true, __cdnShouldFail: true })
    await applyImportBundle({ version: 1, experience: { app_background: 'data:image/png;base64,iVBOR' } }, failing.deps)
    expect(failing.calls.updateConfig[0]).toMatchObject({ app_background: 'data:image/png;base64,iVBOR' })
  })

  it('summarize 计数与 apply 实际操作一致', async () => {
    const bundle: ConfigExportBundle = {
      version: 1,
      experience: { app_name: 'New', show_github: false },
      agents: [
        { id: UUID_A, model: 'claude' },
        { name: 'Brand New' },
      ],
      users: { direct_registration_open: false },
    }
    const dry = makeDeps()
    const summary = await summarizeImport(bundle, dry.deps)
    const real = makeDeps()
    await applyImportBundle(bundle, real.deps)

    expect(summary.experience?.changed).toEqual(['app_name', 'show_github'])
    expect(real.calls.updateConfig.map((c) => Object.keys(c))).toEqual([['app_name', 'show_github']])

    expect(summary.agents?.update).toHaveLength(real.calls.updateAgent.length)
    expect(summary.agents?.create).toHaveLength(real.calls.createAgent.length)
    expect(summary.users?.direct_registration_open).toEqual({ from: true, to: false })
    expect(real.calls.setDirectRegistrationOpen).toEqual([false])
  })
})
