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

function findAgentIdByName(name: string, agentIds: string[]): string | null {
  // Simple case-insensitive match — we'll need to resolve via getAgent for exact match
  return null // Will be resolved by the orchestrator via getAgent
}

export async function orchestrateGroupChat(options: GroupOrchestratorOptions): Promise<void> {
  const { userMessage, history, send, signal, thinkingMode, conversationId, userId, agentIds, saveMessage } = options

  // Shuffle agent order for natural conversation feel
  const shuffled = agentIds.length > 1
    ? [agentIds[0], ...shuffleArray(agentIds.slice(1))]
    : [...agentIds]

  send({ type: 'group_start', agent_ids: shuffled })

  const repliedAgents = new Set<string>()
  let remaining = [...shuffled]
  let mentionDepth = 0

  // Accumulate history so each agent sees previous agents' replies
  const accumulatedHistory: ChatMessage[] = [...history]

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
      )

      repliedAgents.add(agentId)

      // Save the agent's message to DB
      if (reply) {
        await saveMessage(agentId, agent.name, reply, thinking, suggestions, artifacts)
      }

      // Append this agent's reply to the accumulated history
      // so subsequent agents can see what was said before them
      accumulatedHistory.push({
        role: 'assistant',
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