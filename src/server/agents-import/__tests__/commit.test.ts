import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_MODEL, NEUTRAL_AGENT_ID } from '../../../shared/constants.js'
import type { Agent } from '../../../shared/types.js'
import { computeConflicts, parseAgentPackage, planCommit, resolveDefaultModel } from '../parser.js'
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

const data = parseFixture()
const noConflict = computeConflicts(data, [], [])
const withAlphaConflict = computeConflicts(
  data,
  [
    agent({
      id: 'agent-alpha',
      name: '占位人格甲',
      origin: {
        protocol: 'aip',
        package: { name: 'placeholder-plugin', version: '1.0.0' },
        personaId: 'alpha',
        importedAt: 1,
      },
    }),
  ],
  [{ name: 'placeholder-skill', contentHash: 'different-hash' }],
)

describe('planCommit — 人格决议映射', () => {
  it('10a. create：取请求的 name/model，origin 指向包 + persona', () => {
    const plan = planCommit(
      data,
      { personas: [{ id: 'alpha', action: 'create', name: '新占位名', model: 'placeholder-model' }] },
      noConflict,
    )

    expect(plan.requestError).toBeUndefined()
    expect(plan.personas[0]).toMatchObject({ kind: 'create', name: '新占位名', model: 'placeholder-model' })
    expect(plan.personas[0].origin).toMatchObject({
      protocol: 'aip',
      package: { name: 'placeholder-plugin', version: '1.0.0' },
      personaId: 'alpha',
    })
    // 未列出的 beta 默认 skip
    expect(plan.personas[1]).toMatchObject({ kind: 'skip' })
    expect(plan.personas[1].candidate.id).toBe('beta')
  })

  it('10b. 未列出默认 skip；显式 skip 也是 skip', () => {
    const plan = planCommit(data, { personas: [{ id: 'alpha', action: 'skip' }] }, noConflict)
    expect(plan.personas.map((item) => item.kind)).toEqual(['skip', 'skip'])
  })

  it('10c. 无冲突传 overwrite → requestError（路由映射 400）', () => {
    const plan = planCommit(data, { personas: [{ id: 'alpha', action: 'overwrite' }] }, noConflict)
    expect(plan.requestError).toContain('alpha')
    expect(plan.requestError).toContain('no conflict')
  })

  it('10d. 有冲突传 overwrite → kind overwrite + 目标 agent id', () => {
    const plan = planCommit(data, { personas: [{ id: 'alpha', action: 'overwrite' }] }, withAlphaConflict)
    expect(plan.requestError).toBeUndefined()
    expect(plan.personas[0]).toMatchObject({ kind: 'overwrite', targetAgentId: 'agent-alpha', name: '占位人格甲' })
  })

  it('10e. 未知 id / 非法 action 的边界', () => {
    const unknown = planCommit(data, { personas: [{ id: 'missing', action: 'create' }] }, noConflict)
    expect(unknown.requestError).toBeUndefined()
    expect(unknown.errors).toHaveLength(1)
    expect(unknown.errors[0]).toContain('Unknown persona')
    // 其余候选仍按默认 skip 进入计划
    expect(unknown.personas.map((item) => item.kind)).toEqual(['skip', 'skip'])

    const invalid = planCommit(data, { personas: [{ id: 'alpha', action: 'replace' as never }] }, noConflict)
    expect(invalid.requestError).toContain('Invalid action')
  })

  it('10h. 空 model 落库前填实例默认；显式 model 不被覆盖；skip 不带 model', () => {
    const fallback = planCommit(
      data,
      { personas: [{ id: 'alpha', action: 'create', model: '' }] },
      noConflict,
      'instance-model',
    )
    expect(fallback.personas[0]).toMatchObject({ kind: 'create', model: 'instance-model' })

    const blank = planCommit(
      data,
      { personas: [{ id: 'alpha', action: 'create', model: '   ' }] },
      noConflict,
      'instance-model',
    )
    expect(blank.personas[0].model).toBe('instance-model')

    const explicit = planCommit(
      data,
      { personas: [{ id: 'alpha', action: 'create', model: 'custom-model' }] },
      noConflict,
      'instance-model',
    )
    expect(explicit.personas[0].model).toBe('custom-model')

    // overwrite 同样应用默认值
    const overwrite = planCommit(
      data,
      { personas: [{ id: 'alpha', action: 'overwrite', model: '' }] },
      withAlphaConflict,
      'instance-model',
    )
    expect(overwrite.personas[0]).toMatchObject({ kind: 'overwrite', model: 'instance-model' })

    // 未显式传 defaultModel → DEFAULT_AGENT_MODEL
    const builtin = planCommit(data, { personas: [{ id: 'alpha', action: 'create' }] }, noConflict)
    expect(builtin.personas[0].model).toBe(DEFAULT_AGENT_MODEL)

    const skipped = planCommit(data, { personas: [{ id: 'alpha', action: 'skip', model: 'x' }] }, noConflict)
    expect(skipped.personas[0]).toMatchObject({ kind: 'skip', model: '' })
  })

  it('10i. 非可迭代的 personas/skills 不抛异常（路由层已映射 400）', () => {
    // 旧实现 `decisions.personas ?? []` 对 {} 直接 for...of → TypeError → 500
    const plan = planCommit(data, { personas: {} as never, skills: {} as never }, noConflict)
    expect(plan.requestError).toBeUndefined()
    expect(plan.personas.map((item) => item.kind)).toEqual(['skip', 'skip'])
    expect(plan.skills.map((item) => item.kind)).toEqual(['skip'])
  })
})

describe('resolveDefaultModel', () => {
  it('取首个非中立 agent 的 model；无或为空则 DEFAULT_AGENT_MODEL', () => {
    expect(resolveDefaultModel([])).toBe(DEFAULT_AGENT_MODEL)
    expect(
      resolveDefaultModel([agent({ id: NEUTRAL_AGENT_ID, name: '中立 Agent', role: 'neutral', model: 'n' })]),
    ).toBe(DEFAULT_AGENT_MODEL)
    expect(resolveDefaultModel([agent({ id: 'a', name: 'A', model: '' })])).toBe(DEFAULT_AGENT_MODEL)
    expect(
      resolveDefaultModel([
        agent({ id: NEUTRAL_AGENT_ID, name: '中立 Agent', role: 'neutral', model: 'neutral-model' }),
        agent({ id: 'a', name: 'A', model: 'first-model' }),
        agent({ id: 'b', name: 'B', model: 'second-model' }),
      ]),
    ).toBe('first-model')
  })
})

describe('planCommit — 技能决议映射', () => {
  it('10f. install / skip / 内容一致跳过 / 内容不同覆盖', () => {
    const install = planCommit(data, { skills: [{ name: 'placeholder-skill', action: 'install' }] }, noConflict)
    expect(install.skills[0].kind).toBe('install')

    const skip = planCommit(data, { skills: [{ name: 'placeholder-skill', action: 'skip' }] }, noConflict)
    expect(skip.skills[0].kind).toBe('skip')

    // 未列出默认 skip
    expect(planCommit(data, {}, noConflict).skills[0].kind).toBe('skip')

    const identical = computeConflicts(
      data,
      [],
      [{ name: 'placeholder-skill', contentHash: data.skills[0].contentHash }],
    )
    const identicalPlan = planCommit(data, { skills: [{ name: 'placeholder-skill', action: 'install' }] }, identical)
    expect(identicalPlan.skills[0].kind).toBe('skip')

    const overwritePlan = planCommit(
      data,
      { skills: [{ name: 'placeholder-skill', action: 'install' }] },
      withAlphaConflict,
    )
    expect(overwritePlan.skills[0].kind).toBe('overwrite')
  })

  it('10g. 未知技能名 → errors，其余决议不受影响', () => {
    const plan = planCommit(
      data,
      {
        personas: [{ id: 'alpha', action: 'create' }],
        skills: [{ name: 'missing-skill', action: 'install' }],
      },
      noConflict,
    )
    expect(plan.requestError).toBeUndefined()
    expect(plan.errors).toHaveLength(1)
    expect(plan.errors[0]).toContain('Unknown skill')
    expect(plan.personas[0].kind).toBe('create')
    // 已声明的技能仍默认 skip 进入计划
    expect(plan.skills[0]).toMatchObject({ kind: 'skip' })
  })
})
