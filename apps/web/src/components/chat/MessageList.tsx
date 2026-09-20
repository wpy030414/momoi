import { MessageBubble } from './MessageBubble'
import type { Attachment } from '@momoi/shared/types'

interface ChatMessage {
  id?: number
  role: 'user' | 'assistant'
  content: string
  toolCalls?: Array<{ id?: string; name: string; input: Record<string, unknown>; status?: 'running' | 'done' | 'error'; result?: string; artifacts?: Array<{ filename: string; displayName: string; mimeType: string; downloadUrl: string }> }>
  suggestions?: string[]
  attachments?: Attachment[]
  streaming?: boolean
  agent_id?: string | null
  agent_name?: string | null
}

interface AgentBrief {
  id: string
  name: string
  avatar: string
}

interface MessageListProps {
  messages: ChatMessage[]
  onSuggestion?: (text: string) => void
  onRevert?: (index: number) => void
  agentAvatar?: string | null
  /** Group chat: agent lookup by id */
  agents?: AgentBrief[]
  /** Direct chat: fallback display name for messages without agent_id（历史消息 / 流式气泡） */
  fallbackAgentName?: string
  /** Direct chat: whether the active agent has voice enabled */
  agentVoiceEnabled?: boolean
  /** All agents voice_enabled lookup (group chat) */
  agentVoiceMap?: Map<string, boolean>
  /** Show thinking details in messages */
  verbose?: boolean
  /** QQ group: single-agent group where users are real humans → show sender labels */
  isQqGroup?: boolean
}

/** Parse `[senderName]: rest` from user messages in QQ groups. Returns null if no match. */
function parseQqSender(content: string): { senderName: string; cleanContent: string } | null {
  const m = content.match(/^\[([^\]]+)\]:\s(.*)$/s)
  if (!m) return null
  return { senderName: m[1], cleanContent: m[2] }
}

export function MessageList({ messages, onSuggestion, onRevert, agentAvatar, agents, fallbackAgentName, agentVoiceEnabled, agentVoiceMap, verbose, isQqGroup }: MessageListProps) {
  // Only the last assistant message shows its suggestion chips — older ones
  // were for a past turn and are meaningless as "what to ask next".
  const lastAssistantIdx = [...messages]
    .reverse()
    .findIndex((m) => m.role === 'assistant')
  const lastAssistantIdxFromEnd =
    lastAssistantIdx === -1 ? -1 : messages.length - 1 - lastAssistantIdx

  return (
    <div className="space-y-2 max-w-3xl mx-auto">
      {messages.map((msg, idx) => {
        // QQ group: parse [senderName]: content for user messages
        let displayContent = msg.content
        let senderName: string | undefined
        if (isQqGroup && msg.role === 'user') {
          const parsed = parseQqSender(msg.content)
          if (parsed) {
            senderName = parsed.senderName
            displayContent = parsed.cleanContent
          }
        }

        // Resolve agent avatar for group messages
        let msgAgentAvatar = agentAvatar
        let msgAgentName: string | undefined = senderName
        let msgVoiceEnabled = agentVoiceEnabled ?? false
        let msgAgentId: string | undefined
        if (agents && msg.agent_id) {
          const agent = agents.find((a) => a.id === msg.agent_id)
          if (agent) {
            msgAgentAvatar = agent.avatar || undefined
            msgAgentName = agent.name
            msgVoiceEnabled = (agent as any).voice_enabled ?? agentVoiceMap?.get(agent.id) ?? false
            msgAgentId = agent.id
          }
        } else if (!msg.agent_id && agentVoiceMap) {
          // Direct chat: use the active agent's voice_enabled
          // agentVoiceMap only has entries for known agents, so check first entry
          msgVoiceEnabled = agentVoiceEnabled ?? false
        }
        // For direct chat, get agent ID from the message's agent_id if available
        if (!msgAgentId && msg.agent_id) {
          msgAgentId = msg.agent_id
        }
        return (
          <MessageBubble
            key={msg.id || idx}
            message={{ ...msg, content: displayContent }}
            onSuggestion={onSuggestion}
            showSuggestions={idx === lastAssistantIdxFromEnd}
            onRevert={msg.role === 'user' ? () => onRevert?.(idx) : undefined}
            agentAvatar={msgAgentAvatar}
            agentName={msgAgentName || msg.agent_name || (msg.role === 'user' && !isQqGroup ? undefined : fallbackAgentName)}
            voiceEnabled={msgVoiceEnabled}
            activeAgentId={msgAgentId}
            verbose={verbose}
          />
        )
      })}
    </div>
  )
}
