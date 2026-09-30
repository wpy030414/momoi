// ============================================================
// 会话累计用量口径（账单口径）——纯函数集中处
// ============================================================
//
// 「累计消耗」= 该会话内**每一次 LLM 调用**的（输入 + 输出）之和。agent 循环每一轮
// 都会把整个上下文重发一次，所以**重复投喂也计入**——这正是网关真正计费的口径。
//
// 真值来自上游 usage；上游不回 usage 时由 pi-adapter 按「每轮实际发送的上下文 +
// 每轮实际产出」字符估算（结构与真值一致，不混用：一轮都没拿到 usage 才走估算）。
//
// 本文件放两件纯函数（落库入口在 lib/stats-store.ts——那里才依赖 db）：
//   1. mergeCumulativeTotals —— 把本轮增量并入会话累计（含首次的历史回填与 ≈ 标记）
//   2. estimateHistoricalBill —— 存量会话的历史账单**粗估**（首次回填的起点）
//
// 为什么回填：累计值是该能力上线后才开始记录的，存量会话若从 0 起算会明显偏小。
// 回填只做一次（快照里没有 totalTokens 的那次生成），并让该会话的累计**永久**带 ≈
// ——估算进去了就不能再假装是精确值。

import { estimateTokens, estimateTokensOfParts, contentToEstimateParts } from './tokens.js'
import type { ChatMessage } from './provider.js'

/** 一次生成的账单增量（由 pi-adapter 产出） */
export interface BillContribution {
  /** 该次生成消耗的 token（输入 + 输出；含每轮重复投喂的上下文） */
  tokens: number
  /** true = 该值来自字符估算（上游整轮都没回 usage） */
  estimated: boolean
}

/** 会话累计（存于 conversations.stats 的 JSON） */
export interface CumulativeTotals {
  totalTokens: number
  totalEstimated: boolean
}

/**
 * 把本轮增量并入会话累计。
 *
 * @param prev  快照里已有的累计值（null/缺字段 = 该能力尚未记录过这个会话）
 * @param contribution 本轮生成的账单增量
 * @param seed  存量会话的历史账单粗估（见 estimateHistoricalBill）；**只在首次**采纳
 */
export function mergeCumulativeTotals(
  prev: CumulativeTotals | null | undefined,
  contribution: BillContribution,
  seed?: number,
): CumulativeTotals {
  const isFirst = !prev || typeof prev.totalTokens !== 'number'
  const base = isFirst ? (seed ?? 0) : prev.totalTokens
  return {
    totalTokens: base + contribution.tokens,
    // 三类估算都让标记置位且永不回退：历史回填、本轮估算、历史已带着估算
    totalEstimated: (prev?.totalEstimated ?? false) || (isFirst && !!seed) || contribution.estimated,
  }
}

/**
 * 从 `conversations.stats` 的 JSON 串里取出已有累计值。
 * 解析失败、字段缺失或该能力尚未记录过 → null（调用方据此走首次回填）。
 */
export function parseCumulativeTotals(raw: string | null | undefined): CumulativeTotals | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { totalTokens?: unknown; totalEstimated?: unknown }
    if (typeof parsed?.totalTokens !== 'number' || !Number.isFinite(parsed.totalTokens)) return null
    return { totalTokens: parsed.totalTokens, totalEstimated: parsed.totalEstimated === true }
  } catch {
    return null
  }
}

/**
 * 存量会话的历史账单粗估（首次回填的起点）。
 *
 * 口径与真值一致：每一次历史生成 ≈ 系统提示词 + 该次生成前的全部历史（重发一遍）
 * + 该次产出。逐条推进即可 O(n) 算完，无需为每次生成重新拼接整段历史。
 *
 * **已知偏差**（可接受——它只是回填起点，且该会话的累计从此永久带 ≈）：
 *   ① 全部为字符估算；
 *   ② history 不带 thinking，历史思考 token 未计入（偏小）；
 *   ③ 系统提示词取**当前**值（含日期、技能清单等易变部分），与历史当时未必一致；
 *   ④ 群聊按成员各自视角的历史估算，量级一致但非精确聚合。
 */
export function estimateHistoricalBill(history: ChatMessage[], systemPrompt: string): number {
  const systemTokens = estimateTokens(systemPrompt)
  let running = 0 // 截至目前的历史内容量 ≈ 下一次生成要重发的输入
  let bill = 0
  for (const m of history) {
    const parts: string[] = []
    contentToEstimateParts(m.content, parts)
    if (m.tool_calls) parts.push(JSON.stringify(m.tool_calls))
    const own = estimateTokensOfParts(parts)
    if (m.role === 'assistant') {
      bill += systemTokens + running // 该次生成的输入（整个上下文重发）
      bill += own // 该次生成的输出
    }
    running += own
  }
  return bill
}
