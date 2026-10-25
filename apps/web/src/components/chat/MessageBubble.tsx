import React, { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageContent } from './MessageContent'
import { ThinkingBlock } from './ThinkingBlock'
import { AttachmentCard, AttachmentList } from './AttachmentCard'
import { CardRenderer } from '../cards/CardRenderer'
import { VoicePlayButton } from '../voice/VoicePlayButton'
import { MessageActions } from './MessageActions'
import { Button } from '../ui/button'
import { Bot, ChevronRight } from 'lucide-react'
import type { Attachment, TraceEntry } from '@momoi/shared/types'

interface ChatMessage {
  id?: number
  role: 'user' | 'assistant'
  content: string
  toolCalls?: Array<{ id?: string; name: string; input: Record<string, unknown>; status?: 'running' | 'done' | 'error'; result?: string; artifacts?: Array<{ filename: string; displayName: string; mimeType: string; downloadUrl: string }> }>
  trace?: TraceEntry[]
  suggestions?: string[]
  attachments?: Attachment[]
  streaming?: boolean
}

interface MessageBubbleProps {
  message: ChatMessage
  onSuggestion?: (text: string) => void
  /** Only the last assistant message should show its suggestion chips */
  showSuggestions?: boolean
  /** 编辑提交：用户消息 = 截断并重新作答；AI 消息 = 只改历史内容 */
  onEdit?: (content: string) => Promise<boolean>
  /** 用户消息：强制重试（沿用旧路线：回退 + 重发） */
  onForceRetry?: () => void
  /** 生成中禁用编辑 / 重试（复制不受影响） */
  actionsDisabled?: boolean
  /** Agent avatar URL (base64 data URL) */
  agentAvatar?: string | null
  /** Group chat: agent display name */
  agentName?: string
  /** Whether this agent has voice enabled */
  voiceEnabled?: boolean
  /** Active agent ID (for voice audio URL resolution) */
  activeAgentId?: string
  /** Show thinking blocks (controlled by parent verbose toggle) */
  verbose?: boolean
  /** 世界模拟：user 消息是「来自世界的变动」而非用户发言 —— 气泡换世界变动样式 */
  isWorld?: boolean
}

export const MessageBubble = React.memo(function MessageBubble({
  message,
  onSuggestion,
  showSuggestions,
  onEdit,
  onForceRetry,
  actionsDisabled,
  agentAvatar,
  agentName,
  voiceEnabled,
  activeAgentId,
  verbose,
  isWorld,
}: MessageBubbleProps) {
  const { t } = useTranslation()
  const isUser = message.role === 'user'
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const editRef = useRef<HTMLTextAreaElement | null>(null)

  const resizeEditor = () => {
    const el = editRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }

  useEffect(() => {
    if (!editing) return
    resizeEditor()
    const el = editRef.current
    if (el) {
      el.focus()
      el.selectionStart = el.selectionEnd = el.value.length
    }
  }, [editing])

  const startEditing = () => {
    setDraft(message.content)
    setEditing(true)
  }

  const cancelEditing = () => {
    if (saving) return
    setEditing(false)
    setDraft('')
  }

  const submitEdit = async () => {
    const value = draft.trim()
    if (!value || saving || !onEdit) return
    setSaving(true)
    try {
      const ok = await onEdit(value)
      if (ok) {
        setEditing(false)
        setDraft('')
      }
    } catch {
      /* 失败提示由上层负责；保留编辑态供重试 */
    } finally {
      setSaving(false)
    }
  }

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      cancelEditing()
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // 输入法组合中的 Enter 属于候选词确认，不能提交
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      e.preventDefault()
      void submitEdit()
    }
  }

  const canEdit = !!onEdit && message.id != null && !message.streaming

  const editor = (
    <div className={`w-full max-w-full rounded-lg border border-primary/30 bg-background p-2 text-left ${isUser ? 'ml-auto' : ''}`}>
      <textarea
        ref={editRef}
        value={draft}
        onChange={(e) => { setDraft(e.target.value); resizeEditor() }}
        onKeyDown={handleEditorKeyDown}
        rows={2}
        className="w-full min-h-[64px] max-h-[240px] resize-none bg-transparent text-sm leading-relaxed outline-none"
        placeholder={t('chat.editMessagePlaceholder')}
        aria-label={t('chat.editMessage')}
      />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={cancelEditing} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" onClick={() => void submitEdit()} disabled={saving || !draft.trim()}>
          {saving ? t('chat.saving') : t('common.save')}
        </Button>
      </div>
    </div>
  )

  return (
    <MessageActions
      text={message.content}
      onEdit={canEdit && !editing ? startEditing : undefined}
      onForceRetry={onForceRetry && !message.streaming && !editing ? onForceRetry : undefined}
      disabled={actionsDisabled}
      suppressMenu={editing}
    >
      <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''} group`}>
        {/* Avatar — only show for assistant messages */}
        {!isUser && (
          <div className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center overflow-hidden bg-secondary">
            {agentAvatar ? (
              <img src={agentAvatar} alt={t('common.altAgentAvatar')} className="h-full w-full object-cover" />
            ) : (
              <Bot className="h-4 w-4" />
            )}
          </div>
        )}

        {/* Content wrapper */}
        <div className="flex-1 min-w-0">
          {/* Content column */}
          <div className={`flex-1 min-w-0 ${isUser ? 'text-right' : ''}`}>
            {/* Sender/agent name label — assistant in group chat, or user in QQ group */}
            {agentName && (
              <div className={`text-xs text-muted-foreground mb-1 ${isUser ? 'mr-1' : 'ml-1'}`}>{agentName}</div>
            )}

            {editing ? editor : (
              <>
                {/* Trace-driven rendering: thinking + tool calls + text in chronological order. */}
                {!isUser && message.trace && message.trace.length > 0 ? (
                  <>
                    {groupAndRenderTrace(message.trace, message.streaming, verbose, agentName)}
                  </>
                ) : !isUser ? (
                  /* Streaming placeholder — content not yet arrived */
                  <div className={`inline-block max-w-full rounded-lg px-4 py-2.5 bg-card/60 backdrop-blur-sm border`}>
                    {message.streaming && !message.content ? (
                      <div className="flex gap-1">
                        <span className="w-2 h-2 bg-current rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-2 h-2 bg-current rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-2 h-2 bg-current rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                      </div>
                    ) : (
                      <MessageContent content={message.content} streaming={message.streaming} isUser={false} />
                    )}
                  </div>
                ) : null}

                {/* Message content — user messages only (assistant text is rendered via trace or legacy path above) */}
                {isUser && (
                  <div className="mb-1">
                    <div
                      className={`inline-block max-w-full rounded-lg px-4 py-2.5 text-left backdrop-blur-sm ${
                        isWorld ? 'border border-amber-500/30 bg-amber-500/60 text-amber-900 dark:text-amber-100' : 'bg-primary/60 text-primary-foreground'
                      }`}
                    >
                      {message.streaming && !message.content ? (
                        <div className="flex gap-1">
                          <span className="w-2 h-2 bg-current rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="w-2 h-2 bg-current rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="w-2 h-2 bg-current rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                      ) : (
                        <MessageContent content={message.content} streaming={message.streaming} isUser={isUser} />
                      )}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Attachments */}
            {message.attachments && message.attachments.length > 0 && (
              <div className={`mb-2 ${isUser ? 'flex flex-wrap gap-1.5 justify-end' : ''}`}>
                <AttachmentList attachments={message.attachments} />
              </div>
            )}

            {/* Voice play button — assistant messages only when voice is enabled */}
            {!editing && !isUser && !message.streaming && message.content && voiceEnabled && activeAgentId && message.id && (
              <VoicePlayButton
                agentId={activeAgentId}
                messageId={message.id}
                text={message.content}
                enabled={true}
              />
            )}

            {/* Suggestions — only on the last assistant message */}
            {!editing && showSuggestions && message.suggestions && message.suggestions.length > 0 && (
              <div className={`flex flex-wrap gap-2 mt-2 ${isUser ? 'justify-end' : ''}`}>
                {message.suggestions.map((s, idx) => (
                  <button
                    key={idx}
                    className="suggestion-chip"
                    onClick={() => onSuggestion?.(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </MessageActions>
  )
})

/** Group consecutive tool_call entries into stacks; render trace with verbose-controlled thinking. */
function groupAndRenderTrace(trace: TraceEntry[], streaming?: boolean, verbose?: boolean, agentName?: string | null): React.ReactNode {
  const elements: React.ReactNode[] = []
  // 已被卡片事件「认领」的工具调用 id（ui_* 工具声明）：卡片即其 UI 表示，
  // 对应 tool_call 条目不再进工具栈；校验失败（无卡片）时照常显示错误条目。
  const claimed = new Set<string>()
  for (const e of trace) {
    if (e.type === 'card' && e.id) claimed.add(e.id)
  }
  let i = 0
  while (i < trace.length) {
    const entry = trace[i]
    if (entry.type === 'tool_call') {
      // Collect consecutive tool_call entries.
      // When thinking is hidden (EyeOff), merge tool-call groups that are
      // separated only by thinking blocks into a single collapsed stack to
      // avoid multiple "Used N tools" labels stacking without visible gaps.
      const stack: TraceEntry[] = []
      if (!(entry.id && claimed.has(entry.id))) stack.push(entry)
      let j = i + 1
      while (j < trace.length && (trace[j].type === 'tool_call' || (trace[j].type === 'thinking' && !verbose))) {
        const e = trace[j]
        if (e.type === 'tool_call' && !(e.id && claimed.has(e.id))) {
          stack.push(e)
        }
        j++
      }
      if (stack.length > 0) {
        elements.push(<ToolCallStack key={`stack-${i}`} entries={stack} streaming={streaming} />)
      }
      i = j
    } else if (entry.type === 'thinking') {
      elements.push(
        <ThinkingBlock
          key={`thinking-${i}`}
          content={entry.text}
          segments={[{ round: 0, text: entry.text }]}
          done={!streaming}
          verbose={verbose}
        />
      )
      i++
    } else if (entry.type === 'card') {
      elements.push(<CardRenderer key={`card-${entry.id ?? i}`} card={entry.card} cardId={entry.id} ownerAgentName={agentName ?? undefined} />)
      i++
    } else {
      // text
      elements.push(
        <div key={`text-${i}`} className={`inline-block max-w-full rounded-lg px-4 py-2.5 bg-card/60 backdrop-blur-sm border mb-1`}>
          <MessageContent content={entry.text} streaming={streaming && i === trace.length - 1} isUser={false} />
        </div>
      )
      i++
    }
  }
  // Show loading dots when streaming and no text output has arrived yet.
  // This bridges the gap between thinking blocks and the first real response.
  if (streaming && !trace.some((e) => e.type === 'text')) {
    elements.push(
      <div key="loading-dots" className={`inline-block max-w-full rounded-lg px-4 py-2.5 bg-card/60 backdrop-blur-sm border mb-1`}>
        <div className="flex gap-1">
          <span className="w-2 h-2 bg-current rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-2 h-2 bg-current rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-2 h-2 bg-current rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </div>
      </div>
    )
  }
  return elements
}

function ToolCallStack({ entries, streaming }: { entries: TraceEntry[]; streaming?: boolean }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)

  const toolCalls = entries.filter(
    (e): e is Extract<TraceEntry, { type: 'tool_call' }> => e.type === 'tool_call'
  )
  if (toolCalls.length === 0) return null

  const runningCount = toolCalls.filter((tc) => tc.status === 'running').length

  return (
    <div className="mb-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-xs bg-muted/60 backdrop-blur-sm rounded-md px-3 py-1.5 flex items-center gap-2 min-w-0 hover:bg-muted/80 transition-colors w-full text-left"
      >
        <ChevronRight className={`h-3 w-3 transition-transform flex-shrink-0 ${expanded ? 'rotate-90' : ''}`} />
        <span className="font-medium">
          {t('chat.toolsUsed', { count: toolCalls.length })}
        </span>
        {runningCount > 0 && (
          <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="mt-1 space-y-1 pl-4">
          {toolCalls.map((tc, idx) => (
            <ToolCallDetail key={tc.id || idx} tc={tc} />
          ))}
        </div>
      )}
    </div>
  )
}

function ToolCallDetail({ tc }: { tc: Extract<TraceEntry, { type: 'tool_call' }> }) {
  const [showFull, setShowFull] = useState(false)

  return (
    <div>
      <div
        className="text-xs bg-muted/60 backdrop-blur-sm rounded-md px-3 py-1.5 min-w-0 cursor-pointer"
        onClick={() => tc.result && setShowFull(!showFull)}
      >
        <div className="flex items-center gap-2">
          <span className="font-medium break-all">{tc.name}</span>
          {tc.status === 'running' && (
            <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />
          )}
        </div>
        {tc.result && (
          showFull ? (
            <div className="text-muted-foreground mt-0.5 break-all whitespace-pre-wrap">{tc.result}</div>
          ) : (
            <div className="text-muted-foreground truncate">{tc.result}</div>
          )
        )}
      </div>
      {tc.artifacts && tc.artifacts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1">
          {tc.artifacts.map((art, i) => (
            <AttachmentCard key={i} attachment={{
              url: art.downloadUrl,
              name: art.displayName,
              size: 0,
              type: art.mimeType,
            }} />
          ))}
        </div>
      )}
    </div>
  )
}
