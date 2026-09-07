// ============================================================
// Neutral Agent — Generates follow-up questions for infinite mode
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

export async function generateNeutralFollowUp(
  config: AppConfig,
  agentModel: string,
  conversationContext: string,
): Promise<string | null> {
  try {
    const messages: ChatMessage[] = [
      { role: 'system', content: NEUTRAL_SYSTEM_PROMPT },
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