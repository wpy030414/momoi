// ============================================================
// Neutral Agent — 无限模式追问 + 回复后追问建议
// ============================================================

import type { AppConfig } from '../../shared/types.js'
import { streamChatCompletion } from './provider.js'
import type { ChatMessage } from './provider.js'

const NEUTRAL_SYSTEM_PROMPT = `你是一个中立观察者。你的任务是根据对话上下文，以用户的口吻生成一个最自然的追问或动作。
规则：
- 追问要简短自然，一句话就够了
- 可以是一个问题、一个反问、或者一个带括号的动作描述
- 动作描述示例："（继续）"、"（耸了耸肩，无奈把手搭在对方头上）"、"（托腮思考了一会儿）"
- 也可以是一个确切的疑问句："那具体怎么操作呢？"、"你为什么这么认为？"
- 不要长篇大论，不要替用户做决定，不要输出任何前缀或解释
- 只输出追问内容本身
- 如果对话已经自然结束，输出"（继续）"即可`

const SUGGESTIONS_SYSTEM_PROMPT = `你是一个追问建议生成器。你的任务是根据对话上下文，以用户本人的口吻生成恰好 3 条后续追问建议。
规则：
- 每条建议必须是【用户本人会亲口打出来】的话：以用户的第一人称、口语化的口吻，像用户直接发一条消息那样，猜测用户看到最后一条回复后最可能追问的问题
- 3 条建议之间方向要有差异，覆盖不同的追问角度
- 每条一句话，简短自然，不要长篇大论
- 不要输出任何前缀、编号、解释或代码块标记，每行一条
- 正确示例（用户口吻）：
具体怎么操作？
再给我讲讲原理
有没有别的办法？
- 反面示例（助手对用户说话的口吻，禁止）：
你可以试试这个方案
要不要我帮你查一下？`

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
      { role: 'user', content: `以下是一段对话的上下文，请以用户的口吻生成一个最自然的追问：\n\n${conversationContext}\n\n追问：` },
    ]

    let followUp = ''
    for await (const event of streamChatCompletion(config, agentModel, messages, [], false)) {
      if (event.type === 'token' && event.text) {
        followUp += event.text
      }
    }

    const trimmed = followUp.trim()
    if (!trimmed) return null

    // Clean up quotes that some models add
    return trimmed.replace(/^["'「]|["'」]$/g, '').trim() || null
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
      { role: 'user', content: `以下是一段对话的上下文，请以用户本人的口吻生成 3 条追问建议（每行一条）：\n\n${conversationContext}\n\n建议：` },
    ]

    let raw = ''
    for await (const event of streamChatCompletion(config, agentModel, messages, [], false)) {
      if (event.type === 'token' && event.text) {
        raw += event.text
      }
    }

    // 行级解析：容忍模型自发的围栏/bullet/编号/包裹引号
    const seen = new Set<string>()
    const suggestions: string[] = []
    for (const line of raw.split('\n')) {
      const s = line
        .replace(/^```[a-z]*\s*/i, '')      // 防模型自发加围栏
        .replace(/^[\s\-*\d.]+/, '')        // 去 bullet/编号前缀
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