import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Agent, AgentOrigin } from '../../../shared/types.js'
import { parseAgentPackage } from '../parser.js'
import { resetImportStore, stageImport } from '../store.js'
import { extensionPackage } from './fixtures/index.js'

// 内存 agent 表：路由测试不需要真实 DB（libsql 的文件句柄在 Windows 上要到进程退出才释放，
// 会阻止临时目录清理），mock 掉连接后测试目录可完整回收。
const fake = vi.hoisted(() => ({
  agents: [] as Agent[],
  seq: 0,
}))

vi.mock('../../db.js', () => ({ db: {} as never }))

vi.mock('../../config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../config.js')>()
  return {
    ...mod,
    // 放大 listAgents 的等待，让两个并发 commit 在「取用暂存 → 逐条写入」之间真正交错。
    // 旧实现（先 getStagedImport、写完全部条目后才 deleteStagedImport）下两个请求都会拿到
    // 暂存数据并各自写入；原子取用后只有一个能越过取用点，另一个 404。
    listAgents: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return [...fake.agents]
    },
    createAgent: async (
      name: string,
      model: string,
      systemPrompt: string,
      avatar = '',
      role: Agent['role'] = 'default',
      origin: AgentOrigin | null = null,
    ): Promise<Agent> => {
      const agent: Agent = {
        id: `fake-agent-${++fake.seq}`,
        name,
        model,
        system_prompt: systemPrompt,
        avatar,
        role,
        created_at: 1,
        origin,
      }
      fake.agents.push(agent)
      return agent
    },
    getAgent: async (id: string): Promise<Agent | null> => fake.agents.find((agent) => agent.id === id) ?? null,
    updateAgent: async (
      id: string,
      partial: Partial<Pick<Agent, 'name' | 'model' | 'system_prompt' | 'avatar' | 'origin'>>,
    ): Promise<Agent | null> => {
      const agent = fake.agents.find((row) => row.id === id)
      if (!agent) return null
      Object.assign(agent, partial)
      return agent
    },
    deleteAgent: async (id: string): Promise<boolean> => {
      const index = fake.agents.findIndex((row) => row.id === id)
      if (index === -1) return false
      fake.agents.splice(index, 1)
      return true
    },
  }
})

const originalCwd = process.cwd()
let workDir = ''
let adminRoute: (typeof import('../../routes/admin.js'))['adminRoute']
let token = ''

function parsedFixture() {
  const parsed = parseAgentPackage(extensionPackage())
  if (!parsed.ok) throw new Error(`fixture should parse: ${parsed.error}`)
  return parsed.data
}

async function postCommit(importId: string, body: unknown) {
  const res = await adminRoute.request(`/agents/import/${importId}/commit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

async function agentNames(): Promise<string[]> {
  const res = await adminRoute.request('/agents', { headers: { Authorization: `Bearer ${token}` } })
  const body = (await res.json()) as { agents: Array<{ name: string }> }
  return body.agents.map((agent) => agent.name)
}

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momoi-commit-route-'))
  process.chdir(workDir)
  const admin = await import('../../routes/admin.js')
  const auth = await import('../../auth.js')
  adminRoute = admin.adminRoute
  token = (await auth.signAdminToken()).token
})

afterAll(() => {
  process.chdir(originalCwd)
  fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

describe('POST /agents/import/:import_id/commit — 暂存原子取用', () => {
  it('并发 commit 只有一个请求写入（旧实现两个都会写入）', async () => {
    resetImportStore()
    fake.agents.length = 0
    const importId = stageImport(parsedFixture())
    const decision = { personas: [{ id: 'alpha', action: 'create', name: '并发甲' }], skills: [] }

    const [first, second] = await Promise.all([postCommit(importId, decision), postCommit(importId, decision)])

    expect([first.status, second.status].sort()).toEqual([200, 404])
    const imported = (first.body.imported as unknown[] | undefined) ?? []
    const importedSecond = (second.body.imported as unknown[] | undefined) ?? []
    expect(imported.length + importedSecond.length).toBe(1)
    expect(await agentNames()).toEqual(['并发甲'])
  })

  it('请求体形状非法 → 400 且暂存条目保留，可修正后重试', async () => {
    resetImportStore()
    const importId = stageImport(parsedFixture())

    const bad = await postCommit(importId, { personas: {}, skills: {} })
    expect(bad.status).toBe(400)
    expect(String(bad.body.error)).toContain('must be arrays')

    const retry = await postCommit(importId, { personas: [{ id: 'alpha', action: 'skip' }], skills: [] })
    expect(retry.status).toBe(200)
  })

  it('决议非法（无冲突 overwrite）→ 400 且暂存条目保留，可修正后重试', async () => {
    resetImportStore()
    const importId = stageImport(parsedFixture())

    // beta 未与现库任何 agent 同源/同名，overwrite 必然无冲突
    const bad = await postCommit(importId, { personas: [{ id: 'beta', action: 'overwrite' }], skills: [] })
    expect(bad.status).toBe(400)
    expect(String(bad.body.error)).toContain('no conflict')

    const retry = await postCommit(importId, { personas: [{ id: 'beta', action: 'skip' }], skills: [] })
    expect(retry.status).toBe(200)
  })
})
