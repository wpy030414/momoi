/**
 * 把 OpenAI Chat Completions 的消息数组压平成豆包网页端可接受的一段文本，
 * 并提取**最后一条用户消息**里的图片 / 文件附件。
 *
 * 豆包 /chat/completion 每次接收一条用户消息（可带附件块），因此采用无状态
 * 策略：system / 历史轮次 / 工具结果全部编码进文本。附件只在当前用户消息上
 * 上传，历史消息中的附件以占位符保留，避免每轮重复上传。
 */

import type { RawAttachment } from './upload.js'

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
  attachments: RawAttachment[]
}

interface ContentParts {
  text: string
  attachments: RawAttachment[]
}

function parseDataUrl(url: string): { mime: string; base64: string } | null {
  if (!url.startsWith('data:')) return null
  const comma = url.indexOf(',')
  if (comma < 0) return null
  const meta = url.slice(5, comma)
  const data = url.slice(comma + 1)
  const parts = meta.split(';')
  const mime = (parts[0] || 'application/octet-stream').toLowerCase()
  const isBase64 = parts.slice(1).some((p) => p.trim().toLowerCase() === 'base64')
  if (isBase64) return { mime, base64: data }
  try {
    return { mime, base64: Buffer.from(decodeURIComponent(data), 'utf8').toString('base64') }
  } catch {
    return null
  }
}

function nameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    return decodeURIComponent(u.pathname.split('/').pop() || '')
  } catch {
    return ''
  }
}

function attachmentFromUrl(url: string, kind: 'image' | 'file', name: string): RawAttachment {
  const data = parseDataUrl(url)
  if (data) {
    const fallback = kind === 'image' ? `image.${data.mime.split('/')[1] || 'png'}` : 'file.bin'
    return { kind, name: name || fallback, mime: data.mime, source: { type: 'data', base64: data.base64 } }
  }
  if (/^https?:\/\//i.test(url)) {
    const fallback = kind === 'image' ? 'image.png' : 'file.bin'
    return { kind, name: name || nameFromUrl(url) || fallback, mime: '', source: { type: 'url', url } }
  }
  throw new UnsupportedMessageError(`不支持的附件地址：${url.slice(0, 80)}`)
}

function attachmentFromPart(part: any): RawAttachment | null {
  const type = String(part?.type || '')

  if (type === 'image_url' || type === 'input_image' || type === 'image') {
    const raw =
      typeof part.image_url === 'string'
        ? part.image_url
        : typeof part.image_url?.url === 'string'
          ? part.image_url.url
          : typeof part.url === 'string'
            ? part.url
            : ''
    if (raw) return attachmentFromUrl(raw, 'image', String(part.filename || part.name || ''))
    const source = part.source
    if (source?.type === 'base64' && typeof source.data === 'string') {
      const mime = String(source.media_type || part.mime_type || 'image/png')
      const ext = mime.split('/')[1] || 'png'
      return {
        kind: 'image',
        name: String(part.filename || part.name || `image.${ext}`),
        mime,
        source: { type: 'data', base64: source.data },
      }
    }
    if (source?.type === 'url' && typeof source.url === 'string') {
      return attachmentFromUrl(source.url, 'image', String(part.filename || part.name || ''))
    }
    throw new UnsupportedMessageError('图片输入缺少 image_url / source')
  }

  if (type === 'file' || type === 'input_file') {
    const fileObj = part.file && typeof part.file === 'object' ? part.file : part
    const name = String(part.filename || part.name || fileObj.filename || fileObj.name || '')
    const data = fileObj.file_data ?? fileObj.data ?? part.file_data ?? part.data
    if (typeof data === 'string' && data) {
      if (data.startsWith('data:')) {
        const parsed = parseDataUrl(data)
        if (!parsed) throw new UnsupportedMessageError('文件 file_data 不是合法的 data URL')
        return {
          kind: 'file',
          name: name || 'file.bin',
          mime: parsed.mime,
          source: { type: 'data', base64: parsed.base64 },
        }
      }
      return {
        kind: 'file',
        name: name || 'file.bin',
        mime: String(fileObj.mime_type || fileObj.mime || part.mime_type || part.mime || 'application/octet-stream'),
        source: { type: 'data', base64: data },
      }
    }
    if (fileObj.file_id || part.file_id) {
      throw new UnsupportedMessageError('不支持 file_id；请改用 file_data（base64 或 data URL）')
    }
    const url = fileObj.file_url || fileObj.url || part.file_url || part.url
    if (typeof url === 'string' && url) return attachmentFromUrl(url, 'file', name)
    throw new UnsupportedMessageError('文件输入缺少 file_data / file_url')
  }

  if (type === 'input_audio' || type === 'audio') {
    throw new UnsupportedMessageError('豆包网页通道暂不支持音频输入；图片与文件可用。')
  }

  return null
}

/**
 * 解析 content。current=true 时收集附件；历史消息中的附件只留占位符。
 */
function contentParts(content: unknown, current: boolean): ContentParts {
  if (typeof content === 'string') return { text: content, attachments: [] }
  if (Array.isArray(content)) {
    const texts: string[] = []
    const attachments: RawAttachment[] = []
    for (const part of content) {
      if (typeof part === 'string') {
        texts.push(part)
        continue
      }
      if (!part || typeof part !== 'object') continue
      const p = part as any
      if (p.type === 'text' || p.type === 'input_text') {
        if (typeof p.text === 'string') texts.push(p.text)
        continue
      }
      let attachment: RawAttachment | null = null
      try {
        attachment = attachmentFromPart(p)
      } catch (e) {
        if (!current && e instanceof UnsupportedMessageError) {
          texts.push('[不支持的附件]')
          continue
        }
        throw e
      }
      if (attachment) {
        if (current) attachments.push(attachment)
        else texts.push(attachment.kind === 'image' ? '[图片]' : `[文件：${attachment.name}]`)
        continue
      }
      if (typeof p.text === 'string') texts.push(p.text)
    }
    return { text: texts.join('\n'), attachments }
  }
  if (content && typeof content === 'object' && typeof (content as any).text === 'string') {
    return { text: (content as any).text, attachments: [] }
  }
  return { text: '', attachments: [] }
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

/**
 * 压平消息。附件只从最后一条 user 消息提取；空历史会抛错。
 */
export function flattenMessages(messages: unknown): FlattenedPrompt {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new UnsupportedMessageError('messages 不能为空')
  }
  const list = messages.filter((m) => m && typeof m === 'object') as any[]
  let lastUserIndex = -1
  for (let i = list.length - 1; i >= 0; i--) {
    if (String(list[i].role || '').toLowerCase() === 'user') {
      lastUserIndex = i
      break
    }
  }

  const systems: string[] = []
  const turns: Array<{ role: string; text: string }> = []
  let attachments: RawAttachment[] = []
  let currentHadText = false
  let currentHadAttachments = false
  let currentTurnCounted = false

  for (let index = 0; index < list.length; index++) {
    const msg = list[index]
    const role = String(msg.role || 'user').toLowerCase()
    const isCurrentUser = role === 'user' && index === lastUserIndex
    const parts = contentParts(msg.content, isCurrentUser)
    const text = parts.text.trim()

    if (isCurrentUser) {
      attachments = parts.attachments
      currentHadAttachments = attachments.length > 0
      currentHadText = Boolean(text)
      if (text || attachments.length > 0) currentTurnCounted = true
    }

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
  const hasCurrentAttachmentOnly = currentHadAttachments && !currentHadText
  if (turns.length === 0 && !system && attachments.length === 0) {
    throw new UnsupportedMessageError('messages 中没有可发送的文本或附件内容')
  }

  // 单条用户消息：保持原样，避免无意义的包装
  if (turns.length === 1 && turns[0].role === '用户' && !system && attachments.length === 0) {
    return { prompt: turns[0].text, system: '', turnCount: 1, attachments: [] }
  }
  if (turns.length === 1 && turns[0].role === '用户' && system && attachments.length === 0) {
    return { prompt: `${system}\n\n${turns[0].text}`, system, turnCount: 1, attachments: [] }
  }
  if (turns.length === 1 && turns[0].role === '用户' && attachments.length > 0) {
    return {
      prompt: system ? `${system}\n\n${turns[0].text}` : turns[0].text,
      system,
      turnCount: 1,
      attachments,
    }
  }
  if (attachments.length > 0 && turns.length === 0) {
    return { prompt: system, system, turnCount: currentTurnCounted ? 1 : 0, attachments }
  }
  // 只有 system 没有用户轮次：把它当作提问
  if (turns.length === 0) {
    return { prompt: system, system, turnCount: 0, attachments: [] }
  }

  const last = turns[turns.length - 1]
  const finalInstruction = hasCurrentAttachmentOnly
    ? '请根据附件内容作答。'
    : last.role === '助手'
      ? '请基于以上对话继续上一条助手回复。'
      : last.role.startsWith('工具结果')
        ? '请根据以上工具结果继续完成用户的任务。'
        : '请针对最后一条用户消息作答。'

  const body = turns.map((t) => `${t.role}：${t.text}`).join('\n\n')
  const prompt = `${system ? `系统指令：\n${system}\n\n` : ''}以下是对话记录：\n${body}\n\n${finalInstruction}`
  return { prompt, system, turnCount: turns.length + (hasCurrentAttachmentOnly ? 1 : 0), attachments }
}
