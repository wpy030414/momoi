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
      agentName: null,
      message: null,
    }

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
      if (mentionSignal.triggered && mentionSignal.agentName) {
        mentionDepth++
        if (mentionDepth > MAX_MENTION_REDIRECTS) {
          console.warn('Group chat: max mention redirects reached, stopping')
          break
        }

        // Find the target agent by name
        const targetAgentId = await resolveAgentByName(mentionSignal.agentName, agentIds)
        if (targetAgentId && !repliedAgents.has(targetAgentId)) {
          // Clear remaining queue — only the mentioned agent replies
          remaining = [targetAgentId]
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

async function resolveAgentByName(name: string, agentIds: string[]): Promise<string | null> {
  const lowerName = name.toLowerCase().trim()
  for (const id of agentIds) {
    const agent = await getAgent(id)
    if (agent && agent.name.toLowerCase().trim() === lowerName) {
      return id
    }
  }
  // Fuzzy match: name contains
  for (const id of agentIds) {
    const agent = await getAgent(id)
    if (agent && agent.name.toLowerCase().includes(lowerName)) {
      return id
    }
  }
  return null
}