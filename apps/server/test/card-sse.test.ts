// ============================================================
// 卡片 SSE 事件与 trace 持久化 —— runPiAgentLoop 契约
// ============================================================
// 验证 pi-adapter tool_execution_end 的卡片捕获链路（D54 决策 B）：
//   1. ui_* 工具返回 data.card → 推 SSE card 事件
//   2. card 事件先于同一次工具调用的 tool_result
//   3. RunPiAgentLoopResult.trace 含 card 条目（id = 工具调用 id），
//      紧随对应 tool_call 条目之后，且 tool_call 状态照常回填 done
//   4. 校验失败（error 结果）不产生 card 事件
//   5. 一轮内多张卡片 → 多条 card 事件，各自入 trace
//
// 验证方式与 stats.test.ts 相同：伪造 fetch（脚本化 SSE 流）驱动**真实**
// runPiAgentLoop——Pi 循环、streamFn、事件发射器全部走真实代码；只有三个
// 外部边界（配置 / 工作区 / 工具注册表）以模块 mock 替换。工具注册表注入
// **真实**的 cardTools，使 ui_chart / ui_stat 走完整校验与产出链路。
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ServerMessage, TraceEntry } from '@momoi/shared/types'

const h = vi.hoisted(() => {
  const AGENT = {
    id: 'agent-card-1',
    name: '卡片测试猫',
    model: 'test-model',
    system_prompt: '你是测试用的人设。',
    avatar: '',
    standing_art: '',
    role: 'default' as const,
    created_at: 0,
    voice_enabled: false,
    voice_sample_url: '',
    voice_settings: '{}',
  }
  const CONFIG = {
    app_name: 'momoi-test',
    app_favicon: '',
    app_background: '',
    api_endpoint: 'https://cards-fake.test/v1',
    api_key: 'test-key',
    context_window: 128000,
    support_attachments: true,
    support_infinite_mode: true,
    allow_im_conversations: true,
    show_github: false,
    use_external_image_hosting: false,
    recommended_questions: [],
    followup_questions: [],
    oidc_providers: [],
  }
  return { AGENT, CONFIG }
})

vi.mock('../src/lib/config.js', () => ({
  getConfig: async () => h.CONFIG,
  getAgent: async (id: string) => (id === h.AGENT.id ? h.AGENT : undefined),
  listAgents: async () => [h.AGENT],
  getUserAgentMemories: async () => [],
}))

vi.mock('../src/tools/workspace.js', () => ({
  SandboxFS: { forConversation: async () => ({}) },
}))

// 工具注册表：注入真实 cardTools（走完整 schema 校验 + 产出链路）
vi.mock('../src/ai/tools.js', async () => {
  const { cardTools } = await import('../src/tools/ui-cards/card-tool.js')
  return { getAllTools: () => cardTools.map((t) => t.definition) }
})
vi.mock('../src/tools/registry.js', async () => {
  const { cardTools } = await import('../src/tools/ui-cards/card-tool.js')
  return {
    getToolDefinitions: () => cardTools.map((t) => t.definition),
    resolveTool: (name: string) => cardTools.find((t) => t.definition.name === name),
  }
})
vi.mock('../src/tools/mcp-client.js', () => ({
  getMcpTools: async () => [],
  callMcpTool: async () => ({ content: [] }),
}))

const { runPiAgentLoop } = await import('../src/ai/pi-adapter.js')

// ---- 伪造上游：脚本化 SSE 流（骨架与 stats.test.ts 一致） ----

function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder()
  let i = 0
  return {
    ok: true,
    status: 200,
    text: async () => chunks.join(''),
    body: {
      getReader: () => ({
        read: async () => {
          if (i >= chunks.length) return { done: true, value: undefined }
          await new Promise((r) => setTimeout(r, 4))
          return { done: false, value: enc.encode(chunks[i++]) }
        },
      }),
    },
  } as unknown as Response
}

const frame = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
const DONE = 'data: [DONE]\n\n'

/** 一轮工具调用：工具名 + 参数 */
function toolRound(name: string, args: string): string[] {
  return [
    frame({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: `call_${name}`, function: { name, arguments: args } }] },
        finish_reason: 'tool_calls',
      }],
    }),
    DONE,
  ]
}

/** 一轮纯文本 */
function textRound(text: string): string[] {
  return [
    frame({ choices: [{ delta: { content: text } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    DONE,
  ]
}

function scriptFetch(streams: string[][]) {
  let call = 0
  return vi.fn(async () => {
    const chunks = streams[call]
    if (!chunks) throw new Error(`上游被多调用了一次（脚本只备了 ${streams.length} 轮）`)
    call++
    return sseResponse(chunks)
  })
}

type CardEvent = Extract<ServerMessage, { type: 'card' }>
type ToolResultEvent = Extract<ServerMessage, { type: 'tool_result' }>
type ToolCallEntry = Extract<TraceEntry, { type: 'tool_call' }>
type CardEntry = Extract<TraceEntry, { type: 'card' }>

async function run(extra?: { uiCards?: boolean }): Promise<{ events: ServerMessage[]; result: Awaited<ReturnType<typeof runPiAgentLoop>> }> {
  const events: ServerMessage[] = []
  const result = await runPiAgentLoop({
    userMessage: '画张图',
    history: [],
    send: (m) => events.push(m),
    thinkingMode: true,
    conversationId: 'card-test-conv',
    userId: 'card-test-user',
    agentId: h.AGENT.id,
    ...extra,
  })
  return { events, result }
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('卡片捕获：SSE 事件', () => {
  it('合法卡片 → card 事件先于 tool_result，载荷完整', async () => {
    vi.stubGlobal('fetch', scriptFetch([
      toolRound('ui_chart', '{"type":"bar","title":"月度销量","series":[{"name":"销量","data":[1,2,3]}]}'),
      textRound('这就是柱状图。'),
    ]))
    const { events } = await run()

    const cardIdx = events.findIndex((e) => e.type === 'card')
    const resultIdx = events.findIndex((e) => e.type === 'tool_result')
    expect(cardIdx).toBeGreaterThan(-1)
    expect(resultIdx).toBeGreaterThan(-1)
    expect(cardIdx).toBeLessThan(resultIdx)

    const cardEv = events[cardIdx] as CardEvent
    expect(cardEv.id).toBe('call_ui_chart')
    expect(cardEv.card.component).toBe('chart')
    expect(cardEv.card.title).toBe('月度销量')
    expect((cardEv.card.props as { type: string }).type).toBe('bar')

    const resultEv = events[resultIdx] as ToolResultEvent
    expect(resultEv.id).toBe('call_ui_chart')
    expect(resultEv.summary).toContain('已渲染卡片：图表「月度销量」')
  })

  it('Pi 层校验失败（enum 违规）→ 不产生 card 事件，错误回传模型', async () => {
    vi.stubGlobal('fetch', scriptFetch([
      toolRound('ui_chart', '{"type":"scatter","series":[{"name":"A","data":[1]}]}'),
      textRound('抱歉，我重新画。'),
    ]))
    const { events, result } = await run()

    expect(events.some((e) => e.type === 'card')).toBe(false)
    const resultEv = events.find((e) => e.type === 'tool_result') as ToolResultEvent
    // Pi 的 TypeBox 校验先于 execute 拦截（报错文案来自 Pi，中英皆视为合法回传）
    expect(resultEv.summary).toMatch(/Validation failed|参数校验失败/)
    expect(result.trace.some((e) => e.type === 'card')).toBe(false)
  })

  it('语义校验失败（跨 series 一致性）→ execute 层的自修复错误', async () => {
    vi.stubGlobal('fetch', scriptFetch([
      toolRound('ui_chart', '{"type":"line","series":[{"name":"A","data":[1,2]},{"name":"B","data":[1]}]}'),
      textRound('稍等，我修正数据。'),
    ]))
    const { events, result } = await run()

    expect(events.some((e) => e.type === 'card')).toBe(false)
    const resultEv = events.find((e) => e.type === 'tool_result') as ToolResultEvent
    expect(resultEv.summary).toContain('长度必须一致')
    expect(resultEv.summary).toContain('重新调用 ui_chart')
    expect(result.trace.some((e) => e.type === 'card')).toBe(false)
  })

  it('一轮内多张卡片 → 多条 card 事件，各自独立', async () => {
    vi.stubGlobal('fetch', scriptFetch([
      [
        frame({
          choices: [{
            delta: {
              tool_calls: [
                { index: 0, id: 'call_c1', function: { name: 'ui_chart', arguments: '{"type":"line","series":[{"name":"A","data":[1,2]}]}' } },
                { index: 1, id: 'call_c2', function: { name: 'ui_stat', arguments: '{"items":[{"label":"营收","value":"128万"}]}' } },
              ],
            },
            finish_reason: 'tool_calls',
          }],
        }),
        DONE,
      ],
      textRound('两个视角都给你。'),
    ]))
    const { events, result } = await run()

    const cards = events.filter((e): e is CardEvent => e.type === 'card')
    expect(cards).toHaveLength(2)
    expect(new Set(cards.map((c) => c.id))).toEqual(new Set(['call_c1', 'call_c2']))
    expect(new Set(cards.map((c) => c.card.component))).toEqual(new Set(['chart', 'stat']))

    const traceCards = result.trace.filter((e): e is CardEntry => e.type === 'card')
    expect(traceCards).toHaveLength(2)
  })
})

describe('卡片捕获：trace 持久化', () => {
  it('card 条目紧随对应 tool_call 之后，tool_call 状态照常回填 done', async () => {
    vi.stubGlobal('fetch', scriptFetch([
      toolRound('ui_table', '{"columns":["名","数"],"rows":[["a","1"]]}'),
      textRound('表格在这。'),
    ]))
    const { result } = await run()

    const tcIdx = result.trace.findIndex((e) => e.type === 'tool_call' && e.id === 'call_ui_table')
    const cardIdx = result.trace.findIndex((e) => e.type === 'card' && e.id === 'call_ui_table')
    expect(tcIdx).toBeGreaterThan(-1)
    expect(cardIdx).toBe(tcIdx + 1)

    // 回填扫描必须跳过 card 条目命中正确的 tool_call（跨条目按 id 匹配）
    const tc = result.trace[tcIdx] as ToolCallEntry
    expect(tc.status).toBe('done')
    expect(tc.name).toBe('ui_table')

    const card = result.trace[cardIdx] as CardEntry
    expect(card.card.component).toBe('table')
  })

  it('工具执行失败的轮次 trace 中仍保留 tool_call 错误条目', async () => {
    vi.stubGlobal('fetch', scriptFetch([
      toolRound('ui_diagram', '{}'),
      textRound('流程图稍后再画。'),
    ]))
    const { result } = await run()
    const tc = result.trace.find((e) => e.type === 'tool_call' && e.id === 'call_ui_diagram') as ToolCallEntry
    expect(tc.status).toBe('error')
    expect(result.trace.some((e) => e.type === 'card')).toBe(false)
  })
})

describe('IM 渠道闸门（D56：uiCards: false）', () => {
  it('ui_* 工具被结构性剔除：模型即使调用也触发不了卡片', async () => {
    vi.stubGlobal('fetch', scriptFetch([
      toolRound('ui_chart', '{"type":"bar","series":[{"name":"A","data":[1]}]}'),
      textRound('我用文字说明。'),
    ]))
    const { events, result } = await run({ uiCards: false })

    // 工具不在工具表中 → 不可能产出卡片事件 / 卡片 trace 条目
    expect(events.some((e) => e.type === 'card')).toBe(false)
    expect(result.trace?.some((e) => e.type === 'card') ?? false).toBe(false)
    // 轮次正常完成（文本回复送达），失败只发生在这一次工具调用上
    expect(result.reply).toContain('文字')
  })

  it('缺省（网页版）行为不受影响：同一脚本触发卡片', async () => {
    vi.stubGlobal('fetch', scriptFetch([
      toolRound('ui_chart', '{"type":"bar","series":[{"name":"A","data":[1]}]}'),
      textRound('图在这。'),
    ]))
    const { events } = await run()
    expect(events.some((e) => e.type === 'card')).toBe(true)
  })
})
