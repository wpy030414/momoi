import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageContent } from './MessageContent'
import { ThinkingBlock } from './ThinkingBlock'
import { AttachmentCard, AttachmentList } from './AttachmentCard'
import { User, Bot, Undo2, Check, X } from 'lucide-react'
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
}

export function MessageBubble({ message, onSuggestion, showSuggestions, onRevert, agentAvatar }: MessageBubbleProps) {
  const { t } = useTranslation()
  const isUser = message.role === 'user'
  const [confirmingRevert, setConfirmingRevert] = useState(false)

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''} group`}>
      {/* Avatar */}
      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center overflow-hidden ${
        isUser ? 'bg-primary text-primary-foreground' : 'bg-secondary'
      }`}>
        {isUser ? (
          <User className="h-4 w-4" />
        ) : agentAvatar ? (
          <img src={agentAvatar} alt="agent" className="h-full w-full object-cover" />
        ) : (
          <Bot className="h-4 w-4" />
        )}
      </div>

      {/* Content wrapper — groups content column + revert row as one flex item */}
      <div className={`flex-1 min-w-0 ${isUser ? 'flex flex-row-reverse gap-2' : ''}`}>
        {/* Content column */}
        <div className={`flex-1 min-w-0 ${isUser ? 'text-right' : ''}`}>
          {/* Thinking block — 优先按分段展示（多轮思考），否则回退到整段 */}

          {message.thinking && (
            <ThinkingBlock
              content={message.thinking}
              segments={message.thinkingSegments}
              done={!message.streaming}
            />
          )}

          {/* Tool calls */}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className="mb-2 space-y-1">
              {message.toolCalls.map((tc, idx) => (
                <div key={tc.id || idx}>
                  <div className="text-xs bg-muted rounded-md px-3 py-1.5 flex items-center gap-2">
                    <span className="font-medium">🔧 {tc.name}</span>
                    {tc.status === 'running' && (
                      <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin inline-block" />
                    )}
                    {tc.result && <span className="text-muted-foreground ml-1 truncate">→ {tc.result}</span>}
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

          {/* Attachments */}
          {message.attachments && message.attachments.length > 0 && (
            <div className={`mb-2 ${isUser ? 'flex flex-wrap gap-1.5 justify-end' : ''}`}>
              <AttachmentList attachments={message.attachments} />
            </div>
          )}

          {/* Message content */}
          <div className={`inline-block rounded-lg px-4 py-2 ${
            isUser ? 'bg-primary text-primary-foreground text-left' : 'bg-card border'
          }`}>
            {message.streaming && !message.content ? (
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-current rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-2 h-2 bg-current rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-2 h-2 bg-current rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            ) : (
              <MessageContent content={message.content} streaming={message.streaming} />
            )}
          </div>

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
        {isUser && message.id && onRevert && (
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
