import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageContent } from './MessageContent'
import { ThinkingBlock } from './ThinkingBlock'
import { AttachmentCard, AttachmentList } from './AttachmentCard'
import { VoicePlayButton } from '../voice/VoicePlayButton'
import { Bot, Undo2, Check, X, ChevronRight } from 'lucide-react'
import type { Attachment, ThinkingSegment, TraceEntry } from '@/shared/types'

interface ChatMessage {
  id?: number
  role: 'user' | 'assistant'
  content: string
  thinking?: string
  thinkingSegments?: ThinkingSegment[]
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
  /** Called when user clicks revert button on a user message */
  onRevert?: () => void
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
}

export function MessageBubble({ message, onSuggestion, showSuggestions, onRevert, agentAvatar, agentName, voiceEnabled, activeAgentId, verbose }: MessageBubbleProps) {
  const { t } = useTranslation()
  const isUser = message.role === 'user'
  const [confirmingRevert, setConfirmingRevert] = useState(false)

  return (
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

      {/* Content wrapper — groups content column + revert row as one flex item */}
      <div className={`flex-1 min-w-0 ${isUser ? 'flex flex-row-reverse gap-2' : ''}`}>
        {/* Content column */}
        <div className={`flex-1 min-w-0 ${isUser ? 'text-right' : ''}`}>
          {/* Agent name label for group chat */}
          {!isUser && agentName && (
            <div className="text-xs text-muted-foreground mb-1 ml-1">{agentName}</div>
          )}

          {/* Trace-driven rendering: thinking + text + tool calls in chronological order.
              Falls back to legacy grouped rendering if trace is absent (defensive). */}
          {!isUser && message.trace && message.trace.length > 0 ? (
            <>
              {groupAndRenderTrace(message.trace, message.streaming, verbose)}
            </>
          ) : !isUser ? (
            /* Legacy fallback: grouped rendering for messages without trace */
            <>
              {message.thinking && (
                <ThinkingBlock
                  content={message.thinking}
                  segments={message.thinkingSegments}
                  done={!message.streaming}
                  verbose={verbose}
                />
              )}
              {message.toolCalls && message.toolCalls.length > 0 && (
                <div className="mb-2 space-y-1">
                  {message.toolCalls.map((tc, idx) => (
                    <div key={tc.id || idx}>
                      <div className="text-xs bg-muted rounded-md px-3 py-1.5 flex items-center gap-2 min-w-0">
                        <span className="font-medium truncate">{tc.name}</span>
                        {tc.status === 'running' && (
                          <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin inline-block flex-shrink-0" />
                        )}
                        {tc.result && <span className="text-muted-foreground ml-1 truncate">{tc.result}</span>}
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
                  ))}
                </div>
              )}
              {/* Content block — only shown in legacy path (no trace) */}
              <div className={`inline-block rounded-lg px-4 py-1 bg-card/75 border`}>
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
            </>
          ) : null}

          {/* Attachments */}
          {message.attachments && message.attachments.length > 0 && (
            <div className={`mb-2 ${isUser ? 'flex flex-wrap gap-1.5 justify-end' : ''}`}>
              <AttachmentList attachments={message.attachments} />
            </div>
          )}

          {/* Voice play button — assistant messages only when voice is enabled */}
          {!isUser && !message.streaming && message.content && voiceEnabled && activeAgentId && message.id && (
            <VoicePlayButton
              agentId={activeAgentId}
              messageId={message.id}
              text={message.content}
              enabled={true}
            />
          )}

          {/* Message content — user messages only (assistant text is rendered via trace or legacy path above) */}
          {isUser && (
            <div className={`inline-block rounded-lg px-4 py-1 bg-primary/75 text-primary-foreground text-left`}>
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
          )}

          {/* Suggestions — only on the last assistant message */}
          {showSuggestions && message.suggestions && message.suggestions.length > 0 && (
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

        {/* Revert button — user messages only, positioned on the visual left */}
        {isUser && onRevert && (
          <div className="flex-shrink-0 flex items-center">
            {confirmingRevert ? (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    setConfirmingRevert(false)
                    onRevert()
                  }}
                  className="h-7 px-2 text-xs rounded-md bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-colors inline-flex items-center gap-1"
                  title={t('chat.revertConfirmAction')}
                >
                  <Check className="h-3 w-3" />
                  {t('chat.revertConfirmAction')}
                </button>
                <button
                  onClick={() => setConfirmingRevert(false)}
                  className="h-7 px-2 text-xs rounded-md bg-muted text-muted-foreground hover:bg-muted/80 transition-colors inline-flex items-center gap-1"
                  title={t('common.cancel')}
                >
                  <X className="h-3 w-3" />
                  {t('common.cancel')}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmingRevert(true)}
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-md transition-colors inline-flex items-center gap-1"
                title={t('chat.revert')}
              >
                <Undo2 className="h-3 w-3" />
                {t('chat.revert')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Group consecutive tool_call entries into stacks; render trace with verbose-controlled thinking. */
function groupAndRenderTrace(trace: TraceEntry[], streaming?: boolean, verbose?: boolean): React.ReactNode {
  const elements: React.ReactNode[] = []
  let i = 0
  while (i < trace.length) {
    const entry = trace[i]
    if (entry.type === 'tool_call') {
      // Collect consecutive tool_call entries - always collapse, even if just 1
      const stack: TraceEntry[] = [entry]
      let j = i + 1
      while (j < trace.length && trace[j].type === 'tool_call') {
        stack.push(trace[j])
        j++
      }
      elements.push(<ToolCallStack key={`stack-${i}`} entries={stack} streaming={streaming} />)
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
    } else {
      // text
      elements.push(
        <div key={`text-${i}`} className={`inline-block rounded-lg px-4 py-1 bg-card/75 border mb-1`}>
          <MessageContent content={entry.text} streaming={streaming && i === trace.length - 1} isUser={false} />
        </div>
      )
      i++
    }
  }
  return elements
}

function renderToolCall(entry: TraceEntry, idx: number): React.ReactNode {
  if (entry.type !== 'tool_call') return null
  return (
    <div key={`tool-${entry.id || idx}`} className="mb-1">
      <div className="text-xs bg-muted rounded-md px-3 py-1.5 flex items-center gap-2 min-w-0">
        <span className="font-medium truncate">{entry.name}</span>
        {entry.status === 'running' && (
          <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin inline-block flex-shrink-0" />
        )}
        {entry.result && <span className="text-muted-foreground ml-1 truncate">{entry.result}</span>}
      </div>
      {entry.artifacts && entry.artifacts.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1">
          {entry.artifacts.map((art, i) => (
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
        className="text-xs bg-muted rounded-md px-3 py-1.5 flex items-center gap-2 min-w-0 hover:bg-muted/80 transition-colors w-full text-left"
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
        className="text-xs bg-muted/50 rounded-md px-3 py-1.5 min-w-0 cursor-pointer"
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
