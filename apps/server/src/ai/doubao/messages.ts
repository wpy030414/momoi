/**
 * 把 OpenAI Chat Completions 的消息数组压平成豆包网页端可接受的一段文本。
 *
 * 豆包 /chat/completion 每次只接收一条用户消息（并创建新会话），
 * 因此采用无状态策略：把 system / 历史轮次 / 工具结果全部编码进一条消息。
 * 客户端每次带上完整 history 即可获得连贯的多轮效果。
 *
 * 与参考实现一致：豆包网页通道只支持文本；图片 / 音频 / 文件输入会给出
 * 明确的不支持提示。
 */

export class UnsupportedMessageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedMessageError'
  }
}

export interface FlattenedPrompt {
  prompt: string
  system: string
  turnCount: number
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part)
        continue
      }
      if (!part || typeof part !== 'object') continue
      const p = part as Record<string, unknown>
      if (p.type === 'text' || p.type === 'input_text') {
        if (typeof p.text === 'string') parts.push(p.text)
        continue
      }
      if (p.type === 'image_url' || p.type === 'image' || p.type === 'input_image') {
        throw new UnsupportedMessageError('豆包网页通道当前只支持文本消息；请移除图片输入。')
      }
      if (p.type === 'input_audio' || p.type === 'audio' || p.type === 'file') {
        throw new UnsupportedMessageError(`豆包网页通道当前只支持文本消息；不支持 ${p.type} 输入。`)
      }
      if (typeof p.text === 'string') parts.push(p.text)
    }
    return parts.join('\n')
  }
  if (content && typeof content === 'object' && typeof (content as { text?: unknown }).text === 'string') {
    return (content as { text: string }).text
  }
  return ''
}

function toolCallsText(toolCalls: unknown): string {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return ''
  const lines = toolCalls.map((tc: unknown) => {
    const call = tc as { function?: { name?: string; arguments?: unknown }; name?: string; arguments?: unknown }
    const name = call?.function?.name || call?.name || 'unknown'
    const args = call?.function?.arguments ?? call?.arguments ?? ''
    return `[调用工具 ${name}] ${typeof args === 'string' ? args : JSON.stringify(args)}`
  })
  return lines.join('\n')
}

/** 压平消息。空历史会抛错；图片/音频输入会给出明确的不支持提示。 */
export function flattenMessages(messages: unknown): FlattenedPrompt {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new UnsupportedMessageError('messages 不能为空')
  }
  const systems: string[] = []
  const turns: Array<{ role: string; text: string }> = []

  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue
    const msg = raw as Record<string, unknown>
    const role = String(msg.role || 'user').toLowerCase()
    const text = textFromContent(msg.content).trim()

    if (role === 'system' || role === 'developer') {
      if (text) systems.push(text)
      continue
    }
    if (role === 'tool' || role === 'function') {
      const name = typeof msg.name === 'string' ? msg.name : ''
      const label = name ? `工具结果（${name}）` : '工具结果'
      if (text) turns.push({ role: label, text })
      continue
    }
    if (role === 'assistant') {
      const calls = toolCallsText(msg.tool_calls)
      const combined = [text, calls].filter(Boolean).join('\n')
      if (combined) turns.push({ role: '助手', text: combined })
      continue
    }
    if (role === 'user') {
      if (text) turns.push({ role: '用户', text })
      continue
    }
    if (text) turns.push({ role: role.toUpperCase(), text })
  }

  const system = systems.join('\n\n').trim()
  if (turns.length === 0 && !system) {
    throw new UnsupportedMessageError('messages 中没有可发送的文本内容')
  }

  // 单条用户消息：保持原样，避免无意义的包装
  if (turns.length === 1 && turns[0].role === '用户' && !system) {
    return { prompt: turns[0].text, system: '', turnCount: 1 }
  }
  if (turns.length === 1 && turns[0].role === '用户' && system) {
    return { prompt: `${system}\n\n${turns[0].text}`, system, turnCount: 1 }
  }
  // 只有 system 没有用户轮次：把它当作提问
  if (turns.length === 0) {
    return { prompt: system, system, turnCount: 0 }
  }

  const last = turns[turns.length - 1]
  const finalInstruction =
    last.role === '助手'
      ? '请基于以上对话继续上一条助手回复。'
      : last.role.startsWith('工具结果')
        ? '请根据以上工具结果继续完成用户的任务。'
        : '请针对最后一条用户消息作答。'

  const body = turns.map((t) => `${t.role}：${t.text}`).join('\n\n')
  const prompt = `${system ? `系统指令：\n${system}\n\n` : ''}以下是对话记录：\n${body}\n\n${finalInstruction}`
  return { prompt, system, turnCount: turns.length }
}
