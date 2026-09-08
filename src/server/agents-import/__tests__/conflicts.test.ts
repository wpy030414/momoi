import { describe, expect, it } from 'vitest'
import { NEUTRAL_AGENT_ID, NEUTRAL_AGENT_NAME } from '../../../shared/constants.js'
import type { Agent } from '../../../shared/types.js'
import { computeConflicts, parseAgentPackage } from '../parser.js'
import { extensionPackage } from './fixtures/index.js'

function agent(overrides: Partial<Agent> & Pick<Agent, 'id' | 'name'>): Agent {
  return {
    model: '',
    system_prompt: '',
    avatar: '',
    role: 'default',
    created_at: 1,
    origin: null,
    ...overrides,
  }
}

function parseFixture() {
  const result = parseAgentPackage(extensionPackage())
  if (!result.ok) throw new Error(`fixture should parse: ${result.error}`)
  return result.data
}

describe('computeConflicts', () => {
  it('9. 人格先按 origin 匹配、再按显示名精确匹配；sameOrigin 按 package.name + personaId 判定', () => {
    const data = parseFixture()
    const existing: Agent[] = [
      agent({
        id: 'agent-same-origin',
        name: '占位人格甲',
        origin: {
          protocol: 'aip',
          package: { name: 'placeholder-plugin', version: '1.0.0' },
          personaId: 'alpha',
          importedAt: 1,
        },
      }),
      agent({
        id: 'agent-other-origin',
        name: '占位人格乙',
        origin: {
          protocol: 'aip',
          package: { name: 'other-plugin', version: '1.0.0' },
          personaId: 'beta',
          importedAt: 2,
        },
      }),
      agent({ id: 'agent-unrelated', name: '占位人格丙' }),
    ]

    const report = computeConflicts(data, existing, [])

    const alpha = report.personas.find((entry) => entry.candidate.id === 'alpha')
    expect(alpha?.conflict).toEqual({ agentId: 'agent-same-origin', agentName: '占位人格甲', sameOrigin: true })

    const beta = report.personas.find((entry) => entry.candidate.id === 'beta')
    expect(beta?.conflict).toEqual({ agentId: 'agent-other-origin', agentName: '占位人格乙', sameOrigin: false })

    expect(report.personas).toHaveLength(2)
  })

  it('9b. 无同名现库 → 无 conflict', () => {
    const report = computeConflicts(parseFixture(), [agent({ id: 'agent-unrelated', name: '占位人格丙' })], [])
    expect(report.personas.every((entry) => entry.conflict === undefined)).toBe(true)
  })

  it('9f. 同源改名 → 先按 origin 命中，same_origin=true 且指向既有行', () => {
    const data = parseFixture()
    const existing: Agent[] = [
      agent({
        id: 'agent-renamed',
        name: '改名后的显示名',
        origin: {
          protocol: 'aip',
          package: { name: 'placeholder-plugin', version: '1.0.0' },
          personaId: 'alpha',
          importedAt: 1,
        },
      }),
    ]

    const report = computeConflicts(data, existing, [])

    const alpha = report.personas.find((entry) => entry.candidate.id === 'alpha')
    expect(alpha?.conflict).toEqual({ agentId: 'agent-renamed', agentName: '改名后的显示名', sameOrigin: true })
    // beta 既无同源也无同名 → 无冲突
    expect(report.personas.find((entry) => entry.candidate.id === 'beta')?.conflict).toBeUndefined()
  })

  it('9g. 同源命中优先于同名命中（另一行同名但不同源时仍指向同源行）', () => {
    const data = parseFixture()
    const existing: Agent[] = [
      agent({ id: 'agent-name-twin', name: '占位人格甲' }),
      agent({
        id: 'agent-same-origin',
        name: '改名后的显示名',
        origin: {
          protocol: 'aip',
          package: { name: 'placeholder-plugin', version: '1.0.0' },
          personaId: 'alpha',
          importedAt: 1,
        },
      }),
    ]

    const report = computeConflicts(data, existing, [])

    const alpha = report.personas.find((entry) => entry.candidate.id === 'alpha')
    expect(alpha?.conflict).toEqual({ agentId: 'agent-same-origin', agentName: '改名后的显示名', sameOrigin: true })
  })

  it('9c. 中立 Agent 同名不参与比对', () => {
    const data = parseFixture()
    const existing: Agent[] = [
      agent({ id: NEUTRAL_AGENT_ID, name: '占位人格甲', role: 'neutral' }),
      agent({ id: 'shadow-neutral', name: '占位人格乙', role: 'neutral' }),
    ]

    const report = computeConflicts(data, existing, [])
    expect(report.personas.every((entry) => entry.conflict === undefined)).toBe(true)
  })

  it('9d. 技能按 frontmatter name 匹配；内容一致按文件树哈希判定', () => {
    const data = parseFixture()
    const hash = data.skills[0].contentHash

    const different = computeConflicts(data, [], [{ name: 'placeholder-skill', contentHash: 'deadbeef' }])
    expect(different.skills[0].conflict).toEqual({ installed: true, contentIdentical: false })

    const identical = computeConflicts(data, [], [{ name: 'placeholder-skill', contentHash: hash }])
    expect(identical.skills[0].conflict).toEqual({ installed: true, contentIdentical: true })

    const missing = computeConflicts(data, [], [{ name: 'other-skill', contentHash: hash }])
    expect(missing.skills[0].conflict).toEqual({ installed: false, contentIdentical: false })
  })

  it('9e. 中立 Agent 常量与显示名保持契约值', () => {
    // 防止后续改动把中立 Agent 的保留标识改掉而让上面的隔离断言失真
    expect(NEUTRAL_AGENT_ID).toBe('neutral-agent')
    expect(NEUTRAL_AGENT_NAME).toBe('中立 Agent')
  })
})
