import { useState, useRef, useLayoutEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
import { QuestionBar } from './QuestionBar'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import type { Attachment, AskUserQuestion } from '@momoi/shared/types'

interface AgentBrief {
  id: string
  name: string
  avatar: string
  voice_enabled?: boolean
}

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

interface ChatPanelProps {
  messages: ChatMessage[]
  loading: boolean
  onSend: (text: string, thinkingMode?: boolean, attachments?: Array<{ url: string; name: string; size: number; type: string }>, agentId?: string | null, groupMode?: boolean, groupAgentIds?: string[], infiniteMode?: boolean) => void | Promise<void>
  onCancel: () => void
  onRevert: (index: number) => Promise<string | null>
  onForceRetry?: (index: number) => Promise<void>
  backgroundImage?: string
  supportAttachments?: boolean
  supportInfiniteMode?: boolean
  agents?: AgentBrief[]
  agentsLoading?: boolean
  selectedAgentId?: string | null
  /** 当前会话的 Agent（单聊历史消息归属，优先于下拉选择） */
  activeAgentId?: string | null
  onAgentChange?: (id: string) => void
  /** Group chat mode */
  isGroup?: boolean
  /** QQ 群聊标记（服务端判定，替代 client 端 agent 数量猜测） */
  isQqGroup?: boolean
  groupAgents?: AgentBrief[]
  onSendGroup?: (text: string, thinkingMode: boolean, attachments?: Array<{ url: string; name: string; size: number; type: string }>, infiniteMode?: boolean) => void
  /** Infinite mode */
  infiniteMode?: boolean
  onInfiniteModeChange?: (enabled: boolean) => void
  /** Ask user tool */
  pendingQuestion?: (import('@momoi/shared/types').ServerMessage & { type: 'ask_user' }) | null
  onSendAnswer?: (answer: string, selectedOptions?: string[]) => void
  onSkipAnswer?: () => void
  recommendedQuestions?: string[]
  /** Admin-configured chat follow-ups (chips above the input bar in non-empty conversations) */
  followupQuestions?: string[]
  /** Current conversation id for upload scoping */
  conversationId?: string | null
  /** Called when upload needs a conversation but none exists yet */
  onEnsureConversation?: () => Promise<string>
  /** Show thinking details in messages (controlled by App.tsx) */
  verbose?: boolean
}

export function ChatPanel({
  messages, loading, onSend, onCancel, onRevert, onForceRetry, backgroundImage, supportAttachments, supportInfiniteMode,
  agents, agentsLoading, selectedAgentId, activeAgentId, onAgentChange,
  isGroup, isQqGroup, groupAgents, onSendGroup,
  infiniteMode = false, onInfiniteModeChange,
  pendingQuestion, onSendAnswer, onSkipAnswer,
  recommendedQuestions,
  followupQuestions,
  conversationId, onEnsureConversation,
  verbose,
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
  const noAgents = !isGroup && !agentsLoading && !hasAgents
  // QQ 群聊：服务端通过 qqGroupConversations 表判定（多 Bot 下 agent 数 > 1，不能靠 client 猜测）
  const isQqGroupChat = isQqGroup === true
  // 单聊气泡归属的 Agent：优先当前会话的 Agent（历史消息都来自它），否则回退到下拉选择
  const directAgent = isGroup
    ? undefined
    : (activeAgentId ? agents?.find((a) => a.id === activeAgentId) : undefined)
      || (selectedAgentId ? agents?.find((a) => a.id === selectedAgentId) : undefined)
  const directAgentAvatar = directAgent?.avatar || null
  const directAgentVoiceEnabled = directAgent?.voice_enabled ?? false
  // Build a map of agent_id → voice_enabled for all agents (group chat)
  const agentVoiceMap = useMemo(() => {
    if (!agents) return new Map<string, boolean>()
    return new Map(agents.map(a => [a.id, a.voice_enabled ?? false]))
  }, [agents])

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

  const handleForceRetry = async (index: number) => {
    await onForceRetry?.(index)
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
      <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 pb-4 pt-[76px] relative z-10">
        {!hasMessages ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-full max-w-3xl">
              <div className="mb-4 px-4">
                {isGroup ? (
                  <h2 className="text-xl font-semibold">{t('chat.groupGreeting')}</h2>
                ) : agentsLoading ? (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span className="text-lg">{t('common.loading')}</span>
                  </div>
                ) : hasAgents ? (
                  <h2 className="text-xl font-semibold flex items-center gap-1 flex-wrap">
                    <span>{timeGreeting}{t('chat.greetingSuffix')}</span>
                    <Select value={selectedAgentId || ''} onValueChange={(v) => onAgentChange?.(v)}>
                      <SelectTrigger className="h-auto w-auto gap-1 border-none bg-transparent p-0 text-xl font-semibold text-primary shadow-none underline decoration-primary/30 underline-offset-4 hover:decoration-primary focus:ring-0 focus:ring-offset-0 data-[state=open]:decoration-primary [&_svg]:h-5 [&_svg]:w-5">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {agents!.map((a) => (
                          <SelectItem key={a.id} value={a.id} className="text-base">{a.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
                supportInfiniteMode={supportInfiniteMode}
                noAgents={noAgents}
                agents={isGroup ? groupAgents : undefined}
                conversationId={conversationId}
                onEnsureConversation={onEnsureConversation}
              />

              {/* Recommended questions */}
              {recommendedQuestions && recommendedQuestions.length > 0 && (
                <div className="mt-4 px-4">
                  <div className="flex flex-wrap justify-center gap-2">
                    {recommendedQuestions.map((q, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleSend(q)}
                        disabled={loading || noAgents}
                        className="inline-flex items-center px-4 py-2 rounded-full border border-border bg-background text-sm text-muted-foreground hover:text-foreground hover:border-primary/50 hover:bg-primary/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                </div>
              )}
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
            onForceRetry={handleForceRetry}
            agentAvatar={isGroup ? null : directAgentAvatar}
            agents={isGroup ? (groupAgents || []) : agents}
            fallbackAgentName={isGroup ? undefined : directAgent?.name}
            agentVoiceEnabled={isGroup ? false : directAgentVoiceEnabled}
            agentVoiceMap={agentVoiceMap}
            verbose={verbose}
            isQqGroup={isQqGroupChat}
          />
        )}
      </div>

      {/* Ask user question bar */}
      {pendingQuestion && pendingQuestion.questions.length > 0 && (
        <QuestionBar
          questions={pendingQuestion.questions}
          onAnswer={(answer, selectedOptions) => onSendAnswer?.(answer, selectedOptions)}
          onSkip={() => onSkipAnswer?.()}
        />
      )}

      {/* Input area — hidden in QQ group (read-only: messages only come from QQ) */}
      {hasMessages && !isQqGroupChat && (
        <div className="relative z-10">
          {/* Follow-up chips (admin-configured) — above the input bar, only in
              non-empty conversations (the empty state shows recommendedQuestions instead) */}
          {followupQuestions && followupQuestions.length > 0 && (
            <div className="max-w-3xl mx-auto w-full px-4 pt-2 pb-1 flex flex-wrap gap-2">
              {followupQuestions.map((q, idx) => (
                <button
                  key={idx}
                  onClick={() => handleSend(q)}
                  disabled={loading || !!pendingQuestion}
                  className="suggestion-chip disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {q}
                </button>
              ))}
            </div>
          )}
          <InputBar
            onSend={handleSend}
            disabled={loading || !!pendingQuestion}
            externalValue={revertedText}
            onExternalValueConsumed={handleExternalValueConsumed}
            thinkingMode={thinkingMode}
            onThinkingModeChange={setThinkingMode}
            infiniteMode={infiniteMode}
            onInfiniteModeChange={onInfiniteModeChange || (() => {})}
            supportAttachments={supportAttachments}
            supportInfiniteMode={supportInfiniteMode}
            noAgents={noAgents}
            agents={isGroup ? groupAgents : undefined}
            conversationId={conversationId}
            onEnsureConversation={onEnsureConversation}
          />
        </div>
      )}
      {hasMessages && isQqGroupChat && (
        <div className="text-center text-xs text-muted-foreground py-2 border-t">
          {t('chat.qqGroupReadonly')}
        </div>
      )}
    </div>
  )
}