// ============================================================
// 上游模型目录门禁测试
// ============================================================
//
// 覆盖三件必须成立的事：
//   1. custom 上游走 GET {api_endpoint}/models，归一化 id / 展示名 / 供应商，
//      去重并过滤文生图模型；
//   2. 拉取失败不抛错，降级为空列表 + warning（Agent 表单仍可手动填写）；
//   3. workbuddy 未登录时不发起目录请求。
//
// DB 用 temp node:sqlite + mock db/index.js（与 workbuddy-token 测试同构）。

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import type { AppConfig } from '@momoi/shared/types'

const h = vi.hoisted(() => ({
  mod: {} as Record<string, unknown>,
}))

vi.mock('../src/db/index.js', () =>
  new Proxy(
    {},
    {
      get: (_t, prop: string) => h.mod[prop],
      has: (_t, prop: string) => prop in h.mod,
    },
  ),
)

// 配置在模块导入时读取环境变量——必须在动态 import 之前设置
process.env.WORKBUDDY_BASE_URL = 'https://workbuddy.test'

let dbPath = ''

beforeAll(async () => {
  dbPath = join(tmpdir(), `momoi_models_${Date.now()}_${Math.random().toString(36).slice(2)}.db`)
  const { initSqlite } = await import('../src/db/sqlite.js')
  const { db, schema } = await initSqlite(dbPath)
  Object.assign(h.mod, { db, ...schema })
})

afterAll(() => {
  try { rmSync(dbPath, { force: true }) } catch { /* Windows 句柄锁 */ }
})

const gateway = await import('../src/ai/models.js')
const store = await import('../src/ai/workbuddy/credentials.js')
const manager = await import('../src/ai/workbuddy/token-manager.js')

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    gateway_source: 'custom',
    api_endpoint: 'https://api.test/v1',
    api_key: 'sk-test',
    ...overrides,
  } as AppConfig
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    return handler(String(input), init)
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(async () => {
  await manager.logout()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('custom — OpenAI 兼容端点模型列表', () => {
  it('归一化 id / 展示名 / 供应商，去重并过滤文生图', async () => {
    const fetchMock = stubFetch(async () =>
      new Response(JSON.stringify({
        data: [
          { id: 'gpt-4o', owned_by: 'openai', name: 'GPT-4o' },
          { id: 'gpt-4o', owned_by: 'openai' },
          { id: 'dall-e-9', tags: ['text-to-image'] },
          ' deepseek-v4 ',
        ],
      }), { headers: { 'Content-Type': 'application/json' } }),
    )

    const result = await gateway.listGatewayModels(config())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.test/v1/models')
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test')
    expect(result.source).toBe('custom')
    expect(result.warning).toBeUndefined()
    expect(result.models).toEqual([
      { id: 'gpt-4o', name: 'GPT-4o', vendor: 'openai' },
      { id: 'deepseek-v4', name: undefined, vendor: undefined },
    ])
  })

  it('空 API 密钥时不带 Authorization 头', async () => {
    const fetchMock = stubFetch(async () =>
      new Response(JSON.stringify({ data: [{ id: 'llama3' }] }), { headers: { 'Content-Type': 'application/json' } }),
    )

    await gateway.listGatewayModels(config({ api_key: '' }))

    const [, init] = fetchMock.mock.calls[0]
    expect((init?.headers as Record<string, string>)['Authorization']).toBeUndefined()
  })

  it('上游失败时降级为空列表 + warning，不抛错', async () => {
    stubFetch(async () => new Response('boom', { status: 500 }))

    const result = await gateway.listGatewayModels(config())

    expect(result).toMatchObject({ source: 'custom', models: [], warning: 'upstream_error' })
    expect(result.detail).toContain('HTTP 500')
  })

  it('响应缺少 data / models 时按异常降级', async () => {
    stubFetch(async () =>
      new Response(JSON.stringify({ foo: [] }), { headers: { 'Content-Type': 'application/json' } }),
    )

    const result = await gateway.listGatewayModels(config())

    expect(result.models).toEqual([])
    expect(result.warning).toBe('upstream_error')
    expect(result.detail).toContain('data 缺失')
  })
})

describe('workbuddy — 云端模型目录', () => {
  it('未登录时不请求目录，直接给出 not_logged_in 提示', async () => {
    const fetchMock = stubFetch(async () => new Response('{}'))

    const result = await gateway.listGatewayModels(config({ gateway_source: 'workbuddy' }))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toEqual({ source: 'workbuddy', models: [], warning: 'not_logged_in' })
  })

  it('已登录时携带身份头拉取目录，并过滤文生图 / 去重', async () => {
    await store.writeCredential({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      uid: 'u-1',
      domain: 'www.workbuddy.cn',
      nickname: '训练员',
      expiresAt: Date.now() + 3600_000,
      refreshExpiresAt: Date.now() + 30 * 24 * 3600_000,
      savedAt: Date.now(),
    })

    const fetchMock = stubFetch(async () =>
      new Response(JSON.stringify({
        data: {
          models: [
            { id: 'glm-5.3', name: 'GLM-5.3', vendor: 'GLM' },
            { id: 'glm-5.3', name: 'GLM-5.3' },
            { id: 'text-image', name: '文生图', tags: ['text-to-image'] },
            { id: 'deepseek-v4-pro' },
          ],
        },
      }), { headers: { 'Content-Type': 'application/json' } }),
    )

    const result = await gateway.listGatewayModels(config({ gateway_source: 'workbuddy' }))

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://workbuddy.test/v2/enterprises/personal/models')
    const headers = init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer access-1')
    expect(headers['X-IDE-Type']).toBe('WorkBuddy')
    expect(headers['Accept']).toBe('application/json')
    // 目录请求不应带对话链路头
    expect(headers['X-Conversation-ID']).toBeUndefined()

    expect(result.warning).toBeUndefined()
    expect(result.models).toEqual([
      { id: 'glm-5.3', name: 'GLM-5.3', vendor: 'GLM' },
      { id: 'deepseek-v4-pro', name: undefined, vendor: undefined },
    ])
  })

  it('目录拉取失败时降级为 upstream_error', async () => {
    await store.writeCredential({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      uid: 'u-1',
      domain: 'www.workbuddy.cn',
      expiresAt: Date.now() + 3600_000,
      refreshExpiresAt: Date.now() + 30 * 24 * 3600_000,
      savedAt: Date.now(),
    })
    stubFetch(async () => new Response('nope', { status: 502 }))

    const result = await gateway.listGatewayModels(config({ gateway_source: 'workbuddy' }))

    expect(result.models).toEqual([])
    expect(result.warning).toBe('upstream_error')
    expect(result.detail).toContain('HTTP 502')
  })
})
