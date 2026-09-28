// ============================================================
// Neutral Agent — 无限模式追问 + 回复后追问建议 + 群聊发言调度
// ============================================================
// 提示词文本全部托管在提示词规则引擎（prompts/fragments/neutral.ts）：
//   · neutral.followup.*      无限模式追问（替用户代笔）
//   · neutral.suggestions.*   回复后 3 条追问建议
//   · neutral.orchestration.* 群聊发言顺序裁决
// 本模块只负责：调组装 → 请求上游 → 解析输出（含容错清洗）。
//
// 身份锚定（为什么追问/建议都写成「用户的代笔」）：
// 不能把中立 Agent 写成「中立观察者」——观察者身份会让模型在读完强人设的
// Agent 台词后滑向模仿最后发言的 Agent（角色腔、口癖、甚至替 Agent 编台词）。
// 必须在提示词里显式声明：唯一身份是用户本人，并给出禁止性铁律。
// ============================================================

import type { AppConfig } from '@momoi/shared/types'
import { streamChatCompletion } from './provider.js'
import type { ChatMessage } from './provider.js'
import {
  buildFollowUpSystemPrompt,
  buildFollowUpUserMessage,
  buildSuggestionsSystemPrompt,
  buildSuggestionsUserMessage,
  buildOrchestrationSystemPrompt,
  buildOrchestrationUserMessage,
} from '../prompts/index.js'

export interface GroupSkipHint {
  name: string
  reason: string
}

/** 发言顺序编排结果：有序的参与者列表 + 可选主角标记 */
export interface SpeakerOrder {
  /** 所有应参与的成员，按发言顺序排列（Agent 名称） */
  order: string[]
  /** 主角（可选）——与用户问题最相关的成员 */
  protagonist?: string
}

const MAX_SKIP_LINES = 30
const MAX_SKIP_CHARS = 4000

export async function generateNeutralFollowUp(
  config: AppConfig,
  agentModel: string,
  conversationContext: string,
  extraSystemPrompt?: string,
): Promise<string | null> {
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: buildFollowUpSystemPrompt({ extra: extraSystemPrompt }) },
      { role: 'user', content: buildFollowUpUserMessage({ context: conversationContext }) },
    ]

    let followUp = ''
    for await (const event of streamChatCompletion(config, agentModel, messages, [], false)) {
      if (event.type === 'token' && event.text) {
        followUp += event.text
      }
    }

    const trimmed = followUp.trim()
    if (!trimmed) return null

    // Clean up: 防御性剥离「用户：」标签前缀与包裹引号（部分模型会复读行标签）
    return trimmed
      .replace(/^用户\s*[:：]\s*/, '')
      .replace(/^["'「]|["'」]$/g, '')
      .trim() || null
  } catch (err) {
    console.error('Neutral agent follow-up failed:', (err as Error).message)
    return null
  }
}

export async function generateNeutralSuggestions(
  config: AppConfig,
  agentModel: string,
  conversationContext: string,
  extraSystemPrompt?: string,
): Promise<string[] | null> {
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: buildSuggestionsSystemPrompt({ extra: extraSystemPrompt }) },
      { role: 'user', content: buildSuggestionsUserMessage({ context: conversationContext }) },
    ]

    let raw = ''
    for await (const event of streamChatCompletion(config, agentModel, messages, [], false)) {
      if (event.type === 'token' && event.text) {
        raw += event.text
      }
    }

    // 行级解析：容忍模型自发的围栏/bullet/编号/包裹引号/「用户：」标签前缀
    const seen = new Set<string>()
    const suggestions: string[] = []
    for (const line of raw.split('\n')) {
      const s = line
        .replace(/^```[a-z]*\s*/i, '')      // 防模型自发加围栏
        .replace(/^[\s\-*\d.]+/, '')        // 去 bullet/编号前缀
        .replace(/^用户\s*[:：]\s*/, '')     // 防复读「用户：」行标签
        .replace(/^["'「]|["'」]$/g, '')     // 去包裹引号
        .trim()
      if (!s || seen.has(s)) continue
      seen.add(s)
      suggestions.push(s)
      if (suggestions.length === 3) break
    }

    return suggestions.length > 0 ? suggestions : null
  } catch (err) {
    console.error('Neutral agent suggestions failed:', (err as Error).message)
    return null
  }
}

/**
 * 群聊发言调度：判断本轮成员发言顺序，并可选标记主角。
 * 返回 null = 判定失败（调用方应回退到 shuffle + 全员参与）。
 * 契约：本函数永不 reject（内部 try/catch 兜底），调用方可安全地放进 Promise.race。
 */
export async function decideGroupSpeakerOrder(
  config: AppConfig,
  agentModel: string,
  input: {
    conversationContext: string
    memberNames: string[]
    previousSkips?: GroupSkipHint[]
  },
  extraSystemPrompt?: string,
): Promise<SpeakerOrder | null> {
  try {
    const { conversationContext, memberNames } = input
    if (memberNames.length === 0) return null

    const messages: ChatMessage[] = [
      { role: 'system', content: buildOrchestrationSystemPrompt({ extra: extraSystemPrompt?.trim() }) },
      { role: 'user', content: buildOrchestrationUserMessage({ members: memberNames, context: conversationContext }) },
    ]

    let raw = ''
    for await (const event of streamChatCompletion(config, agentModel, messages, [], false)) {
      if (event.type === 'token' && event.text) {
        raw += event.text
      }
    }

    return parseSpeakerOrder(raw, memberNames)
  } catch (err) {
    console.error('Neutral agent orchestration failed:', (err as Error).message)
    return null
  }
}

/**
 * 解析编排输出：每行一个成员名，可选 `(主角)` 标记。
 * 容忍模型自发的编号 / bullet / 围栏 / 包裹引号。
 * 不在此名单中的成员默认不参与本轮回复（由调用方决定如何兜底）。
 */
function parseSpeakerOrder(raw: string, memberNames: string[]): SpeakerOrder | null {
  const order: string[] = []
  let protagonist: string | undefined
  const seen = new Set<string>()

  const lines = raw.slice(0, MAX_SKIP_CHARS).split('\n').slice(0, MAX_SKIP_LINES)

  for (const line of lines) {
    const cleaned = line
      .replace(/^```[a-z]*\s*/i, '')
      .replace(/^\s*(?:[-*]|\d+\s*[.、)）])\s*/, '')
      .replace(/^["'「『]|["'」』]$/g, '')
      .trim()
    if (!cleaned || cleaned === '无') continue

    // Check for protagonist tag: "巧克力 (主角)" or "巧克力（主角）"
    let name = cleaned
    let isProtagonist = false
    const protoMatch = name.match(/^(.+?)\s*[（(]主角[）)]\s*$/)
    if (protoMatch) {
      name = protoMatch[1].trim()
      isProtagonist = true
    }

    // Case-insensitive exact match against member names
    const key = name.toLowerCase()
    if (seen.has(key)) continue

    const matchedName = memberNames.find((n) => n.toLowerCase() === key)
    if (matchedName) {
      seen.add(key)
      order.push(matchedName)
      if (isProtagonist && !protagonist) {
        protagonist = matchedName
      }
    }
  }

  if (order.length === 0) return null
  return { order, protagonist }
}
