import { useState, useRef, useEffect, KeyboardEvent, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Brain, Infinity, Loader2, Paperclip, X, Upload } from 'lucide-react'
import { createPortal } from 'react-dom'

interface Attachment {
  url: string
  name: string
  size: number
  type: string
}

interface AgentBrief {
  id: string
  name: string
  avatar: string
}

interface MentionEntry {
  agentId: string
  agentName: string
}

interface InputBarProps {
  onSend: (text: string, attachments?: Attachment[]) => void
  disabled?: boolean
  externalValue?: string
  onExternalValueConsumed?: () => void
  thinkingMode: boolean
  onThinkingModeChange: (enabled: boolean) => void
  infiniteMode: boolean
  onInfiniteModeChange: (enabled: boolean) => void
  supportAttachments?: boolean
  /** Whether infinite mode button should be shown (controlled by admin config) */
  supportInfiniteMode?: boolean
  /** Whether to show the "no agents" disabled state */
  noAgents?: boolean
  /** Available agents for @mention autocomplete */
  agents?: AgentBrief[]
}

/** Scan backwards from cursorPos to find the last active @mention trigger */
function detectMention(text: string, cursorPos: number): { query: string; start: number } | null {
  // Find the last @ that sits on a word boundary (preceded by space/start/newline)
  for (let i = cursorPos - 1; i >= 0; i--) {
    if (text[i] === '@') {
      const prev = i === 0 ? ' ' : text[i - 1]
      if (prev === ' ' || prev === '\n') {
        return { query: text.slice(i + 1, cursorPos), start: i }
      }
      return null // @ is mid-word, not a mention trigger
    }
    if (text[i] === ' ' || text[i] === '\n') return null
  }
  return null
}

export function InputBar({ onSend, disabled, externalValue, onExternalValueConsumed, thinkingMode, onThinkingModeChange, infiniteMode, onInfiniteModeChange, supportAttachments, supportInfiniteMode, noAgents, agents }: InputBarProps) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // --- @Mention state ---
  const [mentions, setMentions] = useState<MentionEntry[]>([])
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionIndex, setMentionIndex] = useState(1)
  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null)

  const isInputDisabled = disabled || noAgents

  // Filtered agents based on current query
  const filteredAgents = (agents || []).filter((a) =>
    a.name.toLowerCase().includes(mentionQuery.toLowerCase())
    && !mentions.some((m) => m.agentId === a.id) // Dedup
  )

  // Update menu position relative to the container
  const updateMenuPosition = useCallback(() => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    setMenuPosition({
      top: rect.top - 8,
      left: rect.left,
    })
  }, [])

  useEffect(() => {
    if (externalValue !== undefined && externalValue !== '') {
      setText(externalValue)
      onExternalValueConsumed?.()
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto'
          textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
          textareaRef.current.focus()
        }
      })
    }
  }, [externalValue, onExternalValueConsumed])

  const selectMention = useCallback((agent: AgentBrief) => {
    const cursorPos = textareaRef.current?.selectionStart ?? text.length
    const detection = detectMention(text, cursorPos)
    if (!detection) return
    // Remove @query from textarea
    const before = text.slice(0, detection.start)
    const after = text.slice(cursorPos)
    setText(before + after)
    setMentions((prev) => [...prev, { agentId: agent.id, agentName: agent.name }])
    setMentionOpen(false)
    setMentionQuery('')
    // Restore cursor position after the removed text
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const newPos = detection.start
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(newPos, newPos)
      }
    })
  }, [text])

  const removeMention = (index: number) => {
    setMentions((prev) => prev.filter((_, i) => i !== index))
  }

  const hasContent = text.trim().length > 0 || attachments.length > 0 || mentions.length > 0

  const handleSend = () => {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0 && mentions.length === 0) || isInputDisabled || uploading) return
    // Append @mentions as text suffix
    const mentionSuffix = mentions.length > 0
      ? (trimmed ? '\n\n' : '') + mentions.map((m) => `@${m.agentName}`).join(' ')
      : ''
    const fullText = trimmed + mentionSuffix
    onSend(fullText || '', attachments.length > 0 ? attachments : undefined)
    setText('')
    setAttachments([])
    setMentions([])
    setMentionOpen(false)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Mention menu keyboard nav
    if (mentionOpen && filteredAgents.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((prev) => Math.min(prev + 1, filteredAgents.length))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((prev) => Math.max(prev - 1, 1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const agent = filteredAgents[mentionIndex - 1]
        if (agent) selectMention(agent)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMentionOpen(false)
        return
      }
    }

    // Normal send on Enter (without shift)
    if (e.key === 'Enter' && !e.shiftKey && !mentionOpen) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newText = e.target.value
    setText(newText)

    // @mention detection
    if (agents && agents.length > 0) {
      const cursorPos = e.target.selectionStart ?? newText.length
      const detection = detectMention(newText, cursorPos)
      if (detection) {
        setMentionQuery(detection.query)
        setMentionOpen(true)
        setMentionIndex(1)
        updateMenuPosition()
      } else {
        setMentionOpen(false)
        setMentionQuery('')
      }
    }
  }

  // External click + Escape to close menu
  useEffect(() => {
    if (!mentionOpen) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMentionOpen(false)
      }
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setMentionOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [mentionOpen])

  // Reposition menu on scroll/resize while open
  useEffect(() => {
    if (!mentionOpen) return
    window.addEventListener('scroll', updateMenuPosition, { capture: true })
    window.addEventListener('resize', updateMenuPosition)
    return () => {
      window.removeEventListener('scroll', updateMenuPosition, { capture: true })
      window.removeEventListener('resize', updateMenuPosition)
    }
  }, [mentionOpen, updateMenuPosition])

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    setUploading(true)
    setUploadError('')
    try {
      const newAttachments: Attachment[] = []
      for (const file of Array.from(files)) {
        const formData = new FormData()
        formData.append('file', file)
        // The HttpOnly cookie authenticates the upload automatically
        const res = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }))
          throw new Error(err.error || `Upload failed: ${file.name}`)
        }
        const data = await res.json()
        newAttachments.push(data)
      }
      setAttachments((prev) => [...prev, ...newAttachments])
    } catch (err) {
      console.error('Upload failed:', err)
      setUploadError(err instanceof Error ? err.message : String(err))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  return (
    <div ref={containerRef} className="max-w-3xl mx-auto w-full px-4 pb-4">
      <div className="rounded-xl border bg-background px-4 py-3 focus-within:ring-2 focus-within:ring-ring transition-shadow">
        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {attachments.map((att, idx) => (
              <div key={idx} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted text-xs max-w-[200px]">
                <Paperclip className="h-3 w-3 flex-shrink-0" />
                <span className="truncate">{att.name}</span>
                <button onClick={() => removeAttachment(idx)} className="ml-0.5 hover:text-destructive flex-shrink-0">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Mention chips */}
        {mentions.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-3">
            {mentions.map((m, idx) => (
              <div key={m.agentId} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-primary/10 text-primary text-xs border border-primary/20 max-w-[200px]">
                <span className="truncate">@{m.agentName}</span>
                <button onClick={() => removeMention(idx)} className="ml-0.5 hover:text-destructive flex-shrink-0">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {uploadError && (
          <div className="flex items-start gap-1.5 mb-2 px-2 py-1.5 rounded-md bg-destructive/10 text-destructive text-xs">
            <span className="flex-1 break-words">{t('chat.uploadFailed', { message: uploadError })}</span>
            <button onClick={() => setUploadError('')} className="hover:text-destructive/70 flex-shrink-0 mt-0.5">
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder={noAgents ? t('settings.agentRequired') : t('chat.inputPlaceholder')}
          disabled={isInputDisabled}
          rows={3}
          className="w-full resize-none bg-transparent text-sm focus:outline-none disabled:opacity-50 max-h-[200px] leading-relaxed py-1"
        />
        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => onThinkingModeChange(!thinkingMode)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                thinkingMode ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
              title={t('chat.deepThinking')}
            >
              <Brain className="h-3.5 w-3.5" />
              <span>{t('chat.deepThinking')}</span>
            </button>
            {supportInfiniteMode !== false && (
            <button
              onClick={() => onInfiniteModeChange(!infiniteMode)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                infiniteMode ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`}
              title={t('chat.infiniteMode')}
            >
              <Infinity className="h-3.5 w-3.5" />
              <span>{t('chat.infiniteMode')}</span>
            </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {supportAttachments !== false && (
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isInputDisabled || uploading}
                className="inline-flex items-center justify-center h-9 w-9 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title={t('chat.addAttachment')}
              >
                {uploading ? <Upload className="h-4 w-4 animate-pulse" /> : <Paperclip className="h-4 w-4" />}
              </button>
            )}
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
            <button
              onClick={handleSend}
              disabled={isInputDisabled || uploading || !hasContent}
              className="inline-flex items-center justify-center p-1.5 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all h-9 w-9"
              title={t('chat.send')}
            >
              {disabled ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Mention dropdown portal */}
      {mentionOpen && filteredAgents.length > 0 && menuPosition && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] max-h-[200px] overflow-y-auto w-56 rounded-md border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95"
          style={{ top: menuPosition.top, left: menuPosition.left }}
        >
          {filteredAgents.map((agent, idx) => (
            <button
              key={agent.id}
              onMouseDown={(e) => { e.preventDefault(); selectMention(agent) }}
              className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors ${
                mentionIndex === idx + 1 ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
              }`}
            >
              {agent.avatar ? (
                <img src={agent.avatar} alt="" className="w-5 h-5 rounded-full object-cover flex-shrink-0" />
              ) : (
                <div className="w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-medium flex-shrink-0">
                  {agent.name.charAt(0)}
                </div>
              )}
              <span className="truncate">{agent.name}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}