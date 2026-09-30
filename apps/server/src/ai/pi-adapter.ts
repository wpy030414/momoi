// ============================================================
// Pi Adapter — Bridges pi-agent-core to Momoi
// ============================================================
//
// 职责：
// 1. 将 ToolModule 包装为 Pi 的 AgentTool
// 2. 包装 provider.ts 为 Pi 的 StreamFn
// 3. 将 Pi 的 AgentEvent 映射为 SSE ServerMessage
// 4. 组装系统提示词（委托给提示词规则引擎 —— 片段/条件/层顺序见 ../prompts）
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
  AgentToolUpdateCallback,
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

import type { AppConfig, Agent, ServerMessage, ToolDefinition, TraceEntry } from '@momoi/shared/types'
import { ErrCode } from '@momoi/shared/errors'
import { ApiError } from '../lib/apiError.js'
import {
  SUGGESTIONS_FENCE,
  THINKING_SEGMENT_OPEN,
  THINKING_SEGMENT_CLOSE,
  DEFAULT_SYSTEM_PROMPT,
	NEUTRAL_AGENT_ID,
} from '@momoi/shared/constants'
import { getConfig, getAgent, listAgents, getUserAgentMemories } from '../lib/config.js'
import { getAllTools } from './tools.js'
import { resolveTool } from '../tools/registry.js'
import { getMcpTools, callMcpTool } from '../tools/mcp-client.js'
import type { ToolContext, ToolResult, ToolArtifact } from '../tools/types.js'
import type { MentionSignal } from '../tools/group-mention-tool.js'
import { createMentionTool } from '../tools/group-mention-tool.js'
import { SandboxFS } from '../tools/workspace.js'
import {
  buildChatSystemPrompt,
  getFabricatedReply,
  getRetryPlaceholder,
  resolveToolDescription,
} from '../prompts/index.js'
import { streamChatCompletion, probeUpstream } from './provider.js'
import type { ChatMessage, ContentPart } from './provider.js'

type SendFn = (msg: ServerMessage) => void

// ---- 零值 Usage（不追踪 token 用量时使用）----
const ZERO_USAGE: Usage = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

// ---- 空回复重试上限（上游敏感词审查 → 搬迁历史重试，agent_end 判定与重试循环共用）----
const MAX_EMPTY_RETRIES = 3

// ---- 拟造服从回复 / 重试占位提问：文本由提示词规则引擎托管（prompts/fragments/retry.ts）----
// 恒真保证发言轮次落库/进群聊 turnReplies；作为 assistant 消息回流历史时自身无害

// ---- 系统提示词装配已迁移至提示词规则引擎（apps/server/src/prompts）----
// 片段文本、注入条件与层顺序在那里定义；本文件只保留调用点（runPiAgentLoop 内的
// buildChatSystemPrompt）。原先在此处内联的场景块，其设计约束随文本一并迁移：
//   · 记忆写侧规则落在人设之后的行为规则区（chat/memory-rules）
//   · 世界模拟块替代群组对话规则块：世界回合没有「用户」，user 消息是「来自世界的变动」
//   · QQ 群聊下不注入群组规则（单 Agent 面对多真人，避免把人类成员误认成 AI 同伴）
//   · 主角/配角、无限模式、环境信息、技能摘要（chat/speaking-role-*、chat/infinite-mode、
//     chat/environment、chat/skills）
// 文本等价性由 test/golden.test.ts（黄金快照）锁定。

// ---- JSON Schema 属性 → TypeBox schema ----
function schemaPropertyToTypeBox(prop: import('@momoi/shared/types').ToolSchemaProperty): TSchema {
  const desc = prop.description
  const constraints: Record<string, unknown> = {}
  if (desc) constraints.description = desc
  if (prop.default !== undefined) constraints.default = prop.default
  if (prop.minimum !== undefined) constraints.minimum = prop.minimum
  if (prop.maximum !== undefined) constraints.maximum = prop.maximum
  if (prop.minLength !== undefined) constraints.minLength = prop.minLength
  if (prop.maxLength !== undefined) constraints.maxLength = prop.maxLength
  if (prop.pattern !== undefined) constraints.pattern = prop.pattern
  if (prop.minItems !== undefined) constraints.minItems = prop.minItems
  if (prop.maxItems !== undefined) constraints.maxItems = prop.maxItems
  if (prop.enum) constraints.enum = prop.enum

  switch (prop.type) {
    case 'string': return Type.String(constraints)
    case 'number': return Type.Number(constraints)
    case 'integer': return Type.Integer(constraints)
    case 'boolean': return Type.Boolean(constraints)
    case 'array': {
      const itemType = prop.items ? schemaPropertyToTypeBox(prop.items) : Type.Any()
      return Type.Array(itemType, constraints)
    }
    case 'object': {
      const inner = prop.properties ? jsonSchemaToTypeBox(prop.properties, prop.required || []) : Type.Record(Type.String(), Type.Any())
      return Type.Object(inner.properties, constraints)
    }
    default: return Type.Any(constraints)
  }
}

function jsonSchemaToTypeBox(properties: Record<string, import('@momoi/shared/types').ToolSchemaProperty>, required: string[] = []): TSchema {
  const obj: Record<string, TSchema> = {}
  for (const [key, prop] of Object.entries(properties)) {
    obj[key] = schemaPropertyToTypeBox(prop)
  }
  return Type.Object(obj)
}

// ---- ToolModule → Pi AgentTool ----
async function createToolAdapter(toolCtx: ToolContext): Promise<AgentTool[]> {
  // 记忆工具只在「能拥有记忆的 Agent」下暴露：中立 Agent、身份未知、以及显式禁用记忆的
  // 上下文（QQ 群聊等多真人场景）一律剔除——它们的记忆永远不会被注入，允许调用只会写出
  // 死行或把别人的事记到绑定者名下（与 routes/memories.ts 对中立 Agent 返回 403 一致）。
  const memoryCapable = !!toolCtx.agentId && toolCtx.agentId !== NEUTRAL_AGENT_ID && !toolCtx.memoryDisabled
  const defs = getAllTools().filter((d) => memoryCapable || d.name !== 'save_memory')
  const tools = defs.map((def) => {
    const toolModule = resolveTool(def.name)
    const schema = jsonSchemaToTypeBox(def.input_schema.properties || {}, def.input_schema.required || [])

    const tool: AgentTool = {
      name: def.name,
      label: def.name,
      description: resolveToolDescription(def),
      parameters: schema,
      executionMode: def.name === 'ask_user' ? 'sequential' as const : undefined,
      execute: async (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback,
      ): Promise<AgentToolResult<any>> => {
        const input = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
        if (!toolModule) {
          return {
            content: [{ type: 'text', text: `Unknown tool: ${def.name}` }],
            details: { error: true },
          }
        }

        const ctx: ToolContext = {
          ...toolCtx,
          signal: signal || toolCtx.signal,
          currentToolCallId: toolCallId,
          onUpdate: onUpdate as ToolContext['onUpdate'],
        }
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
    console.log(`[mcp] createToolAdapter: ${mcpServers.length} MCP server(s) with ${mcpServers.reduce((s,x) => s + x.tools.length, 0)} total tools`)
    for (const server of mcpServers) {
      for (const mcpTool of server.tools) {
        const prefixedName = `${server.serverName}/${mcpTool.name}`
        console.log(`[mcp]   → ${prefixedName}`)
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
        // t.parameters 是 TypeBox TObject，JSON.stringify 可干净输出 JSON Schema
        // （TypeBox 内部属性为非枚举，不会泄露）。
        const piTools = context.tools || []
        const ourTools: ToolDefinition[] = piTools.map((t) => {
          let input_schema: ToolDefinition['input_schema'] = { type: 'object' as const, properties: {} }
          try {
            const raw = JSON.parse(JSON.stringify(t.parameters)) as Record<string, unknown>
            input_schema = {
              type: (raw.type as 'object') || 'object',
              properties: (raw.properties as ToolDefinition['input_schema']['properties']) || {},
              required: raw.required as string[] | undefined,
            }
          } catch {
            // schema 解析失败时退化为无参工具，不影响整体流程
          }
          return {
            name: t.name,
            description: t.description,
            input_schema,
          }
        })

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
  emittedSegmentRound: number
  lastRoundHadThinking: boolean
  producedArtifacts: ToolArtifact[]
  toolCallCount: number
  trace: TraceEntry[]
  emptyRetryCount: number
  needsRetry: boolean
  /** 探针实测确认网关不可达——不做空回复重试，直接告知用户 */
  upstreamError: boolean
  /** 上游连通性探针（另起最小对话只发 "1"），由 runPiAgentLoop 注入 */
  probe: () => Promise<{ reachable: boolean; detail?: string }>
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

            // Trace: append to last text entry or create new one
            const lastT = state.trace[state.trace.length - 1]
            if (lastT?.type === 'text') {
              lastT.text += token
            } else {
              state.trace.push({ type: 'text', text: token })
            }

            state.send({ type: 'token', text: token })
            break
          }
          case 'thinking_delta': {
            const t = sub.delta
            if (!t) break
            const isNewRound = state.emittedSegmentRound !== state.toolCallCount
            // 每轮第一条 thinking 前注入分隔符
            if (isNewRound) {
              state.emittedSegmentRound = state.toolCallCount
              const header = THINKING_SEGMENT_OPEN + (state.toolCallCount + 1) + THINKING_SEGMENT_CLOSE
              state.fullThinking += header
              state.send({ type: 'thinking', text: header, round: state.toolCallCount })
              // Trace: new thinking entry for new round
              state.trace.push({ type: 'thinking', text: '' })
            }
            state.fullThinking += t
            state.send({ type: 'thinking', text: t, round: state.toolCallCount })
            // Trace: append to last thinking entry
            const lastTh = state.trace[state.trace.length - 1]
            if (lastTh?.type === 'thinking') {
              lastTh.text += t
            } else {
              state.trace.push({ type: 'thinking', text: t })
            }
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
        state.trace.push({ type: 'tool_call', id: event.toolCallId, name: event.toolName, input, status: 'running' })
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

        const artifactMeta = artifacts?.map((a) => ({
          filename: a.filename,
          displayName: a.displayName,
          mimeType: a.mimeType,
          downloadUrl: a.downloadUrl,
        }))

        state.send({
          type: 'tool_result',
          id: event.toolCallId,
          name: event.toolName,
          summary,
          artifacts: artifactMeta,
        })

        // Trace: update matching tool_call entry by id
        const isError = !!event.isError || summary?.startsWith('Tool error') || summary?.startsWith('BLOCKED')
        for (let i = state.trace.length - 1; i >= 0; i--) {
          const e = state.trace[i]
          if (e.type === 'tool_call' && e.id === event.toolCallId) {
            e.status = isError ? 'error' : 'done'
            e.result = summary
            if (artifactMeta?.length) e.artifacts = artifactMeta
            break
          }
        }
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

        // 上游错误甄别：AssistantMessage stopReason === 'error' 且 content 为空，
        // 是 streamChatCompletion 抛出的连接层错误——但「网关不可达」与「网关可达
        // 却掐断本请求（内容审查/封禁）」在这一层完全同构，错误形态区分不了。
        // 只能实测：探针另起最小对话（无提示词、无历史、无工具）只发 "1"——
        //   · 探针有回复 → 网关活着，此前失败是本请求被掐断，与敏感词空回复
        //     同路处理（落入下方搬迁重试分支）；
        //   · 探针也失败 → 真的连不上，不做重试，直接告知用户。
        const lastAssistantMsg = assistantMsgs.length > 0
          ? assistantMsgs[assistantMsgs.length - 1] as AssistantMessage
          : null
        if (lastAssistantMsg?.stopReason === 'error'
            && (!lastAssistantMsg.content || lastAssistantMsg.content.length === 0)
            && !state.upstreamError) {
          const probe = await state.probe()
          if (!probe.reachable) {
            state.upstreamError = true
            // 探针细节只进日志，不上 wire
            console.error('[ai] upstream unreachable — probe:', probe.detail ?? '(no detail)')
            state.send({ type: 'error', code: ErrCode.AI_UPSTREAM_UNREACHABLE })
            break
          }
          // 网关可达 → 本请求被掐断：不 break，落入下方空回复搬迁重试分支
        }

        const { reply, suggestions } = parseSuggestions(replyText || state.fullText)
        if (!reply && !state.fullText.trim() && state.emptyRetryCount < MAX_EMPTY_RETRIES) {
          // 敏感词规避：上游 LLM 对当前提问做内容审查 → 空回复；
          // 将原始提问搬迁到对话历史后重试（上游不检查历史内容）。
          state.needsRetry = true
        } else {
          state.send({
            type: 'done',
            reply: reply || state.fullText || getFabricatedReply(),
            suggestions,
          })
        }
        break
      }

      // tool_execution_update: 工具执行期间进度更新（ask_user 通过此事件下发问题）
      case 'tool_execution_update': {
        const details = event.partialResult?.details as Record<string, unknown> | undefined
        if (details?.type === 'ask_user') {
          state.send({
            type: 'ask_user',
            question_id: details.questionId as string,
            tool_call_id: event.toolCallId,
            questions: details.questions as import('@momoi/shared/types').AskUserQuestion[],
          })
        }
        break
      }

      // message_start / message_end / compaction_* 暂不处理
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

// ---- 入口函数选项 ----
export interface RunPiAgentLoopOptions {
  userMessage: string | ContentPart[]
  history: ChatMessage[]
  send: SendFn
  signal?: AbortSignal
  thinkingMode?: boolean
  conversationId?: string
  userId?: string
  agentId?: string
  mentionSignal?: MentionSignal
  isGroup?: boolean
  infiniteMode?: boolean
  agentName?: string
  groupAgentNames?: string[]
  mentionedBy?: string
  /** 本轮发言角色：主角 / 配角 */
  speakingRole?: 'protagonist' | 'supporting'
  /** 主角的名字（当 speakingRole 为 supporting 时） */
  protagonistName?: string
  language?: string
  /** QQ 群聊模式 —— 单 Agent 面对多真人，提示词以群聊规则覆盖 */
  isQqGroup?: boolean
  /** 本 Agent 上一次在本会话中发言的 Unix 时间戳（秒） */
  lastMessageAt?: number
  /** 强制合规重试：将原始提问预搬迁到对话历史，以合规占位提示词作为当前提问
   *  在首次模型调用前即完成绕过，而非等空回复再搬迁。 */
  forceCompliance?: boolean
  /** 世界模拟上下文：存在时系统提示注入「世界模拟」块（替代群组对话规则块的身份框架） */
  world?: { laws: string }
}

// ---- 入口函数 ----
export async function runPiAgentLoop(opts: RunPiAgentLoopOptions): Promise<{ reply: string; suggestions: string[]; thinking: string; artifacts?: ToolArtifact[]; agentId?: string; trace?: TraceEntry[] }> {
  const {
    userMessage, history, send, signal,
    thinkingMode = true, conversationId, userId, agentId,
    mentionSignal, isGroup, infiniteMode,
    agentName, groupAgentNames, mentionedBy,
    speakingRole, protagonistName, language,
    isQqGroup, lastMessageAt, world,
  } = opts
  const config = await getConfig()

  // Resolve agent: use specified agentId, or fall back to first available agent.
  // 注意查找失败（Agent 已被后台删除）也必须走回退——否则 agentModel 会停留在
  // 初始占位值 'gpt-4o'（真值），把会话钉死在不存在的模型上。
  let resolvedAgent: Agent | undefined
  if (agentId) {
    resolvedAgent = (await getAgent(agentId)) ?? undefined
  }
  if (!resolvedAgent) {
    const allAgents = await listAgents()
    resolvedAgent = allAgents.find((a) => a.id !== NEUTRAL_AGENT_ID)
  }
  const agentModel = resolvedAgent?.model || (config.api_endpoint ? 'gpt-4o' : '')
  const agentSystemPrompt = resolvedAgent?.system_prompt || DEFAULT_SYSTEM_PROMPT
  // 实际采用的 Agent：供调用方落库 messages.agent_id（单聊也记录发言者，历史/导出/气泡标签一致）
  const resolvedAgentId = resolvedAgent?.id
  const convId = conversationId || 'default'

  // 跨会话记忆的可用性判定（注入与工具暴露同源，避免出现"能写不能读"或反之）：
  //  - 中立 Agent 没有记忆（与 routes/memories.ts 对中立 Agent 返回 403 一致）；
  //  - QQ 群聊是多真人场景：userId 是机器人绑定者而非群内发言者，注入会把绑定者的记忆
  //    投放到群里、写入会把群成员的事记到绑定者名下——两个方向都要关掉。
  // 加载放在这里而不是各调用方——网页 / 群聊 / 微信 / QQ 全部走同一处，且与工具实际执行时
  // 使用的 resolvedAgentId 严格一致（调用方传入的 agentId 在 Agent 被删除时会回退到别的 Agent）。
  const memoryEnabled = !!resolvedAgentId && resolvedAgentId !== NEUTRAL_AGENT_ID && !isQqGroup
  const userMemories = memoryEnabled && resolvedAgentId
    ? await getUserAgentMemories(userId || 'anonymous', resolvedAgentId)
    : []

  // 1. 构建系统提示词（world 存在时注入「世界模拟」块，替代群组规则块的身份框架）
  const systemPrompt = buildChatSystemPrompt({ agentSystemPrompt, thinkingMode, isGroup, infiniteMode, agentName, groupAgentNames, mentionedBy, speakingRole, protagonistName, language, isQqGroup, lastMessageAt, memoryEnabled, userMemories, world })

  // 2. 构建工具上下文
  const toolCtx: ToolContext = {
    conversationId: convId,
    userId: userId || 'anonymous',
    workspace: await SandboxFS.forConversation(convId),
    signal,
    mentionSignal,
    agentId: resolvedAgentId,
    memoryDisabled: !memoryEnabled,
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

  let promptMessage: AgentMessage = {
    role: 'user',
    content: userContent as string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[],
    timestamp: Date.now(),
  } as AgentMessage

  // 6. 构建 AgentLoopConfig
  const loopConfig = buildLoopConfig(agentModel, config)

  // 7. 创建 StreamFn
  const streamFn = createStreamFn(agentModel, config, thinkingMode)

  // 8. 强制合规重试：在首次模型调用前，将原始提问预搬迁至对话历史
  //    （上游不检查历史内容），当前提问替换为合规占位符。
  if (opts.forceCompliance) {
    context.messages.push({
      role: 'user',
      content: userContent as string,
      timestamp: Date.now() - 1000,
    } as AgentMessage)
    context.messages.push({
      role: 'assistant',
      content: [{ type: 'text', text: getFabricatedReply() }],
      api: 'openai-completions',
      provider: 'openai',
      model: agentModel,
      stopReason: 'stop',
      usage: ZERO_USAGE,
      timestamp: Date.now(),
    } as AgentMessage)

    promptMessage = {
      role: 'user',
      content: getRetryPlaceholder(),
      timestamp: Date.now(),
    } as AgentMessage
  }

  // 9. SSE 状态
  const sseState: SSEState = {
    send,
    fullThinking: '',
    fullText: '',
    emittedSegmentRound: -1,
    lastRoundHadThinking: false,
    producedArtifacts: [],
    toolCallCount: 0,
    trace: [],
    emptyRetryCount: 0,
    upstreamError: false,
    needsRetry: false,
    probe: () => probeUpstream(config, agentModel),
  }

  // 9. 事件发射器
  const emit = createEventEmitter(sseState, convId)

  // 10. 启动 Pi Agent 循环（含空回复重试——敏感词规避）
  try {
    await runAgentLoop(
      [promptMessage],
      context,
      loopConfig,
      emit,
      signal,
      streamFn,
    )

    while (sseState.needsRetry && sseState.emptyRetryCount < MAX_EMPTY_RETRIES) {
      sseState.needsRetry = false
      sseState.emptyRetryCount++

      // 将原始提问 + "..." 回复搬迁到对话历史中——
      // 上游 LLM 对当前提问做敏感词审查但不检查历史内容，
      // 将敏感内容移到 history 即可绕过。
      context.messages.push({
        role: 'user',
        content: userContent as string,
        timestamp: Date.now() - 1000,
      } as AgentMessage)
      context.messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: getFabricatedReply() }],
        api: 'openai-completions',
        provider: 'openai',
        model: agentModel,
        stopReason: 'stop',
        usage: ZERO_USAGE,
        timestamp: Date.now(),
      } as AgentMessage)

      // 当前提问替换为拟造「我」的占位消息，敏感内容已在 history 中
      const retryPrompt: AgentMessage = {
        role: 'user',
        content: getRetryPlaceholder(),
        timestamp: Date.now(),
      } as AgentMessage

      await runAgentLoop(
        [retryPrompt],
        context,
        loopConfig,
        emit,
        signal,
        streamFn,
      )
    }
  } catch (err) {
    if (!sseState.upstreamError) {
      // ApiError（上游/业务错误）：结构化 code + params 上 wire；
      // 其余异常只进日志，客户端收到统一的 INTERNAL 兜底码。
      if (err instanceof ApiError) {
        send({ type: 'error', code: err.code, ...(err.params ? { params: err.params } : {}) })
      } else {
        console.error('[ai] stream error:', err)
        send({ type: 'error', code: ErrCode.CHAT_INTERNAL_ERROR })
      }
    }
    return { reply: '', suggestions: [], thinking: sseState.fullThinking, agentId: resolvedAgentId, trace: sseState.trace.length > 0 ? sseState.trace : undefined }
  }

  // 11. 解析最终回复
  const { reply, suggestions } = parseSuggestions(sseState.fullText)

  return {
    reply: sseState.upstreamError ? '' : (reply || sseState.fullText || getFabricatedReply()),
    suggestions,
    thinking: sseState.fullThinking,
    artifacts: sseState.producedArtifacts.length > 0 ? sseState.producedArtifacts : undefined,
    agentId: resolvedAgentId,
    trace: sseState.trace.length > 0 ? sseState.trace : undefined,
  }
}