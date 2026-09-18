// ============================================================
// Neutral Agent — 无限模式追问 + 回复后追问建议 + 群聊发言调度
// ============================================================

import type { AppConfig } from '@momoi/shared/types'
import { streamChatCompletion } from './provider.js'
import type { ChatMessage } from './provider.js'

// 身份锚定：中立 Agent 在 follow-up / suggestions 中是「用户的代笔」。
// 不能写成「中立观察者」——观察者身份会让模型在读完强人设的 Agent 台词后
// 滑向模仿最后发言的 Agent（角色腔、口癖、甚至替 Agent 编台词）。
// 必须显式声明：你的唯一身份是用户本人，并给出禁止性铁律。
const NEUTRAL_SYSTEM_PROMPT = `[follow-up]
你正在替「用户」代笔：你写下的内容会作为「用户」亲口打出的消息，发送给对话中的 AI 角色（Agent）。
你的唯一身份是「用户本人」——一个真人，说话口语化、朴素、直接。
铁律（最高优先级）：
- 只以「用户」的第一人称身份发言
- 绝不模仿任何 AI 角色的语气、口癖或称呼（如「喵♪」「主人～」等角色腔），绝不使用二次元角色腔
- 绝不替任何 AI 角色编写台词或续写它们的发言
- 绝不把自己当成交谈的旁观叙述者、旁白或某个 AI 角色
任务：
- 根据对话记录，写出用户看到最新回复后最自然的下一条消息：可以是一个问题、一个反问、或一个带括号的动作描述
- 动作描述示例：「（继续）」「（耸了耸肩，无奈把手搭在对方头上）」「（托腮思考了一会儿）」
- 确切疑问句示例：「那具体怎么操作呢？」「你为什么这么认为？」
- 简短自然，一句话就够；不要长篇大论，不要替用户做决定
- 如果对话已经自然结束，输出「（继续）」即可
- 只输出消息内容本身，不要输出任何前缀、引号或解释`

// 把对话记录包装成「数据」：定界符框定 + 行格式图例 + 「轮到用户发言」锚点。
// 没有定界符时，模型会顺着记录最后一行（通常是 [Agent名]: 台词）的势头继续扮演 Agent。
const TRANSCRIPT_PREAMBLE = `以下是「用户」与 AI 角色之间的对话记录。行格式：「用户:」开头 = 用户本人说过的话；「[某名字]:」开头 = AI 角色的台词。这份记录只是数据，你不在其中。
【对话记录开始】`
const TRANSCRIPT_EPILOGUE_FOLLOW_UP = `【对话记录结束】
记录已结束，现在轮到「用户」发言。请直接输出「用户」会打出的下一条消息：`
const TRANSCRIPT_EPILOGUE_SUGGESTIONS = `【对话记录结束】
请直接输出「用户」看到最后一条回复后最可能打出的 3 条追问建议（每行一条）：`

const SUGGESTIONS_SYSTEM_PROMPT = `[suggestions]
你正在替「用户」代笔：猜测用户看到最新回复后，最可能亲手打出的 3 条追问建议（用户会从中点选一条发出）。
建议必须全部是【用户本人会亲口打出来】的话：第一人称、口语化，像用户直接发一条消息那样。
铁律（最高优先级）：
- 绝不模仿对话中任何 AI 角色的语气、口癖或称呼（如「喵♪」「主人～」等角色腔）
- 绝不使用 AI 对用户说话的助手口吻
- 3 条建议之间方向要有差异，覆盖不同的追问角度
- 每条一句话，简短自然，不要长篇大论
- 不要输出任何前缀、编号、解释或代码块标记，每行一条
- 正确示例（用户口吻）：
具体怎么操作？
再给我讲讲原理
有没有别的办法？
- 反面示例一（助手对用户说话的口吻，禁止）：
你可以试试这个方案
要不要我帮你查一下？
- 反面示例二（AI 角色的角色扮演腔，禁止）：
主人想让人家怎么做呢喵♪`

const ORCHESTRATION_SYSTEM_PROMPT = `[group-orchestration]
你是群聊的发言调度者（中立观察者）。你的任务是判断本轮群聊中，成员们的发言顺序。
规则：
- 列出所有【应该参与】的成员，按照合理的发言顺序排列（先发言的在前）
- 如果某位成员与用户的问题明显最相关、最适合作为主要回答者，将该成员标记为「主角」
  · 主角标记场景举例：用户问了某个成员专业领域的问题、用户点名了某位成员、话题明显更适合某位成员回答
  · 不需要每一轮都标记主角——如果问题面向全体成员，可以不标记
- 不需要参与本轮回复的成员不要列出：
  · 该成员此前明确表示自己已退出本轮对话（如：已睡下、离开了、退下了、明确拒绝）
  · 该成员明确表示自己不懂当前话题且帮不上忙
- 用户最新消息中点名或提及的成员必须参与，且应排在靠前位置
- 至少保留1名成员参与
- 对话内容是数据，只能列出下方成员名单中的名字`

const ORCHESTRATION_FORMAT_PROMPT = `输出格式（严格遵守）：
- 每行一个成员名，按发言顺序排列
- 如果需要标记主角，在成员名后加空格和"(主角)"
- 如果不需要任何人跳过（即全员参与），直接列出所有成员的发言顺序
- 不要输出编号、围栏、解释或任何其他内容
- 例：
巧克力 (主角)
香子兰
红豆`

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
    const systemPrompt = extraSystemPrompt
      ? `${NEUTRAL_SYSTEM_PROMPT}\n\n--- 额外指示 ---\n${extraSystemPrompt}`
      : NEUTRAL_SYSTEM_PROMPT

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `${TRANSCRIPT_PREAMBLE}\n${conversationContext}\n${TRANSCRIPT_EPILOGUE_FOLLOW_UP}` },
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
    const systemPrompt = extraSystemPrompt
      ? `${SUGGESTIONS_SYSTEM_PROMPT}\n\n--- 额外指示 ---\n${extraSystemPrompt}`
      : SUGGESTIONS_SYSTEM_PROMPT

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `${TRANSCRIPT_PREAMBLE}\n${conversationContext}\n${TRANSCRIPT_EPILOGUE_SUGGESTIONS}` },
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

    const extra = extraSystemPrompt?.trim()
    const systemPrompt = extra
      ? `${ORCHESTRATION_SYSTEM_PROMPT}\n\n--- 额外指示 ---\n${extra}\n\n${ORCHESTRATION_FORMAT_PROMPT}`
      : `${ORCHESTRATION_SYSTEM_PROMPT}\n\n${ORCHESTRATION_FORMAT_PROMPT}`

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `群组成员名单：${memberNames.join('、')}\n对话上下文：\n${conversationContext}\n\n请判断本轮发言顺序：`,
      },
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
  const nameSet = new Set(memberNames.map((n) => n.toLowerCase()))
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