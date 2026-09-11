// ============================================================
// Group Chat Orchestrator — Multi-agent serial conversation
// ============================================================

import { runPiAgentLoop } from './pi-adapter.js'
import type { ChatMessage, ContentPart } from './provider.js'
import type { ServerMessage, Agent } from '../../shared/types.js'
import type { ToolArtifact } from '../tools/types.js'
import type { MentionSignal } from '../tools/group-mention-tool.js'
import { getAgent, getConfig } from '../config.js'
import { decideGroupParticipants, type GroupSkipHint } from './neutral-agent.js'
import { NEUTRAL_AGENT_ID } from '../../shared/constants.js'

const MAX_MENTION_REDIRECTS = 5

// ---- 本轮发言调度（中立 Agent 裁决）----
const DECISION_TIMEOUT_MS = 10_000
const SKIP_HINT_TTL_MS = 10 * 60_000
const MAX_TRACKED_CONVERSATIONS = 200

/** 上一轮未参与的成员（内存态，重启失效；带 TTL，仅作下一轮裁决的提示） */
const previousSkipsByConversation = new Map<string, { at: number; skips: GroupSkipHint[] }>()

function rememberSkips(conversationId: string, skips: GroupSkipHint[]): void {
  previousSkipsByConversation.delete(conversationId)
  if (skips.length === 0) return
  previousSkipsByConversation.set(conversationId, { at: Date.now(), skips })
  while (previousSkipsByConversation.size > MAX_TRACKED_CONVERSATIONS) {
    const oldest = previousSkipsByConversation.keys().next().value
    if (oldest === undefined) break
    previousSkipsByConversation.delete(oldest)
  }
}

function recallSkips(conversationId: string): GroupSkipHint[] | undefined {
  const entry = previousSkipsByConversation.get(conversationId)
  if (!entry) return undefined
  if (Date.now() - entry.at > SKIP_HINT_TTL_MS) {
    previousSkipsByConversation.delete(conversationId)
    return undefined
  }
  return entry.skips
}

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
 * 群聊上下文格式化：
 * 把历史中「其他 Agent 产生的 assistant 消息」重写为
 * `[Agent名字]: 内容` 的 user 角色消息。
 *
 * 原因：模型会把 assistant 角色消息当作「自己说过的话」，
 * 导致后续 Agent 复述/延续他人内容（群聊回复雷同）。
 * 以 user 角色 + 名字前缀注入后，模型能明确区分「他人发言」与「用户提问」，
 * 从而给出自己视角的独立回答。无 agent_id 的旧消息保持原样。
 */
function prepareGroupHistory(history: ChatMessage[], agentNameById: Map<string, string>): ChatMessage[] {
  return history.map((msg) => {
    if (msg.role === 'assistant' && msg.agent_id) {
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

  // ---- 本轮发言调度：中立 Agent 裁决哪些成员不需要参与 ----
  // 失败开放：任何异常 / 超时 / 空结果都退回「全员参与」（本功能引入前的行为）。
  const skippedIds = new Set<string>()
  const skippedHints: GroupSkipHint[] = []
  const shouldDecide =
    agentNameById.size > 1 &&
    history.length > 0 &&
    userMentionedIds.length < agentIds.length

  if (shouldDecide) {
    const startedAt = Date.now()
    try {
      const [config, neutralAgent] = await Promise.all([
        getConfig(),
        getAgent(NEUTRAL_AGENT_ID),
      ])
      const model = neutralAgent?.model || agentsById.get(agentIds[0])?.model || 'gpt-4o'

      // 超时保护：裁决位于首个 agent_start 之前，必须给等待设上限
      let timer: ReturnType<typeof setTimeout> | undefined
      let timedOut = false
      let skips: GroupSkipHint[] | null = null
      try {
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => { timedOut = true; resolve(null) }, DECISION_TIMEOUT_MS)
        })
        skips = await Promise.race([
          decideGroupParticipants(
            config,
            model,
            {
              conversationContext: formatDecisionContext(history, userMessage, agentNameById),
              memberNames: Array.from(agentNameById.values()),
              previousSkips: recallSkips(conversationId),
            },
            neutralAgent?.system_prompt?.trim() || undefined,
          ),
          timeout,
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }

      if (skips === null) {
        // 瞬时故障不清上一轮记忆，下一轮仍可拿到提示
        console.warn(`Group chat: orchestration ${timedOut ? 'timed out' : 'failed'} after ${Date.now() - startedAt}ms, all agents will reply`)
      } else {
        for (const hint of skips) {
          const id = await resolveAgentByName(hint.name, agentNameById)
          if (!id || skippedIds.has(id)) continue
          if (userMentionedIds.includes(id)) continue // 用户点名者强制参与
          skippedIds.add(id)
          skippedHints.push({ name: agentNameById.get(id)!, reason: hint.reason })
        }

        // 弱模型可能回显整个名册：全跳过一律作废，失败开放
        if (skippedIds.size > 0 && skippedIds.size >= agentNameById.size) {
          console.warn('Group chat: orchestration skipped every member, falling back to all')
          skippedIds.clear()
          skippedHints.length = 0
        }

        rememberSkips(conversationId, skippedHints)
        console.log(skippedHints.length > 0
          ? `Group chat: orchestration skipped ${skippedHints.map((s) => (s.reason ? `${s.name}(${s.reason})` : s.name)).join(', ')} (${Date.now() - startedAt}ms)`
          : `Group chat: orchestration skipped none (${Date.now() - startedAt}ms)`)
      }
    } catch (err) {
      // 裁决失败不影响本轮：全员参与
      console.error('Group chat: orchestration failed, all agents will reply:', (err as Error).message)
    }
  }

  const participants = skippedIds.size > 0
    ? agentIds.filter((id) => !skippedIds.has(id))
    : [...agentIds]

  // Shuffle agent order for natural conversation feel
  const shuffled = participants.length > 1
    ? [participants[0], ...shuffleArray(participants.slice(1))]
    : [...participants]

  send({ type: 'group_start', agent_ids: shuffled })

  const repliedAgents = new Set<string>()
  let remaining = [...shuffled]
  let mentionDepth = 0
  let mentionedBy: string | undefined = undefined

  // Insert user-mentioned agents at the front, preserving their order in the message
  if (userMentionedIds.length > 0) {
    for (const mid of [...userMentionedIds].reverse()) {
      remaining = [mid, ...remaining.filter(id => id !== mid)]
    }
    // Set mentionedBy to "user" so the system prompt can acknowledge it
    mentionedBy = '用户'
  }

  // Accumulate history so each agent sees previous agents' replies.
  // 其他 Agent 的发言统一转为 `[名字]: 内容` 的 user 消息，
  // 避免模型将其误认为「自己说过的话」而复述/照抄。
  const accumulatedHistory: ChatMessage[] = prepareGroupHistory(history, agentNameById)

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

    try {
      const { reply, suggestions, thinking, artifacts } = await runPiAgentLoop({
        userMessage,
        history: accumulatedHistory,
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
        language,
      })

      repliedAgents.add(agentId)

      // Save the agent's message to DB
      if (reply) {
        await saveMessage(agentId, agent.name, reply, thinking, suggestions, artifacts)
      }

      // Append this agent's reply to the accumulated history
      // so subsequent agents can see what was said before them.
      // NOTE: use user role + `[名字]: ` prefix — assistant role would make
      // the model treat it as its own words and repeat/parrot it.
      accumulatedHistory.push({
        role: 'user',
        content: `[${agent.name}]: ${reply}`,
      })

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