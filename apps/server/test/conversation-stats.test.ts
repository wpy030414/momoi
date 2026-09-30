// ============================================================
// 会话累计用量口径（账单口径）—— 纯函数测试
// ============================================================
//
// 契约（见 ai/conversation-stats.ts）：
//   · 累计 = Σ 每次 LLM 调用的（输入 + 输出），跨所有生成累加——含每轮重发的上下文；
//   · 首次落库（快照里还没有 totalTokens）时用历史粗估回填起点，并让该会话的累计
//     从此**永久**带 ≈；
//   · 估算标记只升不降：历史回填 / 本轮估算 / 历史上已带估算，任一发生即置位。
//
// 全部为纯函数，无 fetch / 无模块 mock。

import { describe, it, expect } from 'vitest'
import {
  mergeCumulativeTotals,
  parseCumulativeTotals,
  estimateHistoricalBill,
} from '../src/ai/conversation-stats.js'
import type { ChatMessage } from '../src/ai/provider.js'

// 400 个 ASCII 字符 = 100 token（1 token / 4 chars），便于手算
const ascii = (chars: number) => 'a'.repeat(chars)

describe('mergeCumulativeTotals：累计只增不减', () => {
  it('首次（无累计值）→ 采纳历史回填起点，并永久标记为含估算', () => {
    const out = mergeCumulativeTotals(null, { tokens: 100, estimated: false }, 5000)
    expect(out).toEqual({ totalTokens: 5100, totalEstimated: true })
  })

  it('首次且无回填（history 为空）→ 不因 seed=0 而误标估算', () => {
    const out = mergeCumulativeTotals(null, { tokens: 100, estimated: false }, 0)
    expect(out).toEqual({ totalTokens: 100, totalEstimated: false })
  })

  it('非首次 → 只累加，回填起点不再参与', () => {
    const out = mergeCumulativeTotals({ totalTokens: 800, totalEstimated: false }, { tokens: 200, estimated: false }, 9999)
    expect(out).toEqual({ totalTokens: 1000, totalEstimated: false })
  })

  it('估算标记只升不降：本轮走估算 → 置位', () => {
    const out = mergeCumulativeTotals({ totalTokens: 800, totalEstimated: false }, { tokens: 200, estimated: true })
    expect(out).toEqual({ totalTokens: 1000, totalEstimated: true })
  })

  it('估算标记只升不降：历史上已带估算 → 后续真值不清除标记', () => {
    const out = mergeCumulativeTotals({ totalTokens: 800, totalEstimated: true }, { tokens: 200, estimated: false })
    expect(out).toEqual({ totalTokens: 1000, totalEstimated: true })
  })
})

describe('parseCumulativeTotals：存量/脏数据一律按「尚未记录」处理', () => {
  it('null / 空 / 非法 JSON / 缺字段 / 非数字 → null', () => {
    expect(parseCumulativeTotals(null)).toBeNull()
    expect(parseCumulativeTotals(undefined)).toBeNull()
    expect(parseCumulativeTotals('')).toBeNull()
    expect(parseCumulativeTotals('不是 JSON')).toBeNull()
    expect(parseCumulativeTotals('{}')).toBeNull()
    expect(parseCumulativeTotals('{"totalTokens":"123"}')).toBeNull()
    expect(parseCumulativeTotals('{"totalTokens":null}')).toBeNull()
  })

  it('合法值 → 取出累计与估算标记', () => {
    expect(parseCumulativeTotals('{"totalTokens":123}')).toEqual({ totalTokens: 123, totalEstimated: false })
    expect(parseCumulativeTotals('{"totalTokens":123,"totalEstimated":true}')).toEqual({ totalTokens: 123, totalEstimated: true })
  })
})

describe('estimateHistoricalBill：历史账单粗估（回填起点）', () => {
  it('空历史 → 0（新会话没有可回填的部分）', () => {
    expect(estimateHistoricalBill([], ascii(400))).toBe(0)
  })

  it('只有用户消息（尚无生成）→ 0', () => {
    const history: ChatMessage[] = [{ role: 'user', content: ascii(400) }]
    expect(estimateHistoricalBill(history, ascii(400))).toBe(0)
  })

  it('一次历史生成 ≈ 系统提示词 + 生成前的全部历史（重发）+ 该次产出', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: ascii(400) },      // 100 token（该次生成的输入）
      { role: 'assistant', content: ascii(400) }, // 100 token（该次生成的输出）
    ]
    // 该次生成 = system 100 + running(用户消息) 100 + 自身产出 100 = 300
    expect(estimateHistoricalBill(history, ascii(400))).toBe(300)
  })

  it('多次生成：每次都要算上「重发全部历史」——这就是账单口径', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: ascii(400) },       // running: 0→100
      { role: 'assistant', content: ascii(400) },  // 生成1 = 100(system) + 100 + 100 = 300；running: 100→200
      { role: 'user', content: ascii(400) },       // running: 200→300
      { role: 'assistant', content: ascii(400) },  // 生成2 = 100 + 300 + 100 = 500；running: 300→400
    ]
    expect(estimateHistoricalBill(history, ascii(400))).toBe(800)
  })

  it('工具调用与工具结果计入上下文（tool_calls JSON 也算）', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', content: ascii(400), tool_call_id: 'c1' },
      { role: 'assistant', content: ascii(400) },
    ]
    const withoutToolCalls = estimateHistoricalBill(
      history.map((m) => (m.tool_calls ? { ...m, tool_calls: undefined } : m)),
      '',
    )
    expect(estimateHistoricalBill(history, '')).toBeGreaterThan(withoutToolCalls)
  })
})
