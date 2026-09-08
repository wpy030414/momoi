import { useState, useRef, useLayoutEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
import type { Attachment, ThinkingSegment } from '@/shared/types'

interface AgentBrief {
  id: string
  name: string
  avatar: string
}

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

interface ChatPanelProps {
  messages: ChatMessage[]
  loading: boolean
  onSend: (text: string, thinkingMode?: boolean, attachments?: Array<{ url: string; name: string; size: number; type: string }>, agentId?: string | null, groupMode?: boolean, groupAgentIds?: string[], infiniteMode?: boolean) => void | Promise<void>
  onCancel: () => void
  onRevert: (index: number) => Promise<string | null>
  backgroundImage?: string
  supportAttachments?: boolean
  agents?: AgentBrief[]
  selectedAgentId?: string | null
  onAgentChange?: (id: string) => void
  /** Group chat mode */
  isGroup?: boolean
  groupAgents?: AgentBrief[]
  onSendGroup?: (text: string, thinkingMode: boolean, attachments?: Array<{ url: string; name: string; size: number; type: string }>, infiniteMode?: boolean) => void
  /** Infinite mode */
  infiniteMode?: boolean
  onInfiniteModeChange?: (enabled: boolean) => void
}

export function ChatPanel({
  messages, loading, onSend, onCancel, onRevert, backgroundImage, supportAttachments,
  agents, selectedAgentId, onAgentChange,
  isGroup, groupAgents, onSendGroup,
  infiniteMode = false, onInfiniteModeChange,
}: ChatPanelProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const prevFirstIdRef = useRef<number | undefined>(undefined)
  // Track whether the user is scrolled near the bottom — updated by onScroll.
  // Stored in a ref so useLayoutEffect can read it before the browser paints
  // (by that point scrollHeight has grown but scrollTop hasn't, so computing
  // "atBottom" inside the effect is always wrong).
  const atBottomRef = useRef(true)
  const [revertedText, setRevertedText] = useState<string>('')
  const [thinkingMode, setThinkingMode] = useState<boolean>(true)

  const hasMessages = messages.length > 0
  const hasAgents = agents && agents.length > 0
  const selectedAgentAvatar = selectedAgentId ? agents?.find((a) => a.id === selectedAgentId)?.avatar : null

  // Time-of-day greeting
  const timeGreeting = useMemo(() => {
    const hour = new Date().getHours()
    if (hour < 12) return t('chat.greetingMorning')
    if (hour < 18) return t('chat.greetingAfternoon')
    return t('chat.greetingEvening')
  }, [t])

  // Track scroll position — fires before the next layout effect,
  // so atBottomRef is always accurate when we decide whether to pin.
  // Threshold: 10% of visible height (not absolute px), so it scales
  // with window size and long chats.
  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const threshold = el.clientHeight * 0.1
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
  }, [])

  // Pin to bottom instantly. Two cases:
  // 1. Conversation switch → always scroll to bottom.
  // 2. Messages changed (streaming / user sent) → only scroll if the
  //    user was already at the bottom (within 10% of visible height).
  //    Once the user scrolls up, we stop dragging them.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return

    const firstId = messages[0]?.id
    const isSwitch = messages.length > 0 && firstId !== prevFirstIdRef.current
    prevFirstIdRef.current = firstId

    if (isSwitch || atBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  const handleRevert = async (index: number) => {
    const text = await onRevert(index)
    if (text) {
      setRevertedText(text)
    }
  }

  const handleExternalValueConsumed = () => {
    setRevertedText('')
  }

  const handleSend = (text: string, attachments?: Array<{ url: string; name: string; size: number; type: string }>) => {
    if (isGroup && onSendGroup) {
      onSendGroup(text, thinkingMode, attachments, infiniteMode)
    } else {
      onSend(text, thinkingMode, attachments, selectedAgentId, false, undefined, infiniteMode)
    }
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      {/* Background image layer */}
      {backgroundImage && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `url(${backgroundImage})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            opacity: 0.2,
          }}
        />
      )}

      {/* Messages area */}
      <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-4 relative z-10">
        {!hasMessages ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-full max-w-3xl">
              <div className="mb-4 px-4">
                {isGroup ? (
                  <h2 className="text-xl font-semibold">{t('chat.groupGreeting')}</h2>
                ) : hasAgents ? (
                  <h2 className="text-xl font-semibold flex items-center gap-1 flex-wrap">
                    <span>{timeGreeting}{t('chat.greetingSuffix')}</span>
                    <select
                      value={selectedAgentId || ''}
                      onChange={(e) => onAgentChange?.(e.target.value)}
                      className="text-xl font-semibold bg-transparent border-none outline-none cursor-pointer text-primary underline underline-offset-4 decoration-primary/30 hover:decoration-primary"
                    >
                      {agents!.map((a) => (
                        <option key={a.id} value={a.id} className="text-base">{a.name}</option>
                      ))}
                    </select>
                  </h2>
                ) : (
                  <h2 className="text-xl font-semibold text-destructive">{t('settings.agentRequired')}</h2>
                )}
              </div>

              {loading ? <div className="px-4"><div className="h-10" /></div> : null}
              <InputBar
                onSend={handleSend}
                disabled={loading}
                externalValue={revertedText}
                onExternalValueConsumed={handleExternalValueConsumed}
                thinkingMode={thinkingMode}
                onThinkingModeChange={setThinkingMode}
                infiniteMode={infiniteMode}
                onInfiniteModeChange={onInfiniteModeChange || (() => {})}
                supportAttachments={supportAttachments}
                noAgents={!isGroup && !hasAgents}
              />
            </div>
          </div>
        ) : (
          <MessageList
            messages={messages}
            onSuggestion={(text) => {
              if (isGroup && onSendGroup) onSendGroup(text, thinkingMode, undefined, infiniteMode)
              else onSend(text, thinkingMode, undefined, selectedAgentId, false, undefined, infiniteMode)
            }}
            onRevert={handleRevert}
            agentAvatar={isGroup ? null : selectedAgentAvatar}
            agents={isGroup ? (groupAgents || []) : undefined}
          />
        )}
      </div>

      {/* Input area */}
      {hasMessages && (
        <div className="relative z-10">
          <InputBar
            onSend={handleSend}
            disabled={loading}
            externalValue={revertedText}
            onExternalValueConsumed={handleExternalValueConsumed}
            thinkingMode={thinkingMode}
            onThinkingModeChange={setThinkingMode}
            infiniteMode={infiniteMode}
            onInfiniteModeChange={onInfiniteModeChange || (() => {})}
            supportAttachments={supportAttachments}
            noAgents={!isGroup && !hasAgents}
          />
        </div>
      )}
    </div>
  )
}