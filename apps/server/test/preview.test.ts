// ============================================================
// 管理端预览：上下文归化与路由行为
// ============================================================

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { ErrCode } from '@momoi/shared/errors'
import { normalizePreviewContext } from '../src/prompts/preview.js'
import { registerErrorHandlers } from '../src/lib/errorHandler.js'
import { promptsRoute } from '../src/routes/prompts.js'

// promptsRoute 单测挂载壳：复用 index.ts 同款全局错误处理（ApiError →
// { code, params } + 注册表 status），否则裸 Hono 路由抛错只会得到 500。
const app = new Hono()
app.route('/', promptsRoute)
registerErrorHandlers(app)

describe('预览上下文归化（白名单）', () => {
  it('chat.system：合法键保留，非法键与非法类型丢弃', () => {
    const ctx = normalizePreviewContext('chat.system', {
      agentSystemPrompt: '人设',
      isGroup: true,
      thinkingMode: 'yes',        // 非法类型 → 丢弃
      groupAgentNames: ['A', 'B'],
      groupAgentNames2: ['A'],    // 未在名单 → 丢弃
      evil: { nested: true },     // 未在名单 → 丢弃
      speakingRole: 'protagonist',
      speakingRoleBad: 'king',    // 未在名单 → 丢弃
    })
    expect(ctx).toEqual({
      agentSystemPrompt: '人设',
      isGroup: true,
      groupAgentNames: ['A', 'B'],
      speakingRole: 'protagonist',
    })
  })

  it('chat.system：world / skills / lastMessageAt 结构校验', () => {
    const ctx = normalizePreviewContext('chat.system', {
      world: { laws: '法则' },
      skills: [{ name: 's', description: 'd' }, { name: 'x' }],  // 第二项非法 → 整体丢弃
      lastMessageAt: 1758000000,
      now: 1758000000,
    })
    expect(ctx.world).toEqual({ laws: '法则' })
    expect(ctx.skills).toBeUndefined()
    expect(ctx.lastMessageAt).toBe(1758000000)
    expect(ctx.now).toBe(1758000000)
  })

  it('greeting：sinceLast 支持 null 与字符串', () => {
    expect(normalizePreviewContext('notification.greeting.user', { sinceLast: null })).toEqual({ sinceLast: null })
    expect(normalizePreviewContext('notification.greeting.user', { sinceLast: '3 分钟前' })).toEqual({ sinceLast: '3 分钟前' })
  })

  it('中立 Agent 配方：extra / context / members 归化', () => {
    expect(normalizePreviewContext('neutral.followup.system', { extra: '人设' })).toEqual({ extra: '人设' })
    expect(normalizePreviewContext('neutral.followup.user', { context: '记录', extra: '忽略' })).toEqual({ context: '记录' })
    expect(normalizePreviewContext('neutral.orchestration.user', { members: ['A'], context: 'c' })).toEqual({ members: ['A'], context: 'c' })
    expect(normalizePreviewContext('neutral.orchestration.user', { members: 'A', context: 'c' })).toEqual({ members: [], context: 'c' })
  })

  it('未识别的配方返回空上下文', () => {
    expect(normalizePreviewContext('some/custom.target', { anything: 1 })).toEqual({})
  })
})

describe('提示词目录与预览路由', () => {
  it('GET / 返回配方清单与片段目录', async () => {
    const res = await app.request('/')
    expect(res.status).toBe(200)
    const body = await res.json() as { targets: any[]; fragments: any[] }
    expect(body.targets.map((t) => t.target)).toContain('chat.system')
    expect(body.fragments.length).toBeGreaterThan(20)
    expect(body.fragments.find((f) => f.id === 'chat/persona')).toMatchObject({
      conditional: false,
      disabled: false,
      source: 'builtin',
    })
  })

  it('GET /fragment?id=... 返回片段与渲染文本', async () => {
    const res = await app.request('/fragment?id=retry/prompt-placeholder')
    expect(res.status).toBe(200)
    const body = await res.json() as { fragment: { id: string }; text: string }
    expect(body.fragment.id).toBe('retry/prompt-placeholder')
    expect(body.text).toBe('（继续）')

    const missing = await app.request('/fragment?id=nope')
    expect(missing.status).toBe(404)
    const missingBody = await missing.json() as { code: ErrCode; params?: { id?: string } }
    expect(missingBody.code).toBe(ErrCode.PROMPT_FRAGMENT_NOT_FOUND)
    expect(missingBody.params?.id).toBe('nope')
  })

  it('POST /preview 组装并逐段溯源；未知配方 404', async () => {
    const res = await app.request('/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: 'chat.system',
        context: { agentSystemPrompt: '人设A', thinkingMode: true, skills: [], unknown: 'drop' },
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { text: string; parts: Array<{ id: string }>; context: Record<string, unknown> }
    expect(body.text).toContain('人设A')
    expect(body.parts.map((p) => p.id)).toContain('chat/persona')
    expect(body.context).not.toHaveProperty('unknown')

    const bad = await app.request('/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'not/exists' }),
    })
    expect(bad.status).toBe(404)
    // 未知 target 保持 c.json 携带 targets 附加字段（候选清单）
    const badBody = await bad.json() as { code: ErrCode; targets: string[] }
    expect(badBody.code).toBe(ErrCode.NOT_FOUND)
    expect(badBody.targets).toContain('chat.system')
  })
})
