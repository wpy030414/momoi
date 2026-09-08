import { useState, useRef, useEffect, KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, Infinity, Loader2, Paperclip, X, Upload } from 'lucide-react'
import { getToken } from '../../lib/api'

interface Attachment {
  url: string
  name: string
  size: number
  type: string
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
  /** Whether to show the "no agents" disabled state */
  noAgents?: boolean
}

export function InputBar({ onSend, disabled, externalValue, onExternalValueConsumed, thinkingMode, onThinkingModeChange, infiniteMode, onInfiniteModeChange, supportAttachments, noAgents }: InputBarProps) {
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const isInputDisabled = disabled || noAgents

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

  const handleSend = () => {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0) || isInputDisabled || uploading) return
    onSend(trimmed, attachments.length > 0 ? attachments : undefined)
    setText('')
    setAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
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
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { Authorization: `Bearer ${getToken() || ''}` },
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

  const hasContent = text.trim().length > 0 || attachments.length > 0

  return (
    <div className="max-w-3xl mx-auto w-full px-4 pb-4">
      <div className="rounded-xl border bg-background px-4 py-3 focus-within:ring-2 focus-within:ring-ring transition-shadow">
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
          onChange={(e) => setText(e.target.value)}
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
          </div>
          <div className="flex items-center gap-2">
            {supportAttachments !== false && (
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isInputDisabled || uploading}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title={t('chat.addAttachment')}
              >
                {uploading ? <Upload className="h-3.5 w-3.5 animate-pulse" /> : <Paperclip className="h-3.5 w-3.5" />}
                <span>{uploading ? t('chat.uploading') : t('chat.addAttachment')}</span>
              </button>
            )}
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
            <button
              onClick={handleSend}
              disabled={isInputDisabled || uploading || !hasContent}
              className="px-4 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-all inline-flex items-center justify-center min-w-[64px] h-9"
            >
              {disabled ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t('chat.send')
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}