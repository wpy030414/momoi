import { MessageBubble } from './MessageBubble'
import type { Attachment, ThinkingSegment } from '@/shared/types'

interface ChatMessage {
  id?: number
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  thinkingSegments?: ThinkingSegment[]
  toolCalls?: Array<{ id?: string; name: string; input: Record<string, unknown>; status?: 'running' | 'done' | 'error'; result?: string }>
  suggestions?: string[]
  attachments?: Attachment[]
  streaming?: boolean
}

interface MessageListProps {
  messages: ChatMessage[]
  onSuggestion?: (text: string) => void
  onRevert?: (index: number) => void
  agentAvatar?: string | null
}

export function MessageList({ messages, onSuggestion, onRevert, agentAvatar }: MessageListProps) {
  // Only the last assistant message shows its suggestion chips — older ones
  // were for a past turn and are meaningless as "what to ask next".
  const lastAssistantIdx = [...messages]
    .reverse()
    .findIndex((m) => m.role === 'assistant')
  const lastAssistantIdxFromEnd =
    lastAssistantIdx === -1 ? -1 : messages.length - 1 - lastAssistantIdx

  return (
    <div className="space-y-4 max-w-3xl mx-auto">
      {messages.map((msg, idx) => (
        <MessageBubble
          key={msg.id || idx}
          message={msg}
          onSuggestion={onSuggestion}
          showSuggestions={idx === lastAssistantIdxFromEnd}
          onRevert={msg.role === 'user' && msg.id ? () => onRevert?.(idx) : undefined}
          agentAvatar={agentAvatar}
        />
      ))}
    </div>
  )
}
