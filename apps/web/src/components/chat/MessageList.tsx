import React, { useMemo } from 'react'
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
  onForceRetry?: (index: number) => void
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

export const MessageList = React.memo(function MessageList({ messages, onSuggestion, onRevert, onForceRetry, agentAvatar, agents, fallbackAgentName, agentVoiceEnabled, agentVoiceMap, verbose, isQqGroup }: MessageListProps) {
  // Only the last assistant message shows its suggestion chips — older ones
  // were for a past turn and are meaningless as "what to ask next".
  const lastAssistantIdx = [...messages]
    .reverse()
    .findIndex((m) => m.role === 'assistant')
  const lastAssistantIdxFromEnd =
    lastAssistantIdx === -1 ? -1 : messages.length - 1 - lastAssistantIdx

  // Pre-compute display info for each message so we pass stable objects to
  // React.memo-wrapped MessageBubble instead of inline spreads.
  const displayMessages = useMemo(() =>
    messages.map((msg, idx) => {
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
        msgVoiceEnabled = agentVoiceEnabled ?? false
      }
      if (!msgAgentId && msg.agent_id) {
        msgAgentId = msg.agent_id
      }

      return {
        msg,
        idx,
        displayContent,
        senderName,
        msgAgentAvatar,
        msgAgentName: msgAgentName || msg.agent_name || (msg.role === 'user' && !isQqGroup ? undefined : fallbackAgentName),
        msgVoiceEnabled,
        msgAgentId,
        showSuggestions: idx === lastAssistantIdxFromEnd,
      }
    }), [messages, isQqGroup, agents, agentAvatar, agentVoiceEnabled, agentVoiceMap, fallbackAgentName, lastAssistantIdxFromEnd])

  return (
    <div className="space-y-2 max-w-3xl mx-auto">
      {displayMessages.map(({ msg, idx, displayContent, msgAgentAvatar, msgAgentName, msgVoiceEnabled, msgAgentId, showSuggestions }) => (
        <MessageBubble
          key={msg.id != null ? `db-${msg.id}` : `idx-${idx}`}
          message={{ ...msg, content: displayContent }}
          onSuggestion={onSuggestion}
          showSuggestions={showSuggestions}
          onRevert={msg.role === 'user' ? () => onRevert?.(idx) : undefined}
          onForceRetry={msg.role === 'user' ? () => onForceRetry?.(idx) : undefined}
          agentAvatar={msgAgentAvatar}
          agentName={msgAgentName}
          voiceEnabled={msgVoiceEnabled}
          activeAgentId={msgAgentId}
          verbose={verbose}
        />
      ))}
    </div>
  )
})