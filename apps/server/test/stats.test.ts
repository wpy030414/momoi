// ============================================================
// 会话状态条统计 —— runPiAgentLoop 计数契约
// ============================================================
//
// 契约（见 @momoi/shared/types.ts 的 ConversationStats）：
//   · 耗时（durationMs）= 本轮生成墙钟——进入生成到出结果，含工具执行与重试。
//     状态条上显示的就是它；
//   · 轮（rounds）= **LLM 调用次数**——纯文本轮与工具轮都算，即 agent 循环每进入
//     新一轮（streamFn 被调用一次）计一轮。**不上 UI**，供诊断；
//   · 步（steps）  = **工具执行次数**（每次 tool_execution_start 计一步）。同样不上 UI
//     ——它与界面上的工具气泡数重合；
//   · tok/s 与 上下文（contextTokens / estimated）见下方各用例。
//
// 特别约束（空回复搬迁重试）：上一轮完全作废，从头计数——作废轮的轮/步/用量
// 一律不得并进最终统计，否则轮数偏大、tok/s 虚高、上下文取到作废值。
//
// 验证方式：伪造 fetch（脚本化 SSE 流）驱动**真实** runPiAgentLoop——Pi 循环、
// streamFn、事件发射器全部走真实代码；只有三个外部边界（配置 / 工作区 / 工具
// 注册表）以模块 mock 替换，使测试不依赖 .env、数据库与磁盘沙箱。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatMessage } from '../src/ai/provider.js'

const h = vi.hoisted(() => {
  const AGENT = {
    id: 'agent-stats-1',
    name: '统计测试猫',
    model: 'test-model',
    system_prompt: '你是测试用的人设。',
    avatar: '',
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
    api_endpoint: 'https://stats-fake.test/v1',
    api_key: 'test-key',
    context_window: 128000,
    support_attachments: true,
    support_infinite_mode: true,
    allow_im_conversations: true,
    show_github: false,
    use_external_image_hosting: false,
    recommended_questions: [],
    followup_questions: [],
    oauth_providers: [],
  }
  return { AGENT, CONFIG }
})

vi.mock('../src/lib/config.js', () => ({
  getConfig: async () => h.CONFIG,
  getAgent: async (id: string) => (id === h.AGENT.id ? h.AGENT : undefined),
  listAgents: async () => [h.AGENT],
  getUserAgentMemories: async () => [],
}))

// 沙箱：状态条统计不碰工作区，给个空壳即可（避免落盘 data/workspaces）
vi.mock('../src/tools/workspace.js', () => ({
  SandboxFS: { forConversation: async () => ({}) },
}))

// 工具注册表：留空——本测试只需工具**调用**被计数，不需要工具真的存在
// （agent 循环对每个 tool call 都先发 tool_execution_start）
vi.mock('../src/ai/tools.js', () => ({ getAllTools: () => [] }))
vi.mock('../src/tools/mcp-client.js', () => ({
  getMcpTools: async () => [],
  callMcpTool: async () => ({ content: [] }),
}))

const { runPiAgentLoop } = await import('../src/ai/pi-adapter.js')

// ---- 伪造上游：脚本化 SSE 流 ----

/** 构造一个可被 streamChatCompletion 消费的伪 SSE Response。
 *  每帧间隔 ~4ms：流式耗时（tok/s 的分母）有可测的非零值——瞬时流会算出 0。 */
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

/** 一轮纯文本：正文 + 流尾 usage */
function textRound(text: string, usage?: { prompt_tokens: number; completion_tokens: number }): string[] {
  return [
    frame({ choices: [{ delta: { content: text } }] }),
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }),
    DONE,
  ]
}

/** 同上一轮纯文本，但正文拆成多帧（拉长流式耗时——tok/s 的分母） */
function textRoundChunked(chunks: string[], usage?: { prompt_tokens: number; completion_tokens: number }): string[] {
  return [
    ...chunks.map((c) => frame({ choices: [{ delta: { content: c } }] })),
    frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }),
    DONE,
  ]
}

/** 一轮工具调用：工具名 + 参数 + 流尾 usage */
function toolRound(name: string, args: string, usage?: { prompt_tokens: number; completion_tokens: number }): string[] {
  return [
    frame({
      choices: [{
        delta: { tool_calls: [{ index: 0, id: `call_${name}`, function: { name, arguments: args } }] },
        finish_reason: 'tool_calls',
      }],
      usage,
    }),
    DONE,
  ]
}

/** 空回复轮：只有 finish，无任何正文（触发空回复搬迁重试） */
function emptyRound(usage?: { prompt_tokens: number; completion_tokens: number }): string[] {
  return [frame({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }), DONE]
}

/** 按调用顺序依次吐出脚本化流；超出脚本时抛错（暴露轮数多于预期） */
function scriptFetch(streams: string[][]) {
  let call = 0
  return vi.fn(async () => {
    const chunks = streams[call]
    if (!chunks) throw new Error(`上游被多调用了一次（脚本只备了 ${streams.length} 轮）`)
    call++
    return sseResponse(chunks)
  })
}

async function run(history: ChatMessage[] = []): Promise<Awaited<ReturnType<typeof runPiAgentLoop>>> {
  return runPiAgentLoop({
    userMessage: '你好',
    history,
    send: () => {},
    thinkingMode: true,
    conversationId: 'stats-test-conv',
    userId: 'stats-test-user',
    agentId: h.AGENT.id,
  })
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('会话状态条：轮（LLM 调用次数）', () => {
  it('单轮纯文本 → 1 轮 0 步', async () => {
    vi.stubGlobal('fetch', scriptFetch([textRound('你好呀', { prompt_tokens: 120, completion_tokens: 8 })]))
    const { stats } = await run()
    expect(stats.rounds).toBe(1)
    expect(stats.steps).toBe(0)
  })

  it('工具往返 → 工具轮 + 收尾轮 = 2 轮 1 步', async () => {
    vi.stubGlobal('fetch', scriptFetch([
      toolRound('read_file', '{"path":"a.txt"}', { prompt_tokens: 100, completion_tokens: 12 }),
      textRound('文件里写的是……', { prompt_tokens: 200, completion_tokens: 20 }),
    ]))
    const { stats } = await run()
    expect(stats.rounds).toBe(2)
    expect(stats.steps).toBe(1)
  })

  it('同一轮内多个工具调用 → 步按调用数累加，轮不重复计', async () => {
    vi.stubGlobal('fetch', scriptFetch([
      [
        frame({
          choices: [{
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
                { index: 1, id: 'call_b', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          }],
        }),
        DONE,
      ],
      textRound('两份都读完了', { prompt_tokens: 300, completion_tokens: 15 }),
    ]))
    const { stats } = await run()
    expect(stats.rounds).toBe(2)
    expect(stats.steps).toBe(2)
  })
})

describe('会话状态条：空回复搬迁重试', () => {
  it('重试轮数从头上计——作废轮不得并进来', async () => {
    // 第 1 轮空回复（带 usage）→ 搬迁重试；第 2 轮正常出文
    vi.stubGlobal('fetch', scriptFetch([
      emptyRound({ prompt_tokens: 100, completion_tokens: 5 }),
      textRound('重试后的正常回复', { prompt_tokens: 200, completion_tokens: 30 }),
    ]))
    const { stats } = await run()
    expect(stats.rounds).toBe(1)
    expect(stats.steps).toBe(0)
  })

  it('作废轮的 usage 一并作废——重试流不带 usage 时退回字符估算', async () => {
    vi.stubGlobal('fetch', scriptFetch([
      emptyRound({ prompt_tokens: 100, completion_tokens: 5 }),
      textRound('重试后的正常回复'), // 无 usage
    ]))
    const { stats } = await run()
    expect(stats.estimated).toBe(true)
    // 作废轮的 prompt 100 若残留，会得出 105 这种「有真值」的假象
    expect(stats.contextTokens).not.toBe(105)
  })
})

describe('会话状态条：上下文与 tok/s', () => {
  it('上游回 usage → 上下文取最后一轮 prompt+completion，estimated=false', async () => {
    vi.stubGlobal('fetch', scriptFetch([
      toolRound('read_file', '{"path":"a.txt"}', { prompt_tokens: 100, completion_tokens: 12 }),
      textRound('收尾', { prompt_tokens: 250, completion_tokens: 40 }),
    ]))
    const { stats } = await run()
    expect(stats.estimated).toBe(false)
    expect(stats.contextTokens).toBe(290)
    expect(stats.tokensPerSecond).toBeGreaterThan(0)
  })

  it('上游不回 usage → 退化字符估算，estimated=true', async () => {
    vi.stubGlobal('fetch', scriptFetch([textRound('你好呀')]))
    const { stats } = await run()
    expect(stats.estimated).toBe(true)
    expect(stats.contextTokens).toBeGreaterThan(0)
  })
})

describe('会话状态条：tok/s', () => {
  it('分母是纯流式时长——同一输出量下，流帧更多的更慢', async () => {
    const usage = { prompt_tokens: 100, completion_tokens: 40 }
    vi.stubGlobal('fetch', scriptFetch([textRoundChunked(['短'], usage)]))
    const short = (await run()).stats
    // 同样的正文拆成 8 帧：流式耗时约 8 倍，tok/s 相应下降
    vi.stubGlobal('fetch', scriptFetch([textRoundChunked(['长', '一', '点', '的', '输', '出', '内', '容'], usage)]))
    const long = (await run()).stats
    expect(short.tokensPerSecond).toBeGreaterThan(0)
    expect(long.tokensPerSecond).toBeGreaterThan(0)
    expect(short.tokensPerSecond).toBeGreaterThan(long.tokensPerSecond)
  })
})

describe('会话状态条：本轮耗时', () => {
  it('墙钟 ⊇ 各轮流式时段（工具执行、建连、重试都算在里面）', async () => {
    vi.stubGlobal('fetch', scriptFetch([
      toolRound('read_file', '{"path":"a.txt"}', { prompt_tokens: 100, completion_tokens: 12 }),
      textRound('收尾', { prompt_tokens: 250, completion_tokens: 40 }),
    ]))
    const { stats, genUsage } = await run()
    expect(stats.durationMs).toBeGreaterThan(0)
    expect(stats.durationMs!).toBeGreaterThanOrEqual(genUsage.streamMs)
  })

  it('流帧更多 → 耗时更长', async () => {
    const usage = { prompt_tokens: 100, completion_tokens: 40 }
    vi.stubGlobal('fetch', scriptFetch([textRoundChunked(['短'], usage)]))
    const short = (await run()).stats
    vi.stubGlobal('fetch', scriptFetch([
      textRoundChunked(['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'], usage),
    ]))
    const long = (await run()).stats
    expect(long.durationMs!).toBeGreaterThan(short.durationMs!)
  })
})

describe('会话状态条：账单增量（会话累计的输入侧）', () => {
  // 累计口径 = Σ 每次 LLM 调用的（输入 + 输出），含每轮重发的整个上下文。
  // 这里验证的是**本次生成**贡献了多少（并入会话累计由 conversation-stats 测试覆盖）。

  it('有 usage → Σ(输入+输出)：两轮的输入都算，不只是最后一轮', async () => {
    vi.stubGlobal('fetch', scriptFetch([
      toolRound('read_file', '{"path":"a.txt"}', { prompt_tokens: 100, completion_tokens: 12 }),
      textRound('收尾', { prompt_tokens: 250, completion_tokens: 40 }),
    ]))
    const { genUsage, stats } = await run()
    expect(genUsage.billEstimated).toBe(false)
    expect(genUsage.billTokens).toBe(402) // (100 + 250) 输入 + (12 + 40) 输出
    // 上下文占用只看最后一轮 → 账单必然大于「最后一轮的输入+输出」
    expect(genUsage.billTokens).toBeGreaterThan(250 + 40)
    expect(stats.contextTokens).toBe(290) // 上下文仍是最后一轮口径，两者不混
  })

  it('整轮无 usage → 走估算；多轮的账单把重发的上下文也算进去', async () => {
    vi.stubGlobal('fetch', scriptFetch([textRound('你好呀')]))
    const one = (await run()).genUsage
    vi.stubGlobal('fetch', scriptFetch([
      toolRound('read_file', '{"path":"a.txt"}'),
      textRound('依据文件内容回答……'),
    ]))
    const two = (await run()).genUsage
    expect(one.billEstimated).toBe(true)
    expect(one.billTokens).toBeGreaterThan(0)
    // 两轮 = 同一段上下文发了两遍 + 两轮产出 → 必然大于单轮
    expect(two.billTokens).toBeGreaterThan(one.billTokens)
  })

  it('空回复重试 → 作废轮的用量不进账单（hasUsage 不残留）', async () => {
    vi.stubGlobal('fetch', scriptFetch([
      emptyRound({ prompt_tokens: 100, completion_tokens: 5 }),
      textRound('重试后的正常回复'),
    ]))
    const { genUsage } = await run()
    // 作废轮带过 usage：若重置不彻底，hasUsage 会残留 true → 被误判成真值
    expect(genUsage.billEstimated).toBe(true)
    expect(genUsage.billTokens).not.toBe(105)
  })

  it('history 为空 → 回填起点 0（新会话没有历史可回填）', async () => {
    vi.stubGlobal('fetch', scriptFetch([textRound('你好呀', { prompt_tokens: 100, completion_tokens: 8 })]))
    const { genUsage } = await run()
    expect(genUsage.priorBillEstimate).toBe(0)
  })

  it('history 非空 → 回填起点 > 0，但**不进**本次生成的账单增量', async () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'a'.repeat(400) },
      { role: 'assistant', content: 'b'.repeat(400) },
    ]
    vi.stubGlobal('fetch', scriptFetch([textRound('继续', { prompt_tokens: 300, completion_tokens: 10 })]))
    const { genUsage } = await run(history)
    expect(genUsage.priorBillEstimate).toBeGreaterThan(0)
    // 回填起点由路由在**首次**落库时与增量合并（见 conversation-stats 测试）
    expect(genUsage.billTokens).toBe(310)
  })
})
