// ============================================================
// Group Chat Orchestrator — Multi-agent serial conversation
// ============================================================

import { runPiAgentLoop } from './pi-adapter.js'
import type { ChatMessage, ContentPart } from './provider.js'
import type { ServerMessage } from '../../shared/types.js'
import type { ToolArtifact } from '../tools/types.js'
import type { MentionSignal } from '../tools/group-mention-tool.js'
import { getAgent } from '../config.js'

const MAX_MENTION_REDIRECTS = 5

interface GroupOrchestratorOptions {
  userMessage: string | ContentPart[]
  history: ChatMessage[]
  send: (msg: ServerMessage) => void
  signal?: AbortSignal
  thinkingMode: boolean
  conversationId: string
  userId: string
  agentIds: string[]
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

export async function orchestrateGroupChat(options: GroupOrchestratorOptions): Promise<void> {
  const { userMessage, history, send, signal, thinkingMode, conversationId, userId, agentIds, saveMessage } = options

  // Shuffle agent order for natural conversation feel
  const shuffled = agentIds.length > 1
    ? [agentIds[0], ...shuffleArray(agentIds.slice(1))]
    : [...agentIds]

  send({ type: 'group_start', agent_ids: shuffled })

  // Preload agent name map (parallel, avoids repeated getAgent calls in the loop)
  const agentNameById = new Map<string, string>()
  await Promise.all(
    agentIds.map(async (id) => {
      const agent = await getAgent(id)
      if (agent) agentNameById.set(id, agent.name)
    }),
  )

  const repliedAgents = new Set<string>()
  let remaining = [...shuffled]
  let mentionDepth = 0
  let mentionedBy: string | null = null

  // Parse user message for @AgentName mentions — insert them to the front of the queue
  if (typeof userMessage === 'string') {
    const userMentions = parseUserMentions(userMessage, agentNameById)
    if (userMentions.length > 0) {
      // Insert mentioned agents at the front, preserving their order in the user message,
      // and deduplicate (remove from later positions in remaining)
      for (const mid of userMentions.reverse()) {
        remaining = [mid, ...remaining.filter(id => id !== mid)]
      }
      // Set mentionedBy to "user" so the system prompt can acknowledge it
      mentionedBy = '用户'
    }
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
    mentionedBy = null

    try {
      const { reply, suggestions, thinking, artifacts } = await runPiAgentLoop(
        userMessage,
        accumulatedHistory,
        (msg: ServerMessage) => {
          send({ ...msg, agent_id: agentId, agent_name: agent.name } as ServerMessage)
        },
        signal,
        thinkingMode,
        conversationId,
        userId,
        agentId,
        mentionSignal,
        true, // isGroup
        false, // infiniteMode
        agent.name,
        Array.from(agentNameById.values()),
        currentMentionedBy,
      )

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