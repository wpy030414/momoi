import { describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { NEUTRAL_AGENT_ID, NEUTRAL_AGENT_NAME } from '../../../shared/constants.js'
import type { Agent } from '../../../shared/types.js'
import { computeConflicts, parseAgentPackage } from '../parser.js'
import {
  ALPHA_PERSONA,
  BETA_PERSONA,
  PLACEHOLDER_PROMPT_ALPHA,
  PLACEHOLDER_PROMPT_GAMMA,
  buildTraversalZip,
  buildZip,
  extensionPackage,
  pluginJson,
  universalPackage,
} from './fixtures/index.js'

function neutralAgent(): Agent {
  return {
    id: NEUTRAL_AGENT_ID,
    name: NEUTRAL_AGENT_NAME,
    model: '',
    system_prompt: '',
    avatar: '',
    role: 'neutral',
    created_at: 1,
    origin: null,
  }
}

describe('parseAgentPackage — 扩展形态', () => {
  it('1. 扩展形态完整包 → 解析出包元数据、双人格、头像与源技能', () => {
    const result = parseAgentPackage(extensionPackage())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.package).toEqual({ name: 'placeholder-plugin', version: '1.0.0', host: 'placeholder-host' })
    expect(result.data.errors).toEqual([])
    expect(result.data.warnings).toEqual([])

    expect(result.data.candidates.map((c) => c.id)).toEqual(['alpha', 'beta'])
    const alpha = result.data.candidates[0]
    expect(alpha.name).toBe('占位人格甲')
    expect(alpha.systemPrompt).toBe(PLACEHOLDER_PROMPT_ALPHA)
    expect(alpha.primaryFile).toBe('skills/placeholder-skill/personas/alpha.md')
    expect(alpha.primaryBytes).toBe(Buffer.byteLength(PLACEHOLDER_PROMPT_ALPHA))
    expect(alpha.avatar).toMatch(/^data:image\/png;base64,/)
    expect(alpha.levelCount).toBe(2)

    const beta = result.data.candidates[1]
    expect(beta.avatar).toBeUndefined()
    expect(beta.levelCount).toBe(1)

    expect(result.data.skills).toHaveLength(1)
    const skill = result.data.skills[0]
    expect(skill.name).toBe('placeholder-skill')
    expect(skill.description).toBe('占位技能描述')
    expect(skill.files.map((f) => f.path)).toEqual([
      'SKILL.md',
      'personas/alpha.md',
      'personas/alpha.png',
      'personas/beta.md',
      'references/notes.txt',
    ])
    expect(skill.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('3. 共存形态且正文不一致 → warnings 命中；一致时不产生 warning', () => {
    const mismatched = parseAgentPackage(
      extensionPackage({
        files: { 'agents/alpha.md': '---\nname: 占位人格甲\n---\n\nDIFFERENT PLACEHOLDER BODY' },
      }),
    )
    expect(mismatched.ok).toBe(true)
    if (!mismatched.ok) return
    expect(mismatched.data.warnings.some((w) => w.includes('alpha') && w.includes('differs'))).toBe(true)
    // 以扩展清单为准
    expect(mismatched.data.candidates[0].systemPrompt).toBe(PLACEHOLDER_PROMPT_ALPHA)

    const matched = parseAgentPackage(
      extensionPackage({
        files: { 'agents/alpha.md': `---\nname: 占位人格甲\n---\n\n${PLACEHOLDER_PROMPT_ALPHA}` },
      }),
    )
    expect(matched.ok).toBe(true)
    if (!matched.ok) return
    expect(matched.data.warnings).toEqual([])
  })

  it('6a. formatVersion 非 1 → 整包拒绝', () => {
    const result = parseAgentPackage(extensionPackage({ manifest: { formatVersion: 2 } }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('formatVersion')
  })

  it('6b. persona id 大写 → 该项记入 errors，其余候选保留', () => {
    const result = parseAgentPackage(
      extensionPackage({ manifest: { personas: [{ ...ALPHA_PERSONA, id: 'Alpha' }, BETA_PERSONA] } }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.candidates.map((c) => c.id)).toEqual(['beta'])
    expect(result.data.errors).toHaveLength(1)
    expect(result.data.errors[0]).toContain('Alpha')
    expect(result.data.errors[0]).toContain('[a-z0-9-]+')
  })

  it('6c. primary 越界 → 该项记入 errors，其余候选保留', () => {
    const result = parseAgentPackage(
      extensionPackage({ manifest: { personas: [{ ...ALPHA_PERSONA, primary: '../outside.md' }, BETA_PERSONA] } }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.candidates.map((c) => c.id)).toEqual(['beta'])
    expect(result.data.errors).toHaveLength(1)
    expect(result.data.errors[0]).toContain('outside the plugin root')
  })

  it('6d. primary 缺失 → 该项记入 errors，其余候选保留', () => {
    const result = parseAgentPackage(
      extensionPackage({
        manifest: {
          personas: [{ ...ALPHA_PERSONA, primary: 'skills/placeholder-skill/personas/missing.md' }, BETA_PERSONA],
        },
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.candidates.map((c) => c.id)).toEqual(['beta'])
    expect(result.data.errors).toHaveLength(1)
    expect(result.data.errors[0]).toContain('not found')
  })

  it('7. 部分坏 persona（一个缺文件）→ 隔离：errors 含该条，其余候选保留', () => {
    const result = parseAgentPackage(
      extensionPackage({
        manifest: {
          personas: [{ ...ALPHA_PERSONA, primary: 'skills/placeholder-skill/personas/gone.md' }, BETA_PERSONA],
        },
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.errors).toHaveLength(1)
    expect(result.data.errors[0]).toContain('alpha')
    expect(result.data.candidates).toHaveLength(1)
    expect(result.data.candidates[0].id).toBe('beta')
  })

  it('8. 中立 Agent 撞名（id / 显示名）→ 记入 errors，不进入候选与冲突列表', () => {
    const result = parseAgentPackage(
      extensionPackage({
        manifest: {
          personas: [
            { ...ALPHA_PERSONA, id: NEUTRAL_AGENT_ID },
            { ...BETA_PERSONA, name: NEUTRAL_AGENT_NAME },
          ],
        },
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.candidates).toEqual([])
    expect(result.data.errors).toHaveLength(2)
    expect(result.data.errors.every((e) => e.includes('neutral agent'))).toBe(true)

    const report = computeConflicts(result.data, [neutralAgent()], [])
    expect(report.personas).toEqual([])
  })

  it('8b. 通用层中立 Agent 撞名同样记入 errors', () => {
    const result = parseAgentPackage(
      universalPackage({ [`agents/${NEUTRAL_AGENT_ID}.md`]: '---\nname: 占位人格\n---\n\nPLACEHOLDER' }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.candidates.map((c) => c.id)).toEqual(['gamma'])
    expect(result.data.errors).toHaveLength(1)
    expect(result.data.errors[0]).toContain('neutral agent')
  })

  it('12. 技能文件路径含 ":"（NTFS 备用数据流）→ 跳过并记 errors', () => {
    const result = parseAgentPackage(
      extensionPackage({ files: { 'skills/placeholder-skill/evil:ads.txt': 'placeholder' } }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.errors.some((e) => e.includes('unsafe file path') && e.includes('evil:ads.txt'))).toBe(true)
    expect(result.data.skills[0].files.some((file) => file.path.includes(':'))).toBe(false)
    // 其余文件仍进入技能载荷
    expect(result.data.skills[0].files.map((file) => file.path)).toContain('SKILL.md')
  })

  it('11. 包内 model 字段被忽略（协议 §2.4）', () => {
    const result = parseAgentPackage(
      extensionPackage({
        manifest: { personas: [{ ...ALPHA_PERSONA, model: 'placeholder-model' }] },
        files: {
          'agents/alpha.md': `---\nname: 占位人格甲\nmodel: placeholder-model\n---\n\n${PLACEHOLDER_PROMPT_ALPHA}`,
        },
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const candidate = result.data.candidates[0]
    expect('model' in candidate).toBe(false)
    expect(candidate.systemPrompt).toBe(PLACEHOLDER_PROMPT_ALPHA)
    expect(result.data.warnings).toEqual([])
  })
})

describe('parseAgentPackage — 通用形态', () => {
  it('2. 仅 agents/*.md → 按通用层发现（frontmatter name + 正文 + 头像）', () => {
    const result = parseAgentPackage(universalPackage())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.package).toEqual({ name: 'placeholder-plugin', version: '1.0.0' })
    expect(result.data.errors).toEqual([])
    expect(result.data.candidates).toHaveLength(1)

    const gamma = result.data.candidates[0]
    expect(gamma.id).toBe('gamma')
    expect(gamma.name).toBe('占位人格丙')
    expect(gamma.primaryFile).toBe('agents/gamma.md')
    expect(gamma.systemPrompt).toBe(PLACEHOLDER_PROMPT_GAMMA)
    expect(gamma.avatar).toMatch(/^data:image\/png;base64,/)
    expect(gamma.levelCount).toBe(1)
    expect(result.data.skills).toEqual([])
  })
})

describe('fixture 自洽性', () => {
  it('扩展形态清单引用的 primary/avatar/levels 文件都存在于包内（与 aip validate 文件存在性一致）', () => {
    const names = new Set(
      new AdmZip(extensionPackage()).getEntries().map((entry) => entry.entryName.replace(/\\/g, '/')),
    )
    const personas = [ALPHA_PERSONA, BETA_PERSONA] as Array<{
      primary: string
      avatar?: string
      levels?: Record<string, string[]>
    }>
    const refs = personas.flatMap((persona) => [
      persona.primary,
      ...(persona.avatar ? [persona.avatar] : []),
      ...Object.values(persona.levels ?? {}).flat(),
    ])

    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      expect(names.has(ref), `fixture 缺少被引用的文件: ${ref}`).toBe(true)
    }
  })
})

describe('parseAgentPackage — 失败边界', () => {
  it('4. 非 AIP 包 → 语义错误', () => {
    const result = parseAgentPackage(buildZip({ 'readme.txt': 'placeholder' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('Not an agent import package')
  })

  it('4b. 有 plugin.json 但既无扩展清单也无 agents/ → 语义错误', () => {
    const result = parseAgentPackage(buildZip({ 'plugin.json': pluginJson() }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toBe('Not an agent import package')
  })

  it('5. 路径穿越 zip → 拒绝', () => {
    const result = parseAgentPackage(buildTraversalZip())
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('path traversal')
  })

  it('5b. 非 zip 字节 → 拒绝', () => {
    const result = parseAgentPackage(Buffer.from('not a zip at all', 'utf-8'))
    expect(result.ok).toBe(false)
  })
})
