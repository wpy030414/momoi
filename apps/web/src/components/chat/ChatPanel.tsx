import { useState, useRef, useLayoutEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Loading } from '../ui/spinner'
import { MessageList } from './MessageList'
import { InputBar } from './InputBar'
import { QuestionBar } from './QuestionBar'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import type { Attachment, AskUserQuestion, ConversationStats, Workspace } from '@momoi/shared/types'

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
  /** 会话视图加载中（切换会话后快照未落分区）：显示加载态而非「新会话」空态。
   *  与 loading（发送流进行中）语义不同。 */
  viewLoading?: boolean
  onSend: (text: string, thinkingMode?: boolean, attachments?: Array<{ url: string; name: string; size: number; type: string }>, agentId?: string | null, groupMode?: boolean, groupAgentIds?: string[], infiniteMode?: boolean) => void | Promise<void>
  onCancel: () => void
  onRevert: (index: number) => Promise<string | null>
  /** 强制合规重试（单聊）：回退消息后以 _force_compliance 标记重发 */
  onForceRetry?: (index: number) => Promise<void>
  /** 强制合规重试（群聊）：与 onSendGroup 对应的群聊版重发 */
  onForceRetryGroup?: (index: number) => Promise<void>
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
  /** 世界模拟模式：世界会话复用群聊管线（isGroup 同为 true），差异只在用户消息语义与展示 */
  isWorld?: boolean
  groupAgents?: AgentBrief[]
  onSendGroup?: (text: string, thinkingMode: boolean, attachments?: Array<{ url: string; name: string; size: number; type: string }>, infiniteMode?: boolean) => void
  /** Infinite mode */
  infiniteMode?: boolean
  onInfiniteModeChange?: (enabled: boolean) => void
  /** 工作区下拉（输入框）：新会话目标工作区选择（null = 未分组） */
  workspaces?: Workspace[]
  newChatWorkspaceId?: string | null
  onNewChatWorkspaceChange?: (id: string | null) => void
  /** 当前会话归属的工作区（会话不可移动；草稿态无意义） */
  conversationWorkspaceId?: string | null
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
  /** 会话状态条统计（SSE stats 事件；已有会话传参） */
  stats?: ConversationStats | null
  /** 模型上下文窗口大小（tokens） */
  contextWindow?: number
  /** 当前工作区名称（已有会话用——状态条首字段） */
  conversationWorkspaceName?: string
}

const NOOP = () => {}

export function ChatPanel({
  messages, loading, viewLoading, onSend, onCancel, onRevert, onForceRetry, onForceRetryGroup, backgroundImage, supportAttachments, supportInfiniteMode,
  agents, agentsLoading, selectedAgentId, activeAgentId, onAgentChange,
  isGroup, isQqGroup, isWorld, groupAgents, onSendGroup,
  infiniteMode = false, onInfiniteModeChange,
  workspaces, newChatWorkspaceId, onNewChatWorkspaceChange, conversationWorkspaceId,
  pendingQuestion, onSendAnswer, onSkipAnswer,
  recommendedQuestions,
  followupQuestions,
  conversationId, onEnsureConversation,
  verbose,
  stats, contextWindow, conversationWorkspaceName,
}: ChatPanelProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const prevFirstIdRef = useRef<number | undefined>(undefined)
  // Track whether the user is scrolled near the bottom — updated by onScroll.
  // Stored in a ref so useLayoutEffect can read it before the browser paints
  // (by that point scrollHeight has grown but scrollTop hasn't, so computing
  // "atBottom" inside the effect is always wrong).
  const atBottomRef = useRef(true)
  const expandedByUserRef = useRef(false)
  const programmaticScrollRef = useRef(false)
  // 收缩判定的锚点：记录「开始记录」时的 scrollTop。只有当前位置相对锚点的
  // 净位移达到 33vh 才收缩——来回小幅滚动会互相抵消，不会被累计距离误触发。
  const scrollAnchorRef = useRef(0)
  const [revertedText, setRevertedText] = useState<string>('')
  // 深度思考已移除开关、强制开启（服务端 thinking_mode 恒 true）
  const [inputCollapsed, setInputCollapsed] = useState(false)
  const inputCollapsedRef = useRef(false)

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

  // Time-of-day greeting — 7 bands
  const timeGreeting = useMemo(() => {
    const now = new Date()
    const hour = now.getHours()
    const minute = now.getMinutes()
    const timeInMinutes = hour * 60 + minute

    if (timeInMinutes >= 360 && timeInMinutes < 510) return t('chat.greetingMorning')       // 06:00-08:29
    if (timeInMinutes >= 510 && timeInMinutes < 660) return t('chat.greetingLateMorning')    // 08:30-10:59
    if (timeInMinutes >= 660 && timeInMinutes < 840) return t('chat.greetingNoon')           // 11:00-13:59
    if (timeInMinutes >= 840 && timeInMinutes < 1020) return t('chat.greetingAfternoon')     // 14:00-16:59
    if (timeInMinutes >= 1020 && timeInMinutes < 1320) return t('chat.greetingEvening')      // 17:00-21:59
    if (timeInMinutes >= 1320 || timeInMinutes < 210) return t('chat.greetingLateNight')     // 22:00-03:29
    return t('chat.greetingDawn')                                                            // 03:30-05:59
  }, [t])

  // Track scroll position — fires before the next layout effect,
  // so atBottomRef is always accurate when we decide whether to pin.
  // Threshold: 10% of visible height (not absolute px), so it scales
  // with window size and long chats.
  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    // 格子背景视差：背景跟随滚动，速度 0.2× 内容
    if (gridRef.current) {
      gridRef.current.style.backgroundPositionY = `${el.scrollTop * -0.2}px`
    }
    // 程序化滚动（新消息自动置底、动画期间钉住底部等）不是用户位移，
    // 锚点直接跟随到新位置，避免程序化跳变被算成用户滚动。
    if (programmaticScrollRef.current) {
      programmaticScrollRef.current = false
      scrollAnchorRef.current = el.scrollTop
      return
    }
    const threshold = el.clientHeight * 0.1
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
    // expandedByUserRef is a short-lived guard set on expand-click — ignore
    // layout-shift scrolls during the transition; once it clears, next user
    // scroll collapses normally. 同步锚点，位移从动画结束处重新起算。
    if (expandedByUserRef.current) {
      scrollAnchorRef.current = el.scrollTop
      return
    }
    // 净位移 = 当前位置 − 锚点。来回滚动互相抵消，只有从起点单向
    // （或净效应）滚出 33vh 才收缩。
    const displacement = Math.abs(el.scrollTop - scrollAnchorRef.current)
    const minScroll = el.clientHeight * 0.33
    if (displacement >= minScroll && !inputCollapsedRef.current) {
      scrollAnchorRef.current = el.scrollTop
      inputCollapsedRef.current = true
      setInputCollapsed(true)
    }
  }, [])

  // 底部悬浮区（问题条 + 追问 chips + 输入框）高度 → 消息区 padding-bottom。
  // 消息滚动层是 absolute 全面板覆盖，底部留白必须动态等于悬浮区实际高度：
  // 输入框展开/收起（300ms 高度动画）、统计条、追问 chips 增减都实时跟随。
  // 直接写 DOM style 而非 state——动画期间 ResizeObserver 每帧回调，
  // 走 state 会连着 MessageList 一起逐帧重渲染。
  useLayoutEffect(() => {
    const bottom = bottomRef.current
    const scroller = containerRef.current
    if (!bottom || !scroller) return
    const sync = () => {
      // +24px 呼吸空间：最新消息与建议不贴输入框上沿
      scroller.style.paddingBottom = `${bottom.offsetHeight + 24}px`
      // 用户本就在底部时，底部悬浮区高度变化（输入框展开/收起动画、问题条
      // 弹出、多行输入撑高）期间逐帧钉住底部——最新消息始终贴着悬浮区上沿
      // 被撑到上面，而不是留在原地被逐渐长高的输入框盖住。
      if (atBottomRef.current && scroller.scrollTop < scroller.scrollHeight - scroller.clientHeight) {
        programmaticScrollRef.current = true
        scroller.scrollTop = scroller.scrollHeight
      }
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(bottom)
    return () => ro.disconnect()
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
      programmaticScrollRef.current = true
      el.scrollTop = el.scrollHeight
      // 程序化滚动后同步格子背景视差
      if (gridRef.current) {
        gridRef.current.style.backgroundPositionY = `${el.scrollTop * -0.2}px`
      }
      // 置底跳变不算用户位移——锚点跟随到新底部，位移从置底处重新起算
      scrollAnchorRef.current = el.scrollTop
    }
  }, [messages])

  const handleRevert = useCallback(async (index: number) => {
    const text = await onRevert(index)
    if (text) {
      setRevertedText(text)
    }
  }, [onRevert])

  const handleForceRetry = useCallback(async (index: number) => {
    // 与 handleSend 同款双通道分派：群聊走群聊版（groupMode 重发），
    // 单聊走单聊版 —— 误走群聊版会因不预建流式气泡而丢失全部 token 事件。
    if (isGroup && onForceRetryGroup) {
      await onForceRetryGroup(index)
    } else {
      await onForceRetry?.(index)
    }
  }, [isGroup, onForceRetryGroup, onForceRetry])

  const handleExternalValueConsumed = useCallback(() => {
    setRevertedText('')
  }, [])

  const handleSend = useCallback((text: string, attachments?: Array<{ url: string; name: string; size: number; type: string }>) => {
    if (isGroup && onSendGroup) {
      onSendGroup(text, true, attachments, infiniteMode)
    } else {
      onSend(text, true, attachments, selectedAgentId, false, undefined, infiniteMode)
    }
  }, [isGroup, onSendGroup, onSend, selectedAgentId, infiniteMode])

  const handleSuggestion = useCallback((text: string) => {
    if (isGroup && onSendGroup) onSendGroup(text, true, undefined, infiniteMode)
    else onSend(text, true, undefined, selectedAgentId, false, undefined, infiniteMode)
  }, [isGroup, onSendGroup, onSend, selectedAgentId, infiniteMode])

  return (
    <div className="flex-1 flex flex-col min-h-0 relative justify-end">
      {/* Grid background layer — covers entire chat panel (messages + input + question bar) */}
      {!backgroundImage && (
        <div
          ref={gridRef}
          className="chat-grid-bg absolute inset-0 pointer-events-none z-0"
        />
      )}
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
      <div ref={containerRef} onScroll={handleScroll} className="absolute inset-0 overflow-y-auto px-4 pt-[76px] z-10">
        {!hasMessages && viewLoading ? (
          // 会话切换中：快照未落分区——显示加载态，而非误触发「新会话」空态
          <Loading className="h-full" size="lg" />
        ) : !hasMessages ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-full max-w-3xl">
              <div className="mb-4 px-4">
                {isWorld ? (
                  <h2 className="text-xl font-semibold">{t('workflow.worldTitle')}</h2>
                ) : isGroup ? (
                  <h2 className="text-xl font-semibold">{t('chat.groupGreeting')}</h2>
                ) : agentsLoading ? (
                  <Loading className="py-6" />
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
                infiniteMode={infiniteMode}
                onInfiniteModeChange={onInfiniteModeChange ?? NOOP}
                workspaces={workspaces}
                newChatWorkspaceId={newChatWorkspaceId}
                onNewChatWorkspaceChange={onNewChatWorkspaceChange}
                conversationWorkspaceId={conversationWorkspaceId}
                supportAttachments={supportAttachments}
                supportInfiniteMode={supportInfiniteMode}
                noAgents={noAgents}
                agents={isGroup ? groupAgents : undefined}
                conversationId={conversationId}
                onEnsureConversation={onEnsureConversation}
                collapsed={false}
                onExpand={NOOP}
                stats={stats}
                contextWindow={contextWindow}
                conversationWorkspaceName={conversationWorkspaceName}
                onCancel={onCancel}
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
            onSuggestion={handleSuggestion}
            onRevert={handleRevert}
            onForceRetry={handleForceRetry}
            agentAvatar={isGroup ? null : directAgentAvatar}
            agents={isGroup ? (groupAgents || []) : agents}
            fallbackAgentName={isGroup ? undefined : directAgent?.name}
            agentVoiceEnabled={isGroup ? false : directAgentVoiceEnabled}
            agentVoiceMap={agentVoiceMap}
            verbose={verbose}
            isQqGroup={isQqGroupChat}
            isWorld={isWorld}
          />
        )}
      </div>

      {/* 底部悬浮区：始终渲染（内容条件挂载），供 ResizeObserver 测量整体高度 */}
      <div ref={bottomRef} className="relative z-10">
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
          <>
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
              infiniteMode={infiniteMode}
              onInfiniteModeChange={onInfiniteModeChange ?? NOOP}
              workspaces={workspaces}
              newChatWorkspaceId={newChatWorkspaceId}
              onNewChatWorkspaceChange={onNewChatWorkspaceChange}
              conversationWorkspaceId={conversationWorkspaceId}
              supportAttachments={supportAttachments}
              supportInfiniteMode={supportInfiniteMode}
              noAgents={noAgents}
              agents={isGroup ? groupAgents : undefined}
              isWorld={isWorld}
              conversationId={conversationId}
              onEnsureConversation={onEnsureConversation}
              collapsed={inputCollapsed}
              onExpand={() => {
                inputCollapsedRef.current = false
                setInputCollapsed(false)
                expandedByUserRef.current = true
                // 位移锚点重置到当前滚动位置，展开后从零重新起算
                scrollAnchorRef.current = containerRef.current?.scrollTop ?? 0
                // Release the guard after the expand animation completes
                setTimeout(() => { expandedByUserRef.current = false }, 350)
              }}
              stats={stats}
              contextWindow={contextWindow}
              conversationWorkspaceName={conversationWorkspaceName}
              onCancel={onCancel}
            />
          </>
        )}
        {hasMessages && isQqGroupChat && (
          <div className="text-center text-xs text-muted-foreground py-2 border-t">
            {t('chat.qqGroupReadonly')}
          </div>
        )}
      </div>
    </div>
  )
}