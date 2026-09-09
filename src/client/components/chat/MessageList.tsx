import { MessageBubble } from './MessageBubble'
import type { Attachment, ThinkingSegment } from '@/shared/types'

interface ChatMessage {
  id?: number
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  thinkingSegments?: ThinkingSegment[]
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
}

export function MessageList({ messages, onSuggestion, onRevert, agentAvatar, agents }: MessageListProps) {
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
        // Resolve agent avatar for group messages
        let msgAgentAvatar = agentAvatar
        let msgAgentName: string | undefined
        if (agents && msg.agent_id) {
          const agent = agents.find((a) => a.id === msg.agent_id)
          if (agent) {
            msgAgentAvatar = agent.avatar || undefined
            msgAgentName = agent.name
          }
        }
        return (
          <MessageBubble
            key={msg.id || idx}
            message={msg}
            onSuggestion={onSuggestion}
            showSuggestions={idx === lastAssistantIdxFromEnd}
            onRevert={msg.role === 'user' && msg.id ? () => onRevert?.(idx) : undefined}
            agentAvatar={msgAgentAvatar}
            agentName={msgAgentName || msg.agent_name || undefined}
          />
        )
      })}
    </div>
  )
}
