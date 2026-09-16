// ============================================================
// Group Chat Orchestrator — Multi-agent serial conversation
// ============================================================

import { runPiAgentLoop } from './pi-adapter.js'
import type { ChatMessage, ContentPart } from './provider.js'
import type { ServerMessage, Agent, TraceEntry } from '../../shared/types.js'
import type { ToolArtifact } from '../tools/types.js'
import type { MentionSignal } from '../tools/group-mention-tool.js'
import { getAgent, getConfig } from '../config.js'
import { decideGroupSpeakerOrder, type SpeakerOrder } from './neutral-agent.js'
import { NEUTRAL_AGENT_ID } from '../../shared/constants.js'

const MAX_MENTION_REDIRECTS = 5

// ---- 本轮发言调度（中立 Agent 裁决）----
const DECISION_TIMEOUT_MS = 10_000

interface GroupOrchestratorOptions {
  userMessage: string | ContentPart[]
  history: ChatMessage[]
  send: (msg: ServerMessage) => void
  signal?: AbortSignal
  thinkingMode: boolean
  conversationId: string
  userId: string
  agentIds: string[]
  language?: string
  saveMessage: (
    agentId: string,
    agentName: string,
    reply: string,
    thinking: string,
    suggestions: string[],
    artifacts?: ToolArtifact[],
    trace?: TraceEntry[],
  ) => Promise<void>
}

function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/**
 * 群聊上下文格式化（支持 per-agent 视角）：
 * 把历史中「其他 Agent 产生的 assistant 消息」重写为
 * `[Agent名字]: 内容` 的 user 角色消息。
 *
 * 原因：模型会把 assistant 角色消息当作「自己说过的话」，
 * 导致后续 Agent 复述/延续他人内容（群聊回复雷同）。
 * 以 user 角色 + 名字前缀注入后，模型能明确区分「他人发言」与「用户提问」，
 * 从而给出自己视角的独立回答。
 *
 * 当指定 currentAgentId 时，该 Agent 自己的历史发言保持 assistant 角色
 * （不转换），让它能正确识别自己说过的话、维持身份连续性。
 * 无 agent_id 的旧消息保持原样。
 */
function prepareGroupHistory(
  history: ChatMessage[],
  agentNameById: Map<string, string>,
  currentAgentId?: string,
): ChatMessage[] {
  return history.map((msg) => {
    if (msg.role === 'assistant' && msg.agent_id) {
      // 当前 Agent 自己的历史发言保持 assistant 角色，维持身份认同
      if (currentAgentId && msg.agent_id === currentAgentId) {
        return msg
      }
      // 其他 Agent 的发言转为 user 角色 + 名字前缀
      const name = agentNameById.get(msg.agent_id)
      if (name) {
        return {
          role: 'user',
          content: `[${name}]: ${msg.content ?? ''}`,
        }
      }
    }
    return msg
  })
}

const CONTEXT_MAX_MESSAGES = 20
const CONTEXT_MAX_LINE_CHARS = 400
const CONTEXT_MAX_USER_CHARS = 1500
const CONTEXT_MAX_TOTAL_CHARS = 6000

function toPlainText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  if (!content) return ''
  return content.filter((p) => p.type === 'text').map((p) => p.text).join(' ')
}

/**
 * 构造裁决上下文：最近 20 条历史 + 当前用户消息。
 * - 逐行截断：用户消息可能含附件解析正文（可达 MB 级）
 * - 跳过 tool/system 行：工具输出是原始转储，不应进入裁决
 * - 超总量时保留最近部分
 */
function formatDecisionContext(
  history: ChatMessage[],
  userMessage: string | ContentPart[],
  agentNameById: Map<string, string>,
): string {
  const lines: string[] = []
  for (const msg of history.slice(-CONTEXT_MAX_MESSAGES)) {
    if (msg.role === 'tool' || msg.role === 'system') continue
    const text = toPlainText(msg.content).slice(0, CONTEXT_MAX_LINE_CHARS)
    if (!text.trim()) continue
    if (msg.role === 'user') {
      lines.push(`用户: ${text}`)
    } else {
      const name = msg.agent_id ? agentNameById.get(msg.agent_id) || msg.agent_id : '助手'
      lines.push(`[${name}]: ${text}`)
    }
  }
  const current = toPlainText(userMessage).slice(0, CONTEXT_MAX_USER_CHARS)
  if (current.trim()) lines.push(`用户: ${current}`)

  const joined = lines.join('\n')
  return joined.length > CONTEXT_MAX_TOTAL_CHARS
    ? joined.slice(joined.length - CONTEXT_MAX_TOTAL_CHARS)
    : joined
}

export async function orchestrateGroupChat(options: GroupOrchestratorOptions): Promise<void> {
  const { userMessage, history, send, signal, thinkingMode, conversationId, userId, agentIds, language, saveMessage } = options

  // Preload agents (parallel, avoids repeated getAgent calls in the loop).
  // 必须早于 group_start：完整名册要供 @ 解析与本轮发言调度（中立 Agent 裁决）使用。
  const agentNameById = new Map<string, string>()
  const agentsById = new Map<string, Agent>()
  await Promise.all(
    agentIds.map(async (id) => {
      const agent = await getAgent(id)
      if (agent) {
        agentNameById.set(id, agent.name)
        agentsById.set(id, agent)
      }
    }),
  )

  // Parse user @mentions early — mentioned members are force-included by the
  // orchestration decision below and still get front-of-queue priority.
  const userMentionedIds = typeof userMessage === 'string'
    ? parseUserMentions(userMessage, agentNameById)
    : []

  // ---- 本轮发言调度：中立 Agent 裁决发言顺序 ----
  // 失败开放：任何异常 / 超时 / 空结果都退回 shuffle + 全员参与。
  let speakerOrder: SpeakerOrder | null = null
  const shouldDecide =
    agentNameById.size > 1 &&
    userMentionedIds.length < agentIds.length

  if (shouldDecide) {
    const startedAt = Date.now()
    try {
      const [config, neutralAgent] = await Promise.all([
        getConfig(),
        getAgent(NEUTRAL_AGENT_ID),
      ])
      const model = neutralAgent?.model || agentsById.get(agentIds[0])?.model || 'gpt-4o'

      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      try {
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => { timedOut = true; resolve(null) }, DECISION_TIMEOUT_MS)
        })
        speakerOrder = await Promise.race([
          decideGroupSpeakerOrder(
            config,
            model,
            {
              conversationContext: formatDecisionContext(history, userMessage, agentNameById),
              memberNames: Array.from(agentNameById.values()),
            },
            neutralAgent?.system_prompt?.trim() || undefined,
          ),
          timeout,
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }

      if (speakerOrder === null) {
        console.warn(`Group chat: orchestration ${timedOut ? 'timed out' : 'failed'} after ${Date.now() - startedAt}ms, fallback to shuffle`)
      } else {
        // 全部跳过也算失败：回退到全员参与
        if (speakerOrder.order.length === 0) {
          console.warn('Group chat: orchestration returned empty order, fallback to shuffle')
          speakerOrder = null
        } else {
          console.log(`Group chat: speaker order ${speakerOrder.order.join(' → ')}${speakerOrder.protagonist ? ` (主角: ${speakerOrder.protagonist})` : ''} (${Date.now() - startedAt}ms)`)
        }
      }
    } catch (err) {
      console.error('Group chat: orchestration failed, fallback to shuffle:', (err as Error).message)
    }
  }

  // Build ordered participant list from speaker order, or fall back to shuffle
  let orderedParticipants: string[]
  const protagonistAgentId: string | undefined = speakerOrder?.protagonist
    ? await resolveAgentByName(speakerOrder.protagonist, agentNameById) ?? undefined
    : undefined

  if (speakerOrder && speakerOrder.order.length > 0) {
    // Resolve names to IDs in the given order
    const resolved: string[] = []
    for (const name of speakerOrder.order) {
      const id = await resolveAgentByName(name, agentNameById)
      if (id && !resolved.includes(id)) resolved.push(id)
    }
    // Safety net: append any agent IDs that were missed by name resolution
    for (const id of agentIds) {
      if (!resolved.includes(id)) resolved.push(id)
    }
    orderedParticipants = resolved
  } else {
    // Fallback: shuffle (original behavior)
    orderedParticipants = agentIds.length > 1
      ? [agentIds[0], ...shuffleArray(agentIds.slice(1))]
      : [...agentIds]
  }

  // User @mentions always get front priority, overriding any orchestration order
  if (userMentionedIds.length > 0) {
    for (const mid of [...userMentionedIds].reverse()) {
      orderedParticipants = [mid, ...orderedParticipants.filter(id => id !== mid)]
    }
  }

  send({ type: 'group_start', agent_ids: orderedParticipants })

  const repliedAgents = new Set<string>()
  let remaining = [...orderedParticipants]
  let mentionDepth = 0
  let mentionedBy: string | undefined = undefined

  // Set mentionedBy to "user" so the system prompt can acknowledge it
  if (userMentionedIds.length > 0) {
    mentionedBy = '用户'
  }

  // 本轮发言的原始 DB 历史（不转换——每个 Agent 发言前按自身视角构建
  // per-agent history）。同一轮内已发言 Agent 的回复存在 turnReplies 中，
  // 同样按 per-agent 视角注入（自己的回复保持 assistant 角色，别人的转为
  // user 角色 + 名字前缀）。
  const baseHistory: ChatMessage[] = history
  const turnReplies: Array<{ agent_id: string; name: string; content: string }> = []

  while (remaining.length > 0) {
    if (signal?.aborted) break

    const agentId = remaining.shift()!
    if (repliedAgents.has(agentId)) continue

    const agent = await getAgent(agentId)
    if (!agent) {
      console.warn(`Group chat: agent ${agentId} not found, skipping`)
      continue
    }

    // Send agent_start event
    send({ type: 'agent_start', agent_id: agentId, agent_name: agent.name })

    // Reset mention signal for this agent
    const mentionSignal: MentionSignal = {
      triggered: false,
      agentNames: [],
      message: null,
    }

    // Consume mention signal for this agent, then reset
    const currentMentionedBy = mentionedBy
    mentionedBy = undefined

    // ---- Build per-agent history ----
    // 自己的发言保持 assistant 角色，别人的转为 user 角色 + 名字前缀。
    // 这样模型能正确区分「自己说过的话」与「别人说过的话」，
    // 解决多轮群聊中 Agent 身份认同混乱的问题。
    const perAgentHistory: ChatMessage[] = [
      // DB 历史：按当前 Agent 视角转换
      ...prepareGroupHistory(baseHistory, agentNameById, agentId),
      // 本轮其他 Agent 的发言：自己的保持 assistant，别人的转 user + [Name]:
      ...turnReplies.map((r) => {
        if (r.agent_id === agentId) {
          return {
            role: 'assistant' as const,
            content: r.content,
            agent_id: r.agent_id,
          }
        }
        return {
          role: 'user' as const,
          content: `[${r.name}]: ${r.content}`,
        }
      }),
    ]

    try {
      // Determine speaking role for this agent
      const speakingRole = agentId === protagonistAgentId ? 'protagonist' as const
        : protagonistAgentId ? 'supporting' as const
        : undefined
      const protagonistName = protagonistAgentId
        ? agentNameById.get(protagonistAgentId)
        : undefined

      const { reply, suggestions, thinking, artifacts, trace } = await runPiAgentLoop({
        userMessage,
        history: perAgentHistory,
        send: (msg: ServerMessage) => {
          send({ ...msg, agent_id: agentId, agent_name: agent.name } as ServerMessage)
        },
        signal,
        thinkingMode,
        conversationId,
        userId,
        agentId,
        mentionSignal,
        isGroup: true,
        agentName: agent.name,
        groupAgentNames: Array.from(agentNameById.values()),
        mentionedBy: currentMentionedBy,
        speakingRole,
        protagonistName,
        language,
      })

      repliedAgents.add(agentId)

      // Save the agent's message to DB
      if (reply) {
        await saveMessage(agentId, agent.name, reply, thinking, suggestions, artifacts, trace)
      }

      // Record this agent's reply so subsequent agents see it
      // in their per-agent history (as [Name]: content in user role)
      if (reply) {
        turnReplies.push({ agent_id: agentId, name: agent.name, content: reply })
      }

      // Send agent_done event
      send({
        type: 'agent_done',
        agent_id: agentId,
        agent_name: agent.name,
        reply: reply || '',
        suggestions,
      })

      // Check for @mention signal
      if (mentionSignal.triggered && mentionSignal.agentNames.length > 0) {
        mentionDepth++
        if (mentionDepth > MAX_MENTION_REDIRECTS) {
          console.warn('Group chat: max mention redirects reached, stopping')
          break
        }

        // Resolve all mentioned agent names to IDs
        const resolved = new Set<string>()
        for (const name of mentionSignal.agentNames) {
          const id = await resolveAgentByName(name, agentNameById)
          if (id) resolved.add(id)
        }

        if (resolved.size > 0) {
          for (const id of resolved) {
            // Allow bonus reply for agents who already spoke
            if (repliedAgents.has(id)) {
              repliedAgents.delete(id)
            }
          }
          // Insert all mentioned agents at the front, preserving their order in the call
          remaining = [...resolved, ...remaining.filter(id => !resolved.has(id))]
          // Pass who mentioned them so the agents' system prompts can acknowledge it
          mentionedBy = agent.name
        }
      }
    } catch (err) {
      console.error(`Group chat: agent ${agent.name} (${agentId}) failed:`, (err as Error).message)
      repliedAgents.add(agentId)
      send({
        type: 'agent_done',
        agent_id: agentId,
        agent_name: agent.name,
        reply: `（${agent.name} 回复失败：${(err as Error).message}）`,
        suggestions: [],
      })
      // Continue with next agent
    }
  }

  send({ type: 'group_done' })
}

/**
 * Parse user message for @AgentName patterns and return matching agent IDs.
 * Agents are returned in the order they appear in the message.
 *
 * Handles fuzzy matching:
 * - @巧克力你好 → progressively truncates "巧克力你好" → "巧克力你" → "巧克力" matches!
 * - @巧克 (incomplete) → agent name "巧克力" contains "巧克" → matches!
 * - @巧 (too short, ambiguous) → skipped (minimum 2 chars for fuzzy match)
 */
function parseUserMentions(userMessage: string, agentNameById: Map<string, string>): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  // Match @ followed by word characters or CJK characters
  const mentionRe = /@([\w一-鿿぀-ゟ゠-ヿ]+)/g
  let match: RegExpExecArray | null
  while ((match = mentionRe.exec(userMessage)) !== null) {
    const rawName = match[1].trim()
    const agentId = findBestAgentMatch(rawName, agentNameById)
    if (agentId && !seen.has(agentId)) {
      seen.add(agentId)
      result.push(agentId)
    }
  }
  return result
}

/**
 * Try to match a raw name string against known agent names using progressive truncation.
 *
 * Strategy: start with the full matched string, then try progressively shorter prefixes.
 * This handles cases like "@巧克力你好" where the regex greedily matches too much.
 *
 * For each prefix, we try:
 * 1. Exact match (case-insensitive, trimmed)
 * 2. Agent name contains prefix (fuzzy, min 2 chars to avoid false positives)
 *
 * Returns the first matching agent ID, or null if no match.
 */
function findBestAgentMatch(rawName: string, agentNameById: Map<string, string>): string | null {
  // Progressive truncation: try from longest to shortest prefix
  for (let len = rawName.length; len >= 1; len--) {
    const prefix = rawName.slice(0, len).toLowerCase().trim()
    if (!prefix) continue

    // 1. Exact match
    for (const [id, agentName] of agentNameById) {
      if (agentName.toLowerCase().trim() === prefix) {
        return id
      }
    }

    // 2. Fuzzy: agent name contains the prefix (only for substantial prefixes)
    // Extreme case: if user types "@巧克" and there's "巧克力Bonbon",
    // we still match because agent name contains the prefix.
    if (prefix.length >= 2) {
      for (const [id, agentName] of agentNameById) {
        if (agentName.toLowerCase().includes(prefix)) {
          return id
        }
      }
    }
  }
  return null
}

async function resolveAgentByName(name: string, agentNameById: Map<string, string>): Promise<string | null> {
  return findBestAgentMatch(name, agentNameById)
}