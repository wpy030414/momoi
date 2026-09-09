import type { AppConfig } from '../../shared/types.js'
import type { ToolDefinition } from '../../shared/types.js'

// Multimodal content parts (OpenAI-compatible)
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | ContentPart[] | null
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
  /** 群聊：该消息由哪个 Agent 产生（用于上下文身份还原） */
  agent_id?: string | null
}

export interface StreamEvent {
  type: 'token' | 'thinking' | 'tool_call' | 'finish'
  text?: string
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  finishReason?: string
}

interface PendingToolCall {
  id: string
  index: number
  name: string
  arguments: string
}

// `enable_thinking` / `thinking_budget` 是 DashScope 专有字段，不在 OpenAI 规范内。
// 严格实现的端点会以 400 UNKNOWN_FIELD 拒绝整个请求；一旦某端点这样拒绝，
// 就记住它，后续请求不再携带这两个字段（思考内容仍经 delta.reasoning_content 透传）。
const endpointsWithoutThinkingParams = new Set<string>()

function isUnsupportedThinkingField(status: number, text: string): boolean {
  return (
    status === 400 &&
    /(UNKNOWN_FIELD|unknown (request )?field|未知请求字段)/i.test(text) &&
    /(enable_thinking|thinking_budget)/i.test(text)
  )
}

function buildRequestBody(
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  thinkingMode: boolean,
  includeThinkingParams: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    max_tokens: 100000,
  }

  if (includeThinkingParams) {
    body.enable_thinking = thinkingMode
    if (!thinkingMode) {
      body.thinking_budget = 0
    }
  }

  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }))
  }

  return body
}

export async function* streamChatCompletion(
  config: AppConfig,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  thinkingMode = true,
): AsyncGenerator<StreamEvent> {
  const endpoint = config.api_endpoint.replace(/\/$/, '')
  const url = `${endpoint}/chat/completions`
  const includeThinkingParams = !endpointsWithoutThinkingParams.has(endpoint)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 120_000)

  const post = async (includeParams: boolean): Promise<Response> => {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.api_key}`,
        },
        body: JSON.stringify(buildRequestBody(model, messages, tools, thinkingMode, includeParams)),
        signal: controller.signal,
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error('API request timed out after 120s')
      }
      throw err
    }
  }

  let response: Response
  try {
    response = await post(includeThinkingParams)

    // 端点拒绝 DashScope 专有字段时：记住该端点并原样重发一次（去掉这两个字段）。
    if (!response.ok && includeThinkingParams && response.status === 400) {
      const text = await response.text()
      if (!isUnsupportedThinkingField(response.status, text)) {
        throw new Error(`API error ${response.status}: ${text}`)
      }
      endpointsWithoutThinkingParams.add(endpoint)
      response = await post(false)
    }
  } finally {
    clearTimeout(timeoutId)
  }

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`API error ${response.status}: ${text}`)
  }

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const pendingToolCalls = new Map<number, PendingToolCall>()
  let receivedDone = false
  let receivedFinish = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      if (!receivedDone && !receivedFinish) {
        throw new Error('Upstream API stream closed unexpectedly without [DONE] signal')
      }
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith('data: ')) continue
      const data = trimmed.slice(6)
      if (data === '[DONE]') {
        receivedDone = true
        return
      }

      try {
        const json = JSON.parse(data)
        const choice = json.choices?.[0]
        if (!choice) continue

        const delta = choice.delta || {}
        const finishReason = choice.finish_reason

        // Stream text content
        if (delta.content) {
          yield { type: 'token', text: delta.content }
        }

        // Stream reasoning/thinking content (only when thinking is enabled)
        if (thinkingMode && delta.reasoning_content) {
          yield { type: 'thinking', text: delta.reasoning_content }
        }

        // Accumulate tool calls
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            if (!pendingToolCalls.has(idx)) {
              pendingToolCalls.set(idx, {
                id: tc.id || '',
                index: idx,
                name: tc.function?.name || '',
                arguments: '',
              })
            }
            const pending = pendingToolCalls.get(idx)!
            if (tc.id) pending.id = tc.id
            if (tc.function?.name) pending.name = tc.function.name
            if (tc.function?.arguments) pending.arguments += tc.function.arguments
          }
        }

        // Emit finish
        if (finishReason) {
          receivedFinish = true
          if (pendingToolCalls.size > 0) {
            const calls = [...pendingToolCalls.values()]
              .sort((a, b) => a.index - b.index)
              .map((c) => ({ id: c.id, name: c.name, arguments: c.arguments }))
            yield { type: 'tool_call', toolCalls: calls, finishReason }
          } else {
            yield { type: 'finish', finishReason }
          }
          return
        }
      } catch {
        // Skip malformed JSON lines
      }
    }
  }
}
