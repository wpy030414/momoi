// ============================================================
// probeUpstream 单元测试 —— 上游连通性探针
// ============================================================
//
// 探针契约：另起最小对话（无系统提示词、无历史、无工具），仅发送 "1"。
//   · 收到任何回复            → reachable: true（网关活着）
//   · 请求失败 / HTTP 错误 / 空手而归 → reachable: false（真的连不上）
//   · 已收到回复后流尾部异常   → 仍判 reachable: true（拿到过回复即算连通）
//
// 该判定用于 pi-adapter 的 agent_end：区分「网关不可达」与
// 「网关可达但掐断本请求」这两种 stopReason === 'error' 的同构形态。

import { describe, it, expect, vi, afterEach } from 'vitest'
import { probeUpstream } from '../src/ai/provider.js'
import type { AppConfig } from '@momoi/shared/types'

// ---- 测试脚手架：伪造 fetch 与 SSE Response ----

function makeConfig(endpoint: string): AppConfig {
  return {
    app_name: 'test',
    app_favicon: '',
    app_background: '',
    api_endpoint: endpoint,
    api_key: 'test-key',
    support_attachments: true,
    support_infinite_mode: true,
    allow_im_conversations: true,
    show_github: false,
    use_external_image_hosting: false,
    recommended_questions: [],
    followup_questions: [],
    oauth_providers: [],
  }
}

/** 构造一个可被 streamChatCompletion 消费的伪 SSE Response */
function sseResponse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder()
  let i = 0
  return {
    ok: status < 400,
    status,
    text: async () => chunks.join(''),
    body: {
      getReader: () => ({
        read: async () =>
          i < chunks.length
            ? { done: false, value: enc.encode(chunks[i++]) }
            : { done: true, value: undefined },
      }),
    },
  } as unknown as Response
}

/** 一条完整的成功 SSE 流：单个 token + [DONE] */
const OK_STREAM = [
  'data: {"choices":[{"delta":{"content":"1"}}]}\n\n',
  'data: [DONE]\n\n',
]

/** 空回复流：直接 [DONE]，无任何 token */
const EMPTY_STREAM = ['data: [DONE]\n\n']

function lastCallBody(): { model: string; messages: Array<{ role: string; content: unknown }>; tools?: unknown } {
  const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]
  const init = call[1] as RequestInit
  return JSON.parse(init.body as string)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('probeUpstream：请求形态（另起对话，只发 1）', () => {
  it('不携带系统提示词、历史与工具，仅一条 content 为 "1" 的 user 消息', async () => {
    const fetchMock = vi.fn(async () => sseResponse(OK_STREAM))
    vi.stubGlobal('fetch', fetchMock)

    const result = await probeUpstream(makeConfig('https://probe-shape.test/v1'), 'test-model')

    expect(result.reachable).toBe(true)
    const body = lastCallBody()
    expect(body.messages).toEqual([{ role: 'user', content: '1' }])
    expect(body.tools).toBeUndefined()
    // 请求打向 /chat/completions，鉴权头携带 api_key
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe('https://probe-shape.test/v1/chat/completions')
    const headers = (call[1] as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer test-key')
  })
})

describe('probeUpstream：可达判定', () => {
  it('收到回复 → reachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(OK_STREAM)))
    const result = await probeUpstream(makeConfig('https://probe-ok.test/v1'), 'm')
    expect(result.reachable).toBe(true)
    expect(result.detail).toBeUndefined()
  })

  it('thinking 内容也算回复 → reachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse(['data: {"choices":[{"delta":{"reasoning_content":"嗯"}}]}\n\n', 'data: [DONE]\n\n']),
    ))
    const result = await probeUpstream(makeConfig('https://probe-think.test/v1'), 'm')
    expect(result.reachable).toBe(true)
  })

  it('连接失败（fetch rejected）→ 不可达，detail 携带根因', async () => {
    const connErr = new Error('fetch failed') as Error & { cause?: unknown }
    connErr.cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 1.2.3.4:443', address: '1.2.3.4', port: 443 }
    vi.stubGlobal('fetch', vi.fn(async () => { throw connErr }))

    const result = await probeUpstream(makeConfig('https://probe-down.test/v1'), 'm')
    expect(result.reachable).toBe(false)
    expect(result.detail).toContain('ECONNREFUSED')
  })

  it('HTTP 500 → 不可达，detail 携带状态码', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(['internal error'], 500)))
    const result = await probeUpstream(makeConfig('https://probe-500.test/v1'), 'm')
    expect(result.reachable).toBe(false)
    expect(result.detail).toContain('API error 500')
  })

  it('流内 error 事件 → 不可达', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse(['data: {"error":{"message":"access denied"}}\n\n', 'data: [DONE]\n\n']),
    ))
    const result = await probeUpstream(makeConfig('https://probe-denied.test/v1'), 'm')
    expect(result.reachable).toBe(false)
    expect(result.detail).toContain('access denied')
  })

  it('连接成功但零内容 → 不可达，注明「未返回任何内容」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(EMPTY_STREAM)))
    const result = await probeUpstream(makeConfig('https://probe-empty.test/v1'), 'm')
    expect(result.reachable).toBe(false)
    expect(result.detail).toBe('上游连接成功但未返回任何内容')
  })

  it('已收到回复后流尾部中断（无 [DONE]）→ 仍判可达', async () => {
    // 先给一个 token，然后流直接 done：streamChatCompletion 会抛
    // "closed unexpectedly without [DONE]"——但回复已经拿到，连通性成立
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse(['data: {"choices":[{"delta":{"content":"1"}}]}\n\n']),
    ))
    const result = await probeUpstream(makeConfig('https://probe-cut.test/v1'), 'm')
    expect(result.reachable).toBe(true)
  })
})
