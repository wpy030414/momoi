import { useState, useRef, useEffect, KeyboardEvent, useCallback, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { errT } from '../../i18n'
import { handleAuthOn401 } from '../../lib/api'
import { toApiError } from '../../lib/apiError'
import { ArrowUp, Folder, Infinity, Loader2, Paperclip, X, Upload } from 'lucide-react'
import { createPortal } from 'react-dom'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import type { ConversationStats, Workspace } from '@momoi/shared/types'
import { formatDuration, formatTokenCount } from '../../lib/format'

/** 未分组哨兵值：Radix Select 不接受空字符串 value，用保留前缀与工作区 UUID 隔离 */
const UNGROUPED_VALUE = '__ungrouped__'

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

interface InputBarProps {
  onSend: (text: string, attachments?: Attachment[]) => void
  disabled?: boolean
  externalValue?: string
  onExternalValueConsumed?: () => void
  infiniteMode: boolean
  onInfiniteModeChange: (enabled: boolean) => void
  /** 工作区下拉选项；空数组时整个下拉隐藏（只有未分组可选，无选择意义） */
  workspaces?: Workspace[]
  /** 新会话的目标工作区（null = 未分组）；仅在草稿态（无 conversationId）可选 */
  newChatWorkspaceId?: string | null
  onNewChatWorkspaceChange?: (id: string | null) => void
  /** 当前会话的归属工作区（会话不可移动）：已有会话时下拉禁用并显示此值 */
  conversationWorkspaceId?: string | null
  supportAttachments?: boolean
  /** Whether infinite mode button should be shown (controlled by admin config) */
  supportInfiniteMode?: boolean
  /** Whether to show the "no agents" disabled state */
  noAgents?: boolean
  /** Available agents for @mention autocomplete (group chat members only; undefined hides the menu) */
  agents?: AgentBrief[]
  /** 世界模拟：存在时输入框提示词换成「来自世界的变动」占位（替代普通发言占位） */
  isWorld?: boolean
  /** Current conversation id; null when no active conversation */
  conversationId?: string | null
  /** Called when upload needs a conversation but none exists yet */
  onEnsureConversation?: () => Promise<string>
  /** Collapse the input bar to a single truncated line (user scrolled away) */
  collapsed?: boolean
  /** Called when user clicks the collapsed bar to restore it */
  onExpand?: () => void
  /** 会话状态条统计（SSE stats 事件 + DB 快照；已有对话输入框底部显示） */
  stats?: ConversationStats | null
  /** 模型上下文窗口大小（tokens）：管理端网关设置，缺省 128000 */
  contextWindow?: number
  /** 当前工作区名称（已有会话用——状态条首字段） */
  conversationWorkspaceName?: string
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

export const InputBar = memo(function InputBar({ onSend, disabled, externalValue, onExternalValueConsumed, infiniteMode, onInfiniteModeChange, workspaces, newChatWorkspaceId, onNewChatWorkspaceChange, conversationWorkspaceId, supportAttachments, supportInfiniteMode, noAgents, agents, isWorld, conversationId, onEnsureConversation, collapsed = false, onExpand, stats, contextWindow = 128000, conversationWorkspaceName }: InputBarProps) {
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
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionIndex, setMentionIndex] = useState(1)
  const [menuPosition, setMenuPosition] = useState<{ bottom: number; left: number } | null>(null)

  const isInputDisabled = noAgents
  const cannotSend = disabled || isInputDisabled || uploading

  // Filtered agents based on current query
  const filteredAgents = (agents || []).filter((a) =>
    a.name.toLowerCase().includes(mentionQuery.toLowerCase())
  )

  // Position the menu fully ABOVE the input box (anchored by its bottom edge),
  // so it never covers the text being typed.
  const updateMenuPosition = useCallback(() => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    setMenuPosition({
      bottom: window.innerHeight - rect.top + 8,
      left: rect.left + 16,
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

  // Auto-focus textarea when expanding from collapsed state (skip initial mount)
  const wasCollapsedRef = useRef(collapsed)
  useEffect(() => {
    if (!collapsed && wasCollapsedRef.current && textareaRef.current) {
      textareaRef.current.focus()
    }
    wasCollapsedRef.current = collapsed
  }, [collapsed])

  // --- Collapse via measured px height transition ---
  // 不用 grid-template-rows 的 0fr/1fr 过渡：fr 轨道在 iOS Safari（WebKit）
  // 的静态解析与过渡终态均不可靠——收缩后残留高度、展开时两行同屏，
  // 表现为「输入框有两个」。height 的 px 过渡是所有浏览器的基本功。
  // 动画期间两行锁 px；稳态展开回 auto（textarea 自动长高需要弹性高度）。
  const collapsedRowRef = useRef<HTMLDivElement>(null)
  const expandedRowRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const collapsedRef = useRef(collapsed)
  // 'none' = 稳态；'collapse' / 'expand' = 过渡在途（两行均可见）
  const [animPhase, setAnimPhase] = useState<'none' | 'collapse' | 'expand'>('none')
  const [collapsedRowH, setCollapsedRowH] = useState<number | 'auto'>(collapsed ? 'auto' : 0)
  const [expandedRowH, setExpandedRowH] = useState<number | 'auto'>(collapsed ? 0 : 'auto')

  const finishAnim = useCallback(() => {
    if (!collapsedRef.current) {
      // 展开完成：回 auto，让内容（textarea 长高 / 附件增删）自由撑高
      setExpandedRowH('auto')
    }
    setAnimPhase('none')
  }, [])

  useEffect(() => {
    if (collapsedRef.current === collapsed) return
    collapsedRef.current = collapsed
    // iOS 会为 focused 表单控件维持可见性（键盘定位），收缩前先放弃焦点
    if (collapsed) textareaRef.current?.blur()

    // 锁定两行当前实际 px（auto↔px 无法直接过渡；动画中途反向时
    // offsetHeight 是中间值，从中间值自然衔接）
    setCollapsedRowH(collapsedRowRef.current?.offsetHeight ?? 0)
    setExpandedRowH(expandedRowRef.current?.offsetHeight ?? 0)
    setAnimPhase(collapsed ? 'collapse' : 'expand')

    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    // 双 rAF：先让锁定高度完成一次样式计算（确立过渡起点），再设目标
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(() => {
        if (collapsedRef.current) {
          setExpandedRowH(0)
          setCollapsedRowH(collapsedRowRef.current?.scrollHeight ?? 0)
        } else {
          setCollapsedRowH(0)
          setExpandedRowH(expandedRowRef.current?.scrollHeight ?? 0)
        }
      })
    })
  }, [collapsed])

  // 超时兜底收尾（后台标签页收不到 transitionend）
  useEffect(() => {
    if (animPhase === 'none') return
    const t = window.setTimeout(finishAnim, 340)
    return () => clearTimeout(t)
  }, [animPhase, finishAnim])

  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
  }, [])

  const handleRowTransitionEnd = (e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.propertyName !== 'height') return
    finishAnim()
  }

  const selectMention = useCallback((agent: AgentBrief) => {
    const cursorPos = textareaRef.current?.selectionStart ?? text.length
    const detection = detectMention(text, cursorPos)
    if (!detection) return
    // Replace the "@query" fragment in place with the finalized "@Name " text
    const before = text.slice(0, detection.start)
    const after = text.slice(cursorPos)
    const inserted = `@${agent.name} `
    const newText = before + inserted + after
    setText(newText)
    setMentionOpen(false)
    setMentionQuery('')
    requestAnimationFrame(() => {
      if (textareaRef.current) {
        const newPos = detection.start + inserted.length
        textareaRef.current.focus()
        textareaRef.current.setSelectionRange(newPos, newPos)
        // Re-run auto-grow since programmatic setText skips onInput
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`
      }
    })
  }, [text])

  const hasContent = text.trim().length > 0 || attachments.length > 0

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if ((!trimmed && attachments.length === 0) || cannotSend) return
    onSend(trimmed, attachments.length > 0 ? attachments : undefined)
    setText('')
    setAttachments([])
    setMentionOpen(false)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [text, attachments, cannotSend, onSend])

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
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
  }, [mentionOpen, filteredAgents, mentionIndex, selectMention, handleSend])

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
        // Ensure we have a conversation — create one lazily if needed
        let convId = conversationId
        if (!convId && onEnsureConversation) {
          convId = await onEnsureConversation()
        }
        if (!convId) {
          throw new Error(t('chat.uploadNoConversation'))
        }
        const formData = new FormData()
        formData.append('file', file)
        formData.append('conversation_id', convId)
        // The HttpOnly cookie authenticates the upload automatically
        const startedAt = Date.now()
        const res = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        })
        if (!res.ok) {
          handleAuthOn401('/api/upload', startedAt, res.status)
          throw await toApiError(res)
        }
        const data = await res.json()
        newAttachments.push(data)
      }
      setAttachments((prev) => [...prev, ...newAttachments])
    } catch (err) {
      console.error('Upload failed:', err)
      setUploadError(errT(err))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  return (
    <div ref={containerRef} className={`max-w-3xl mx-auto w-full px-4 ${!collapsed && conversationId != null && stats ? 'pb-1' : 'pb-4'}`}>
      {/* 生成中（模型思考/回复）：给输入框套一层 Siri 式彩色光环——外层辉光 + 内层描边。
          两层常驻 DOM、只靠 opacity 过渡淡入淡出（条件渲染是卸载，做不出退场过渡；
          不叠加 scale，否则 box-shadow 的几何会被一起缩放，辉光看着在放大缩小）；
          动画由 .ai-active 门控（见 globals.css）。盒子的 overflow-hidden 会把子元素的外
          发光裁掉，所以光环必须住在盒子外层；盒子自身一行未改，避免重排。 */}
      <div className={`relative ${disabled ? 'ai-active' : ''}`}>
      <div className={`rounded-xl border bg-background/[.66] overflow-hidden ${collapsed ? '' : 'focus-within:border-ring transition-colors'}`}>
      {/* Collapsed row: single truncated line（稳态展开时 invisible，动画期间保持可见参与交叉过渡） */}
      <div
        ref={collapsedRowRef}
        className={`overflow-hidden transition-[height] duration-300 ease-out ${animPhase === 'none' && !collapsed ? 'invisible' : ''}`}
        style={{ height: typeof collapsedRowH === 'number' ? `${collapsedRowH}px` : collapsedRowH }}
        aria-hidden={!collapsed}
      >
        <button
          onClick={onExpand}
          className="w-full text-left text-sm text-muted-foreground truncate leading-relaxed px-4 py-3 bg-transparent focus:outline-none cursor-text"
          tabIndex={collapsed ? 0 : -1}
              title={text || (noAgents ? t('settings.agentRequired') : isWorld ? t('chat.worldChangePlaceholder') : t('chat.inputPlaceholder'))}
            >
              {text || (
                <span className="text-muted-foreground/60">
                  {noAgents ? t('settings.agentRequired') : isWorld ? t('chat.worldChangePlaceholder') : t('chat.inputPlaceholder')}
                </span>
              )}
            </button>
          </div>

      {/* Expanded content row（稳态收缩时 invisible；展开过渡结束回 auto） */}
      <div
        ref={expandedRowRef}
        className={`overflow-hidden transition-[height] duration-300 ease-out ${animPhase === 'none' && collapsed ? 'invisible' : ''}`}
        style={{ height: typeof expandedRowH === 'number' ? `${expandedRowH}px` : expandedRowH }}
        aria-hidden={collapsed}
        onTransitionEnd={handleRowTransitionEnd}
      >
        <div className="px-4 py-3">
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
              placeholder={noAgents ? t('settings.agentRequired') : isWorld ? t('chat.worldChangePlaceholder') : t('chat.inputPlaceholder')}
              disabled={isInputDisabled}
              rows={3}
              className="w-full resize-none bg-transparent text-sm focus:outline-none disabled:opacity-50 max-h-[200px] leading-relaxed py-1"
            />
            <div className="flex items-center justify-between pt-2">
              <div className="flex items-center gap-1.5">
                {/* 工作区下拉（原深度思考按钮位）：草稿态选择新会话归属的工作区；
                    已有会话锁定不可移动 → 禁用并展示其归属。无可选工作区时整体隐藏。 */}
                {!collapsed && conversationId == null && (workspaces?.length ?? 0) > 0 && (
                  <Select
                    value={conversationId != null ? (conversationWorkspaceId ?? UNGROUPED_VALUE) : (newChatWorkspaceId ?? UNGROUPED_VALUE)}
                    onValueChange={(v) => onNewChatWorkspaceChange?.(v === UNGROUPED_VALUE ? null : v)}
                    disabled={conversationId != null}
                  >
                    <SelectTrigger
                      className="h-8 w-auto max-w-[200px] gap-1.5 rounded-md border-none px-3 py-1.5 text-sm font-normal text-muted-foreground shadow-none transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground [&>svg]:h-3.5 [&>svg]:w-3.5"
                      title={conversationId != null ? t('sidebar.newWorkspaceHint') : t('chat.workspacePicker')}
                    >
                      <Folder className="h-3.5 w-3.5 flex-shrink-0" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNGROUPED_VALUE}>{t('sidebar.ungrouped')}</SelectItem>
                      {workspaces!.map((ws) => (
                        <SelectItem key={ws.id} value={ws.id}>{ws.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
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
                  disabled={cannotSend || !hasContent}
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
        </div>
      </div>
      {/* 外发光：自身透明——非 inset 的 box-shadow 只画在边框盒之外，故不会遮住输入区 */}
      <div
        aria-hidden
        className={`ai-glow pointer-events-none absolute inset-0 rounded-xl transition-opacity duration-700 ease-out ${disabled ? 'opacity-100' : 'opacity-0'}`}
      />
      {/* 描边：-inset-px 让 2px 彩环正好压在盒子原有的 1px 边框上（所以盒子本身不用改边框） */}
      <div
        aria-hidden
        className={`ai-aura pointer-events-none absolute -inset-px rounded-xl transition-opacity duration-700 ease-out ${disabled ? 'opacity-100' : 'opacity-0'}`}
      />
      </div>

      {/* 会话状态条（已有会话：输入框下方一行，不显工作区下拉） */}
      {!collapsed && conversationId != null && stats && (
        <div className="mt-1.5 text-xs text-muted-foreground text-center truncate">
          <span className="font-medium">
            {conversationWorkspaceName || t('sidebar.ungrouped')}
          </span>
          {/* 本轮耗时 · tok/s（存量快照没有 durationMs → 与分隔符整簇隐藏，
              避免留下孤立竖线）。轮/步 不上状态条：步与工具气泡数重合、
              轮与「思考片段」编号口径不同反而引起疑问（见 module-chat.md〈会话状态条〉） */}
          {(stats.durationMs != null || stats.tokensPerSecond > 0) && (
            <>
              <span className="mx-1.5 text-border">|</span>
              {stats.durationMs != null && <span>{formatDuration(stats.durationMs)}</span>}
              {stats.durationMs != null && stats.tokensPerSecond > 0 && <span className="mx-1.5 text-border">·</span>}
              {stats.tokensPerSecond > 0 && <span>{stats.tokensPerSecond} tok/s</span>}
            </>
          )}
          {/* 累计消耗：账单口径——Σ 每次 LLM 调用的输入+输出，含每轮重发的上下文。
              存量快照（该字段上线前）没有 totalTokens → 整簇隐藏。
              状态条只列裸数字（无中文标签、无 ≈）：估算标记仍在快照数据里
              （estimated / totalEstimated），留给工具提示或详情视图。 */}
          {stats.totalTokens != null && (
            <>
              <span className="mx-1.5 text-border">|</span>
              <span>{formatTokenCount(stats.totalTokens)} tok</span>
            </>
          )}
          <span className="mx-1.5 text-border">|</span>
          {/* 上下文占用（分母 = 管理端配置的窗口大小，与 Pi 循环同源）。
              绝对值让位给累计消耗，这里只留百分比——它才是驱动动作的那个数。 */}
          <span>
            {contextWindow > 0 ? Math.round((stats.contextTokens / contextWindow) * 100) : 0}%
          </span>
        </div>
      )}

      {/* Mention dropdown portal */}
      {mentionOpen && filteredAgents.length > 0 && menuPosition && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] max-h-[200px] overflow-y-auto w-56 rounded-md border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95"
          style={{ bottom: menuPosition.bottom, left: menuPosition.left }}
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
})