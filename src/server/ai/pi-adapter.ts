// ============================================================
// Pi Adapter — Bridges pi-agent-core to Momoi
// ============================================================
//
// 职责：
// 1. 将 ToolModule 包装为 Pi 的 AgentTool
// 2. 包装 provider.ts 为 Pi 的 StreamFn
// 3. 将 Pi 的 AgentEvent 映射为 SSE ServerMessage
// 4. 构建增强版系统提示词（含从代码补丁翻译的硬性规则）
// 5. 提供 runPiAgentLoop 入口函数
//
// ============================================================

import { runAgentLoop } from '@earendil-works/pi-agent-core'
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  StreamFn,
} from '@earendil-works/pi-agent-core'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type {
  AssistantMessage,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  Usage,
} from '@earendil-works/pi-ai'
import { Type } from '@sinclair/typebox'
import type { TSchema } from '@sinclair/typebox'

import type { AppConfig, ServerMessage, ToolDefinition } from '../../shared/types.js'
import {
  SUGGESTIONS_FENCE,
  THINKING_SEGMENT_OPEN,
  THINKING_SEGMENT_CLOSE,
  DEFAULT_SYSTEM_PROMPT,
	NEUTRAL_AGENT_ID,
} from '../../shared/constants.js'
import { getConfig, getAgent, listAgents } from '../config.js'
import { getAllTools } from './tools.js'
import { resolveTool } from '../tools/registry.js'
import { getMcpTools, callMcpTool } from '../tools/mcp-client.js'
import type { ToolContext, ToolResult, ToolArtifact } from '../tools/types.js'
import type { MentionSignal } from '../tools/group-mention-tool.js'
import { createMentionTool } from '../tools/group-mention-tool.js'
import { SandboxFS } from '../tools/workspace.js'
import { skillRegistry } from '../skills/registry.js'
import { streamChatCompletion } from './provider.js'
import type { ChatMessage, ContentPart } from './provider.js'

type SendFn = (msg: ServerMessage) => void

// ---- 零值 Usage（不追踪 token 用量时使用）----
const ZERO_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

// ---- 构建系统提示词（从 loop.ts 迁移，强化）----
function buildSystemPrompt(agentSystemPrompt: string, thinkingMode: boolean, isGroup: boolean = false, infiniteMode: boolean = false, agentName?: string, groupAgentNames?: string[], mentionedBy?: string | null): string {
  let prompt = agentSystemPrompt || DEFAULT_SYSTEM_PROMPT

  // Append skill descriptions only
  const skills = skillRegistry.getAll()
  if (skills.length > 0) {
    prompt += '\n\n## Available Skills\n'
    prompt += '以下是已安装的技能摘要。技能库可能不完整：如果用户的请求没有与某个技能描述明显匹配，请直接如实告知用户当前技能库中是否有可用技能，不要强行加载技能试探。如需查看某个技能的完整内容，请调用 load_skill 工具。\n'
    for (const skill of skills) {
      prompt += `\n- **${skill.manifest.name}**: ${skill.manifest.description}\n`
    }
  }

  if (!thinkingMode) {
    prompt += '\n\n/no_think\n请直接回答问题，不要输出任何思考过程或推理步骤。'
  }

  prompt += `
现在的日期时间是${new Date().toLocaleString()}。
`

  if (infiniteMode) {
    // 无限演算模式：追问由中立 Agent 接管，不生成 suggestions
    prompt += `
## 无限演算模式
你正处于无限演算模式中。在此模式下：
- 你只需要自然地回复用户，像在聊天一样——可以很简短，也可以很详细
- 回复完毕后，会有一位中立观察者根据上下文自动生成追问
- 你可以像真人聊天一样使用括号动作描述，如（笑了笑）、（托腮思考）
- 保持对话自然流畅，不要每轮都长篇大论
`
  }

  if (isGroup) {
    const names = groupAgentNames && groupAgentNames.length > 0 ? groupAgentNames : []
    const count = names.length
    const identityLine = agentName
      ? `当前群组有 1 个用户和 ${count} 个 Agent：${names.join('、')}，你是其中的 Agent：${agentName}。`
      : ''

    prompt += `
## 群组对话规则
你正在参与一个群组对话，${identityLine ? `${identityLine}` : ''}其他 Agent 也可能回复用户。请遵守：
- 对话历史中所有以 \`[Agent名字]: \` 开头的消息，都是【其他 Agent】或你之前的发言记录，不是用户说的。
- 不要复述、引用或延续其他 Agent 已经说过的内容，也不要假装那些话是你说的。
- 根据用户的最新消息，用你自己的人设独立、自然地回答。即使其他 Agent 已经回答过同样的问题，你也只需给出你自己视角的观点，不要重复对方的措辞。
- 群聊中鼓励你自然地 @ 其他 Agent 进行互动——点名、邀请讨论、调侃、吐槽都可以，就像真实群聊一样。可以一次 @ 多个人。
- 当你决定 @ 某人时，请在你的回复文本中**自然地写出 @对方名字**（如 "@巧克力 @香子兰 你们也来说说看！"），同时调用 at_mention 工具传递点名信号。
- 被 @ 的 Agent 会在本轮内优先回复，但其他 Agent 仍然会照常发言，不会被打断。
- 不要 @ 你自己。
- 适度使用 @ 功能，让它成为你群聊互动的自然习惯，而不是只在需要专业知识时才呼叫。
${mentionedBy ? `- 刚才 ${mentionedBy} @ 了你，在回复时请自然回应对方的点名，但不必为此改变你的回复优先级或内容。\n` : ''}`
  }

  return prompt
}

// ---- JSON Schema 属性 → TypeBox schema ----
function jsonSchemaToTypeBox(properties: Record<string, { type: string; description?: string; items?: { type: string } }>, required: string[] = []): TSchema {
  const obj: Record<string, TSchema> = {}
  for (const [key, prop] of Object.entries(properties)) {
    const desc = prop.description
    switch (prop.type) {
      case 'string': obj[key] = desc ? Type.String({ description: desc }) : Type.String(); break
      case 'number': obj[key] = desc ? Type.Number({ description: desc }) : Type.Number(); break
      case 'boolean': obj[key] = desc ? Type.Boolean({ description: desc }) : Type.Boolean(); break
      case 'array': {
        const itemType = prop.items?.type === 'string' ? Type.String() : Type.Any()
        obj[key] = desc ? Type.Array(itemType, { description: desc }) : Type.Array(itemType)
        break
      }
      default: obj[key] = desc ? Type.Any({ description: desc }) : Type.Any(); break
    }
  }
  // TypeBox 的 Optional 不支持在 Object 上直接标记，用 Partial + Required 组合
  // 简化处理：所有字段都标记，Pi 自己会校验 required
  return Type.Object(obj)
}

// ---- ToolModule → Pi AgentTool ----
async function createToolAdapter(toolCtx: ToolContext): Promise<AgentTool[]> {
  const defs = getAllTools()
  const tools = defs.map((def) => {
    const toolModule = resolveTool(def.name)
    const schema = jsonSchemaToTypeBox(def.input_schema.properties || {}, def.input_schema.required || [])

    const tool: AgentTool = {
      name: def.name,
      label: def.name,
      description: def.description,
      parameters: schema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<any>> => {
        const input = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
        if (!toolModule) {
          return {
            content: [{ type: 'text', text: `Unknown tool: ${def.name}` }],
            details: { error: true },
          }
        }

        const ctx: ToolContext = { ...toolCtx, signal: signal || toolCtx.signal }
        let result: ToolResult
        try {
          result = await toolModule.execute(input, ctx)
        } catch (err) {
          result = { summary: `Tool error: ${(err as Error).message}`, error: true }
        }

        const text = result.error
          ? `Error: ${result.summary}`
          : result.summary

        return {
          content: [{ type: 'text', text }],
          details: {
            data: result.data,
            error: result.error,
            artifacts: result.artifacts,
          },
        }
      },
    }
    return tool
  })

  // Group chat: add @mention tool if mentionSignal is available
  if (toolCtx.mentionSignal) {
    const mentionToolModule = createMentionTool(toolCtx.mentionSignal)
    const mentionSchema = jsonSchemaToTypeBox(
      mentionToolModule.definition.input_schema.properties || {},
      mentionToolModule.definition.input_schema.required || [],
    )
    const mentionTool: AgentTool = {
      name: mentionToolModule.definition.name,
      label: mentionToolModule.definition.name,
      description: mentionToolModule.definition.description,
      parameters: mentionSchema,
      execute: async (
        _toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
      ): Promise<AgentToolResult<any>> => {
        const input = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
        const ctx: ToolContext = { ...toolCtx, signal: signal || toolCtx.signal }
        let result: ToolResult
        try {
          result = await mentionToolModule.execute(input, ctx)
        } catch (err) {
          result = { summary: `Tool error: ${(err as Error).message}`, error: true }
        }
        const text = result.error ? `Error: ${result.summary}` : result.summary
        return {
          content: [{ type: 'text', text }],
          details: { data: result.data, error: result.error },
        }
      },
    }
    tools.push(mentionTool)
  }

  // 动态注入 MCP 工具（懒加载，首次或缓存过期时拉取）
  try {
    const mcpServers = await getMcpTools()
    for (const server of mcpServers) {
      for (const mcpTool of server.tools) {
        const prefixedName = `${server.serverName}/${mcpTool.name}`
        const schema = mcpTool.inputSchema.properties
          ? jsonSchemaToTypeBox(mcpTool.inputSchema.properties, mcpTool.inputSchema.required || [])
          : Type.Object({})

        tools.push({
          name: prefixedName,
          label: prefixedName,
          description: mcpTool.description || `MCP tool: ${mcpTool.name} (${server.serverName})`,
          parameters: schema,
          execute: async (
            _toolCallId: string,
            params: unknown,
            signal?: AbortSignal,
          ): Promise<AgentToolResult<any>> => {
            const input = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
            try {
              const result = await callMcpTool(
                server.serverId,
                server.serverName,
                server.serverUrl,
                mcpTool.name,
                input,
              )

              const mcpResult = result as { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }
              const text = mcpResult?.content
                ?.map((c) => c.text || c.data || '')
                .join('\n') || 'Tool executed successfully'

              return {
                content: [{ type: 'text', text }],
                details: { data: result, error: mcpResult?.isError === true },
              }
            } catch (err) {
              return {
                content: [{ type: 'text', text: `MCP tool error (${server.serverName}/${mcpTool.name}): ${(err as Error).message}` }],
                details: { error: true },
              }
            }
          },
        })
      }
    }
  } catch (err) {
    console.warn('[mcp] Failed to inject MCP tools, continuing with built-in tools only:', (err as Error).message)
  }

  return tools
}

// ---- Pi Message → ChatMessage 转换（streamFn 内部使用）----
function piMessagesToChatMessages(msgs: Message[]): ChatMessage[] {
  return msgs.map((msg): ChatMessage => {
    switch (msg.role) {
      case 'user': {
        const content: string | ContentPart[] = typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((c) => {
            if (c.type === 'image') {
              return { type: 'image_url' as const, image_url: { url: `data:${(c as any).mimeType || 'image/png'};base64,${(c as any).data || ''}` } }
            }
            return { type: 'text' as const, text: 'text' in c ? c.text : '' }
          })
        return { role: 'user', content }
      }
      case 'assistant': {
        const blocks = msg.content as (TextContent | ThinkingContent | ToolCall)[]
        const textParts = blocks.filter((b): b is TextContent => b.type === 'text').map((b) => b.text)
        const toolCalls = blocks.filter((b): b is ToolCall => b.type === 'toolCall').map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }))
        return {
          role: 'assistant',
          content: textParts.join('') || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        }
      }
      case 'toolResult': {
        const text = (msg.content as (TextContent | { type: string; text?: string })[])
          .filter((c) => c.type === 'text')
          .map((c) => (c as TextContent).text)
          .join('')
        return { role: 'tool', content: text, tool_call_id: msg.toolCallId }
      }
      default:
        return { role: 'user', content: '' }
    }
  })
}

// ---- StreamFn：包装 provider.ts 为 Pi 兼容格式 ----
function createStreamFn(agentModel: string, config: AppConfig, thinkingMode: boolean): StreamFn {
  return async (model: Model<any>, context: Context, options?: SimpleStreamOptions): Promise<ReturnType<typeof createAssistantMessageEventStream>> => {
    const stream = createAssistantMessageEventStream()

    // 构建 system prompt → 作为 messages 的第一条
    const systemPrompt = context.systemPrompt || ''
    const chatMessages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...piMessagesToChatMessages(context.messages),
    ]

    // 异步启动 LLM 调用
    ;(async () => {
      try {
        // Pi 工具定义 → 我们的 ToolDefinition[]
        const piTools = context.tools || []
        const ourTools: ToolDefinition[] = piTools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: {
            type: 'object' as const,
            properties: {},
          },
        }))

        let contentIndex = 0
        let hasStarted = false
        let textContent = ''
        let thinkingContent = ''
        let hasText = false
        let hasThinking = false
        const pendingToolCalls: Array<{ id: string; name: string; arguments: string }> = []

        // 构建 partial AssistantMessage
        const makePartial = (): AssistantMessage => ({
          role: 'assistant',
          content: [
            ...(hasText ? [{ type: 'text' as const, text: textContent }] : []),
            ...(hasThinking ? [{ type: 'thinking' as const, thinking: thinkingContent }] : []),
            ...pendingToolCalls.map((tc) => ({
              type: 'toolCall' as const,
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments ? JSON.parse(tc.arguments) : {},
            })),
          ],
          api: 'openai-completions',
          provider: 'openai',
          model: agentModel,
          stopReason: 'stop',
          usage: ZERO_USAGE,
          timestamp: Date.now(),
        })

        for await (const event of streamChatCompletion(config, agentModel, chatMessages, ourTools, thinkingMode)) {
          switch (event.type) {
            case 'token': {
              const delta = event.text || ''
              if (!hasStarted) {
                hasStarted = true
                stream.push({ type: 'start', partial: makePartial() })
              }
              if (!hasText) {
                hasText = true
                stream.push({ type: 'text_start', contentIndex, partial: makePartial() })
              }
              textContent += delta
              stream.push({ type: 'text_delta', contentIndex, delta, partial: makePartial() })
              break
            }
            case 'thinking': {
              const delta = event.text || ''
              if (!hasStarted) {
                hasStarted = true
                stream.push({ type: 'start', partial: makePartial() })
              }
              if (!hasThinking) {
                hasThinking = true
                const thinkingIdx = hasText ? 1 : 0
                stream.push({ type: 'thinking_start', contentIndex: thinkingIdx, partial: makePartial() })
              }
              thinkingContent += delta
              const thinkingIdx = hasText ? 1 : 0
              stream.push({ type: 'thinking_delta', contentIndex: thinkingIdx, delta, partial: makePartial() })
              break
            }
            case 'tool_call': {
              if (!hasStarted) {
                hasStarted = true
                stream.push({ type: 'start', partial: makePartial() })
              }
              const calls = event.toolCalls || []
              for (const tc of calls) {
                pendingToolCalls.push(tc)
                const tcIdx = makePartial().content.length - 1
                stream.push({ type: 'toolcall_start', contentIndex: tcIdx, partial: makePartial() })
                // 模拟 toolcall_delta + toolcall_end
                stream.push({
                  type: 'toolcall_delta',
                  contentIndex: tcIdx,
                  delta: tc.arguments,
                  partial: makePartial(),
                })
                stream.push({
                  type: 'toolcall_end',
                  contentIndex: tcIdx,
                  toolCall: {
                    type: 'toolCall',
                    id: tc.id,
                    name: tc.name,
                    arguments: tc.arguments ? JSON.parse(tc.arguments) : {},
                  },
                  partial: makePartial(),
                })
              }
              break
            }
            case 'finish': {
              break
            }
          }
        }

        // 结束文本和思考流
        if (hasText) {
          stream.push({ type: 'text_end', contentIndex: 0, content: textContent, partial: makePartial() })
        }
        if (hasThinking) {
          const thinkingIdx = hasText ? 1 : 0
          stream.push({ type: 'thinking_end', contentIndex: thinkingIdx, content: thinkingContent, partial: makePartial() })
        }

        // 如果没有产生任何内容，至少发送 start
        if (!hasStarted) {
          stream.push({ type: 'start', partial: makePartial() })
        }

        // 确定 stopReason
        const hasToolCalls = pendingToolCalls.length > 0
        const finalMsg: AssistantMessage = {
          ...makePartial(),
          stopReason: hasToolCalls ? 'toolUse' : 'stop',
        }
        stream.push({ type: 'done', reason: hasToolCalls ? 'toolUse' : 'stop', message: finalMsg })
        stream.end(finalMsg)
      } catch (err) {
        const errorMsg: AssistantMessage = {
          role: 'assistant',
          content: [],
          api: 'openai-completions',
          provider: 'openai',
          model: agentModel,
          stopReason: 'error',
          errorMessage: (err as Error).message,
          usage: ZERO_USAGE,
          timestamp: Date.now(),
        }
        stream.push({ type: 'error', reason: 'error', error: errorMsg })
        stream.end(errorMsg)
      }
    })()

    return stream
  }
}

// ---- Pi AgentEvent → SSE ServerMessage ----
// 在 emit 回调中处理，维护 SSE 流所需的状态
// 防御性兜底：系统提示词已不再注入 suggestions 指令（改由中立 Agent 在回复
// 完成后单独生成），pending/suggestionsSeen 与 parseSuggestions 仅用于剥离
// 模型自发输出的 ```suggestions 围栏，防止泄漏到前端 token 流。
interface SSEState {
  send: SendFn
  fullThinking: string
  fullText: string
  pending: string
  suggestionsSeen: boolean
  emittedSegmentRound: number
  lastRoundHadThinking: boolean
  producedArtifacts: ToolArtifact[]
  toolCallCount: number
}

function createEventEmitter(state: SSEState, conversationId: string): (event: AgentEvent) => Promise<void> {
  return async (event: AgentEvent) => {
    switch (event.type) {
      case 'agent_start':
        // 内部事件，不发送 SSE
        break

      case 'turn_start':
        // 内部事件，用于追踪 round
        state.lastRoundHadThinking = false
        break

      case 'message_update': {
        const sub = event.assistantMessageEvent
        switch (sub.type) {
          case 'text_delta': {
            const token = sub.delta
            state.fullText += token

            if (state.suggestionsSeen) break

            state.pending += token
            const fenceIdx = state.pending.indexOf(SUGGESTIONS_FENCE)
            if (fenceIdx !== -1) {
              state.suggestionsSeen = true
              const beforeFence = state.pending.slice(0, fenceIdx)
              if (beforeFence) state.send({ type: 'token', text: beforeFence })
              state.pending = ''
              break
            }

            if (state.pending.length > SUGGESTIONS_FENCE.length) {
              const safeLen = state.pending.length - SUGGESTIONS_FENCE.length
              state.send({ type: 'token', text: state.pending.slice(0, safeLen) })
              state.pending = state.pending.slice(safeLen)
            }
            break
          }
          case 'thinking_delta': {
            const t = sub.delta
            if (!t) break
            // 每轮第一条 thinking 前注入分隔符
            if (state.emittedSegmentRound !== state.toolCallCount) {
              state.emittedSegmentRound = state.toolCallCount
              const header = THINKING_SEGMENT_OPEN + (state.toolCallCount + 1) + THINKING_SEGMENT_CLOSE
              state.fullThinking += header
              state.send({ type: 'thinking', text: header, round: state.toolCallCount })
            }
            state.fullThinking += t
            state.send({ type: 'thinking', text: t, round: state.toolCallCount })
            state.lastRoundHadThinking = true
            break
          }
          // start / end / toolcall_* 事件由 Pi 循环处理，我们不额外处理
        }
        break
      }

      case 'tool_execution_start': {
        const input = typeof event.args === 'object' && event.args !== null ? event.args as Record<string, unknown> : {}
        state.send({ type: 'tool_execution_start', id: event.toolCallId, name: event.toolName, input })
        break
      }

      case 'tool_execution_end': {
        const result = event.result as AgentToolResult<any> | undefined
        const summary = result?.content?.[0] && 'text' in result.content[0]
          ? (result.content[0] as TextContent).text
          : (event.isError ? `Tool error: ${event.toolName}` : `${event.toolName} completed`)
        const artifacts = (result?.details as any)?.artifacts as ToolArtifact[] | undefined

        if (artifacts?.length) {
          state.producedArtifacts.push(...artifacts)
        }

        state.send({
          type: 'tool_result',
          id: event.toolCallId,
          name: event.toolName,
          summary,
          artifacts: artifacts?.map((a) => ({
            filename: a.filename,
            displayName: a.displayName,
            mimeType: a.mimeType,
            downloadUrl: a.downloadUrl,
          })),
        })
        break
      }

      case 'turn_end':
        state.toolCallCount++
        break

      case 'agent_end': {
        // 从 messages 中提取最终回复
        const assistantMsgs = event.messages.filter((m) => m.role === 'assistant')
        let replyText = ''
        if (assistantMsgs.length > 0) {
          const lastAssistant = assistantMsgs[assistantMsgs.length - 1] as AssistantMessage
          replyText = (lastAssistant.content || [])
            .filter((c): c is TextContent => c.type === 'text')
            .map((c) => c.text)
            .join('')
        }

        // Flush pending buffer
        if (state.pending.length > 0) {
          const fenceIdx = state.pending.indexOf(SUGGESTIONS_FENCE)
          if (fenceIdx > 0) {
            state.send({ type: 'token', text: state.pending.slice(0, fenceIdx) })
          } else if (fenceIdx === -1) {
            state.send({ type: 'token', text: state.pending })
          }
          state.pending = ''
        }

        const { reply, suggestions } = parseSuggestions(replyText || state.fullText)
        state.send({
          type: 'done',
          reply: reply || '（已完成思考但未能给出有效回答。请换一种问法重试。）',
          suggestions,
        })
        break
      }

      // message_start / message_end / tool_execution_update / compaction_* 暂不处理
    }
  }
}

// ---- ChatMessage 历史 → Pi AgentMessage 初始化 ----
function chatHistoryToAgentMessages(history: ChatMessage[], systemPrompt: string): AgentMessage[] {
  const result: AgentMessage[] = []

  for (const msg of history) {
    switch (msg.role) {
      case 'user': {
        const content = typeof msg.content === 'string'
          ? msg.content
          : (msg.content as ContentPart[])?.map((c) => {
            if (c.type === 'image_url') return { type: 'image_url' as const, image_url: c.image_url }
            return { type: 'text' as const, text: c.text }
          }) || ''
        result.push({
          role: 'user',
          content: content as string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[],
          timestamp: Date.now(),
        } as AgentMessage)
        break
      }
      case 'assistant': {
        const blocks: (TextContent | ThinkingContent | ToolCall)[] = []
        if (msg.content) {
          blocks.push({ type: 'text', text: msg.content as string })
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            blocks.push({
              type: 'toolCall',
              id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments ? JSON.parse(tc.function.arguments) : {},
            } as ToolCall)
          }
        }
        result.push({
          role: 'assistant',
          content: blocks,
          api: 'openai-completions',
          provider: 'openai',
          model: '',
          stopReason: msg.tool_calls?.length ? 'toolUse' : 'stop',
          usage: ZERO_USAGE,
          timestamp: Date.now(),
        } as AgentMessage)
        break
      }
      case 'tool': {
        result.push({
          role: 'toolResult',
          toolCallId: msg.tool_call_id || '',
          toolName: '',
          content: [{ type: 'text', text: msg.content as string || '' }],
          isError: false,
        } as AgentMessage)
        break
      }
      // system 消息不放入历史（已在 systemPrompt 中处理）
    }
  }

  return result
}

// ---- parseSuggestions（防御性兜底：正常路径恒为空建议）----
function parseSuggestions(text: string): { reply: string; suggestions: string[] } {
  const fenceIdx = text.lastIndexOf(SUGGESTIONS_FENCE)
  if (fenceIdx === -1) {
    return { reply: text.trimEnd(), suggestions: [] }
  }

  const reply = text.slice(0, fenceIdx).trimEnd()
  const afterFence = text.slice(fenceIdx + SUGGESTIONS_FENCE.length)
  const closeFence = afterFence.indexOf('```')
  const block = closeFence !== -1 ? afterFence.slice(0, closeFence) : afterFence

  const suggestions = block
    .split('\n')
    .map((l) => l.replace(/^[\s-*\d.]+/, '').trim())
    .filter(Boolean)
    .slice(0, 3)

  return { reply, suggestions }
}

// ---- 构建 AgentLoopConfig ----
function buildLoopConfig(agentModel: string, config: AppConfig): AgentLoopConfig {
  return {
    model: {
      id: agentModel,
      name: agentModel,
      api: 'openai-completions',
      provider: 'openai',
      baseUrl: config.api_endpoint,
      input: ['text', 'image'] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 100000,
      reasoning: false,
    } as Model<any>,
    maxTokens: 100000,
    convertToLlm: (messages: AgentMessage[]): Message[] => {
      // Default conversion: AgentMessage[] → Message[] (identity for standard messages)
      return messages as Message[]
    },
    toolExecution: 'parallel',
  }
}

// ---- 入口函数 ----
export async function runPiAgentLoop(
  userMessage: string | ContentPart[],
  history: ChatMessage[],
  send: SendFn,
  signal?: AbortSignal,
  thinkingMode = true,
  conversationId?: string,
  userId?: string,
  agentId?: string,
  mentionSignal?: MentionSignal,
  isGroup = false,
  infiniteMode = false,
  agentName?: string,
  groupAgentNames?: string[],
  mentionedBy?: string | null,
): Promise<{ reply: string; suggestions: string[]; thinking: string; artifacts?: ToolArtifact[] }> {
  const config = await getConfig()

  // Resolve agent: use specified agentId, or fall back to first available agent
  let agentModel = config.api_endpoint ? 'gpt-4o' : '' // fallback
  let agentSystemPrompt = DEFAULT_SYSTEM_PROMPT

  if (agentId) {
    const agent = await getAgent(agentId)
    if (agent) {
      agentModel = agent.model
      agentSystemPrompt = agent.system_prompt
    }
  }

  if (!agentId || !agentModel) {
    // Fallback to first available non-neutral agent
    const allAgents = await listAgents()
    const fallbackAgent = allAgents.find((a) => a.id !== NEUTRAL_AGENT_ID)
    if (fallbackAgent) {
      agentModel = fallbackAgent.model
      agentSystemPrompt = fallbackAgent.system_prompt
    }
  }
  const convId = conversationId || 'default'

  // 1. 构建系统提示词
  const systemPrompt = buildSystemPrompt(agentSystemPrompt, thinkingMode, isGroup, infiniteMode, agentName, groupAgentNames, mentionedBy)

  // 2. 构建工具上下文
  const toolCtx: ToolContext = {
    conversationId: convId,
    userId: userId || 'anonymous',
    workspace: new SandboxFS(convId),
    signal,
    mentionSignal,
  }

  // 3. 创建 Pi 工具
  const tools = await createToolAdapter(toolCtx)

  // 4. 构建 Pi AgentContext
  const context: AgentContext = {
    systemPrompt,
    messages: chatHistoryToAgentMessages(history, systemPrompt),
    tools,
  }

  // 5. 构建用户消息
  const userContent = typeof userMessage === 'string'
    ? userMessage
    : userMessage.map((c) => {
      if (c.type === 'image_url') return { type: 'image_url' as const, image_url: c.image_url }
      return { type: 'text' as const, text: c.text }
    })

  const promptMessage: AgentMessage = {
    role: 'user',
    content: userContent as string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[],
    timestamp: Date.now(),
  } as AgentMessage

  // 6. 构建 AgentLoopConfig
  const loopConfig = buildLoopConfig(agentModel, config)

  // 7. 创建 StreamFn
  const streamFn = createStreamFn(agentModel, config, thinkingMode)

  // 8. SSE 状态
  const sseState: SSEState = {
    send,
    fullThinking: '',
    fullText: '',
    pending: '',
    suggestionsSeen: false,
    emittedSegmentRound: -1,
    lastRoundHadThinking: false,
    producedArtifacts: [],
    toolCallCount: 0,
  }

  // 9. 事件发射器
  const emit = createEventEmitter(sseState, convId)

  // 10. 启动 Pi Agent 循环
  try {
    await runAgentLoop(
      [promptMessage],
      context,
      loopConfig,
      emit,
      signal,
      streamFn,
    )
  } catch (err) {
    send({ type: 'error', message: err instanceof Error ? err.message : 'Unknown error' })
    return { reply: '', suggestions: [], thinking: sseState.fullThinking }
  }

  // 11. 解析最终回复
  const { reply, suggestions } = parseSuggestions(sseState.fullText)

  return {
    reply: reply || sseState.fullText || '（已完成思考但未能给出有效回答。请换一种问法重试。）',
    suggestions,
    thinking: sseState.fullThinking,
    artifacts: sseState.producedArtifacts.length > 0 ? sseState.producedArtifacts : undefined,
  }
}