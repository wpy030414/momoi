import { describe, it, expect, vi, afterEach } from 'vitest'
import { streamChatCompletion } from '../provider.js'
import type { AppConfig } from '../../../shared/types.js'

function config(endpoint: string): AppConfig {
  return {
    app_name: 'test',
    app_favicon: '',
    app_background: '',
    api_endpoint: endpoint,
    api_key: 'test-key',
    support_attachments: false,
    show_github: false,
  }
}

const SSE_OK = 'data: {"choices":[{"delta":{"content":"喵"},"finish_reason":"stop"}]}\n\n'

function sseResponse(): Response {
  return new Response(SSE_OK, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

function unknownFieldResponse(): Response {
  return new Response(
    JSON.stringify({ code: 'UNKNOWN_FIELD', message: '未知请求字段：thinking_budget', data: { field: 'thinking_budget' } }),
    { status: 400, headers: { 'Content-Type': 'application/json' } },
  )
}

async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('streamChatCompletion — DashScope 专有字段的端点自适应', () => {
  it('严格端点拒绝 thinking_budget 时，去掉专有字段重发一次并正常返回', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return bodies.length === 1 ? unknownFieldResponse() : sseResponse()
    })
    vi.stubGlobal('fetch', fetchMock)

    const events = await collect(
      streamChatCompletion(config('https://strict.example/v1'), 'm', [{ role: 'user', content: 'hi' }], [], false),
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodies[0].thinking_budget).toBe(0)
    expect(bodies[0].enable_thinking).toBe(false)
    expect(bodies[1].thinking_budget).toBeUndefined()
    expect(bodies[1].enable_thinking).toBeUndefined()
    expect(events).toEqual([{ type: 'token', text: '喵' }, { type: 'finish', finishReason: 'stop' }])
  })

  it('同一端点被标记后，后续请求首次即不带专有字段', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return bodies.length === 1 ? unknownFieldResponse() : sseResponse()
    })
    vi.stubGlobal('fetch', fetchMock)
    const cfg = config('https://cached.example/v1')

    await collect(streamChatCompletion(cfg, 'm', [{ role: 'user', content: 'a' }], [], false))
    await collect(streamChatCompletion(cfg, 'm', [{ role: 'user', content: 'b' }], [], false))

    expect(fetchMock).toHaveBeenCalledTimes(3) // 1 次被拒 + 1 次重发 + 第 2 轮直接成功
    expect(bodies[2].thinking_budget).toBeUndefined()
    expect(bodies[2].enable_thinking).toBeUndefined()
  })

  it('接受专有字段的端点只请求一次，且思考关闭时带 thinking_budget', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string))
      return sseResponse()
    })
    vi.stubGlobal('fetch', fetchMock)

    await collect(streamChatCompletion(config('https://dashscope.example/v1'), 'm', [{ role: 'user', content: 'hi' }], [], false))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bodies[0].enable_thinking).toBe(false)
    expect(bodies[0].thinking_budget).toBe(0)
  })

  it('与专有字段无关的 400 直接抛出，不重发', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"context length exceeded"}', { status: 400 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      collect(streamChatCompletion(config('https://other.example/v1'), 'm', [{ role: 'user', content: 'hi' }], [], true)),
    ).rejects.toThrow(/API error 400/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
