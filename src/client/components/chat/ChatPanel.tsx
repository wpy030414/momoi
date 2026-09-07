import { useState, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
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

interface ChatPanelProps {
  messages: ChatMessage[]
  loading: boolean
  onSend: (text: string, thinkingMode?: boolean, attachments?: Array<{ url: string; name: string; size: number; type: string }>, agentId?: string | null) => void | Promise<void>
  onCancel: () => void
  onRevert: (index: number) => Promise<string | null>
  backgroundImage?: string
  supportAttachments?: boolean
  agents?: Array<{ id: string; name: string; avatar: string }>
  selectedAgentId?: string | null
  onAgentChange?: (id: string) => void
}

export function ChatPanel({ messages, loading, onSend, onCancel, onRevert, backgroundImage, supportAttachments, agents, selectedAgentId, onAgentChange }: ChatPanelProps) {
  const { t } = useTranslation()
  const bottomRef = useRef<HTMLDivElement>(null)
  const [revertedText, setRevertedText] = useState<string>('')
  const [thinkingMode, setThinkingMode] = useState<boolean>(true)

  const hasMessages = messages.length > 0
  const hasAgents = agents && agents.length > 0
  const selectedAgentAvatar = selectedAgentId ? agents?.find((a) => a.id === selectedAgentId)?.avatar : null
  const selectedAgentName = selectedAgentId ? agents?.find((a) => a.id === selectedAgentId)?.name : null

  // Time-of-day greeting
  const timeGreeting = useMemo(() => {
    const hour = new Date().getHours()
    if (hour < 12) return t('chat.greetingMorning')
    if (hour < 18) return t('chat.greetingAfternoon')
    return t('chat.greetingEvening')
  }, [t])

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
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
    onSend(text, thinkingMode, attachments, selectedAgentId)
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
      <div className="flex-1 overflow-y-auto px-4 py-4 relative z-10">
        {!hasMessages ? (
          /* Empty state: greeting + agent selector + input, left-aligned */
          <div className="flex items-center justify-center h-full">
            <div className="w-full max-w-3xl">
              {/* Greeting line: "<time>好，我是<Agent selector>" */}
              <div className="mb-4 px-4">
                {hasAgents ? (
                  <h2 className="text-xl font-semibold flex items-center gap-1 flex-wrap">
                    <span>{timeGreeting}{t('chat.greetingSuffix')}</span>
                    <select
                      value={selectedAgentId || ''}
                      onChange={(e) => {
                        onAgentChange?.(e.target.value)
                      }}
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

              {loading ? (
                <div className="px-4">
                  <button
                    onClick={onCancel}
                    className="w-full h-10 rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
                  >
                    {t('chat.stopGenerating')}
                  </button>
                </div>
              ) : (
                <InputBar
                  onSend={handleSend}
                  disabled={loading}
                  externalValue={revertedText}
                  onExternalValueConsumed={handleExternalValueConsumed}
                  thinkingMode={thinkingMode}
                  onThinkingModeChange={setThinkingMode}
                  supportAttachments={supportAttachments}
                  noAgents={!hasAgents}
                />
              )}
            </div>
          </div>
        ) : (
          <MessageList messages={messages} onSuggestion={handleSend} onRevert={handleRevert} agentAvatar={selectedAgentAvatar} />
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area — bottom-sticky, only when conversation has started */}
      {hasMessages && (
        <div className="relative z-10">
          {loading ? (
            <div className="max-w-3xl mx-auto w-full px-4 pb-4">
              <button
                onClick={onCancel}
                className="w-full h-10 rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors"
              >
                {t('chat.stopGenerating')}
              </button>
            </div>
          ) : (
            <InputBar
              onSend={handleSend}
              disabled={loading}
              externalValue={revertedText}
              onExternalValueConsumed={handleExternalValueConsumed}
              thinkingMode={thinkingMode}
              onThinkingModeChange={setThinkingMode}
              supportAttachments={supportAttachments}
              noAgents={!hasAgents}
            />
          )}
        </div>
      )}
    </div>
  )
}
