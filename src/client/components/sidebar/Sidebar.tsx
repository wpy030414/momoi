import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ScrollArea } from '../ui/scroll-area'
import { Button } from '../ui/button'
import { Plus, MessageSquare, MessagesSquare, MoreVertical, Download, Trash2, Pencil, Settings, User, Users, LogOut, Key, Link, PencilLine, Languages, SunMoon, Wrench, Smartphone, GitMerge, BookOpen } from 'lucide-react'
import { Github } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Conversation } from '@/shared/types'
import type { Theme } from '../../hooks/useTheme'

interface SidebarProps {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onNewGroup: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onExport: (id: string) => void
  onMerge?: (convId: string) => void
  onManageGroupAgents?: (convId: string) => void
  onContinueOnIm?: (convId: string, agentId: string) => void
  appName: string
  currentUser: string
  showGithub?: boolean
  onChangePin?: () => void
  onChangeUsername?: () => void
  onLinkAccount?: () => void
  onLogout?: () => void
  language?: string
  onLanguageChange?: (lang: string) => void
  theme?: Theme
  onThemeChange?: (theme: Theme) => void
  onAdminSettings?: () => void
  onDocs?: () => void
}

interface MenuState {
  convId: string
  anchorRect: DOMRect
}

/**
 * 会话标题：默认严格限长、溢出省略；光标悬停且确实溢出时循环滚动展示全文——
 * 悬停即以每秒 2 个中文字符的速度匀速滚到末尾，停 3 秒，瞬间回到开头再停 1 秒，循环。
 *
 * 省略号必须画在内层自身的文本上（Chromium 的 text-overflow 不作用于不限宽的
 * inline-block 原子盒溢出），故内层 idle 时 max-w-full + ellipsis，悬停测量/滚动时
 * 才放开 max-width。滚动距离/时长按实测溢出量计算，用 WAAPI 驱动（各段占比随
 * 距离变化，CSS 关键帧无法参数化）。
 */
function ConversationTitle({ title }: { title: string }) {
  const containerRef = useRef<HTMLSpanElement>(null)
  const innerRef = useRef<HTMLSpanElement>(null)
  const animRef = useRef<Animation | null>(null)

  const stopMarquee = useCallback(() => {
    animRef.current?.cancel()
    animRef.current = null
    if (innerRef.current) innerRef.current.style.maxWidth = ''
  }, [])

  const startMarquee = useCallback(() => {
    const container = containerRef.current
    const inner = innerRef.current
    if (!container || !inner) return
    inner.style.maxWidth = 'none'
    const dist = inner.offsetWidth - container.clientWidth
    if (dist <= 1) {
      inner.style.maxWidth = ''
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      inner.style.maxWidth = ''
      return
    }
    // 全角字符宽度 ≈ font-size，故每秒 2 个中文字符 ≈ 2 × font-size px/s
    const speed = 2 * parseFloat(getComputedStyle(inner).fontSize)
    const travelMs = (dist / speed) * 1000
    const endHoldMs = 3000
    const startHoldMs = 1000
    const totalMs = travelMs + endHoldMs + startHoldMs
    // 同一 offset 放两个关键帧 = 瞬移：滚到 -dist 停 3s 后跳回 0，开头再停 1s 进入下一圈
    animRef.current = inner.animate(
      [
        { transform: 'translateX(0)' },
        { transform: `translateX(${-dist}px)`, offset: travelMs / totalMs },
        { transform: `translateX(${-dist}px)`, offset: (travelMs + endHoldMs) / totalMs },
        { transform: 'translateX(0)', offset: (travelMs + endHoldMs) / totalMs },
        { transform: 'translateX(0)' },
      ],
      { duration: totalMs, easing: 'linear', iterations: Infinity },
    )
  }, [])

  // 卸载（如进入重命名态）时停止动画
  useEffect(() => stopMarquee, [stopMarquee])

  return (
    <span
      ref={containerRef}
      className="flex-1 min-w-0 overflow-hidden whitespace-nowrap text-sm"
      onMouseEnter={startMarquee}
      onMouseLeave={stopMarquee}
    >
      <span ref={innerRef} className="inline-block max-w-full overflow-hidden text-ellipsis">{title}</span>
    </span>
  )
}

export function Sidebar({ conversations, activeId, onSelect, onNew, onNewGroup, onRename, onDelete, onExport, onMerge, onManageGroupAgents, onContinueOnIm, appName, currentUser, showGithub = true, onChangePin, onChangeUsername, onLinkAccount, onLogout, language, onLanguageChange, theme, onThemeChange, onAdminSettings, onDocs }: SidebarProps) {
  const { t, i18n } = useTranslation()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const userPopoverRef = useRef<HTMLDivElement>(null)
  const settingsPopoverRef = useRef<HTMLDivElement>(null)
  const userBtnRef = useRef<HTMLButtonElement>(null)
  const settingsBtnRef = useRef<HTMLButtonElement>(null)
  const [userPopoverOpen, setUserPopoverOpen] = useState(false)
  const [settingsPopoverOpen, setSettingsPopoverOpen] = useState(false)

  const closeMenu = useCallback(() => setMenu(null), [])

  const closeAllPopovers = useCallback(() => {
    setUserPopoverOpen(false)
    setSettingsPopoverOpen(false)
  }, [])

  const startRename = useCallback((conv: Conversation) => {
    setRenamingId(conv.id)
    setRenameValue(conv.title)
    closeMenu()
    // Focus input on next render
    requestAnimationFrame(() => inputRef.current?.select())
  }, [closeMenu])

  const commitRename = useCallback(() => {
    if (renamingId) {
      const trimmed = renameValue.trim()
      if (trimmed) {
        onRename(renamingId, trimmed)
      }
    }
    setRenamingId(null)
    setRenameValue('')
  }, [renamingId, renameValue, onRename])

  const cancelRename = useCallback(() => {
    setRenamingId(null)
    setRenameValue('')
  }, [])

  // Close on outside click / scroll / resize / Escape
  useEffect(() => {
    if (!menu) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeMenu()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu() }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', closeMenu)
    // Also close when the scroll area scrolls (parent reflows)
    const scroller = document.querySelector('[data-radix-scroll-area-viewport]')
    scroller?.addEventListener('scroll', closeMenu)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', closeMenu)
      scroller?.removeEventListener('scroll', closeMenu)
    }
  }, [menu, closeMenu])

  // Close popovers on outside click / Escape
  useEffect(() => {
    if (!userPopoverOpen && !settingsPopoverOpen) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node
      if (userPopoverRef.current && !userPopoverRef.current.contains(target) &&
          !userBtnRef.current?.contains(target)) {
        setUserPopoverOpen(false)
      }
      if (settingsPopoverRef.current && !settingsPopoverRef.current.contains(target) &&
          !settingsBtnRef.current?.contains(target)) {
        setSettingsPopoverOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeAllPopovers() }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', closeAllPopovers)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', closeAllPopovers)
    }
  }, [userPopoverOpen, settingsPopoverOpen, closeAllPopovers])

  return (
    <div className="flex flex-col h-full w-72 bg-card">
      {/* App name + GitHub */}
      <div className="flex items-center justify-between px-4 border-b" style={{ height: '60px' }}>
        <h1 className="text-lg font-semibold">{appName}</h1>
        {showGithub && (
          <a
            href="https://github.com/wpy030414/momoi"
            target="_blank"
            rel="noopener noreferrer"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          >
            <Github className="h-4 w-4" />
          </a>
        )}
      </div>

      {/* New chat button */}
      <div className="p-3 space-y-2">
        <Button className="w-full gap-2" onClick={onNew}>
          <Plus className="h-4 w-4" />
          {t('sidebar.newChat')}
        </Button>
        <Button className="w-full gap-2" variant="outline" onClick={onNewGroup}>
          <Plus className="h-4 w-4" />
          {t('sidebar.newGroupChat')}
        </Button>
      </div>

      {/* Recent label */}
      <div className="px-4 pb-1">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t('sidebar.recent')}
        </span>
      </div>

      {/* Conversation list */}
      <ScrollArea className="flex-1 sidebar-scroll-area">
        <div className="px-2 pb-2 space-y-1">
          {conversations.map((conv) => (
            <div
              key={conv.id}
              className={`group flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer transition-colors relative ${
                activeId === conv.id
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/50'
              }`}
              onClick={() => { if (renamingId !== conv.id) onSelect(conv.id) }}
            >
              {/* IM 绑定指示灯：相对图标容器定位，正下方居中 */}
              <span className="relative flex-shrink-0">
                {(conv as any).type === 'group' ? (
                  <MessagesSquare className="h-4 w-4" />
                ) : (
                  <MessageSquare className="h-4 w-4" />
                )}
                <span className="absolute left-1/2 -translate-x-1/2 top-full -mt-0.5 flex justify-center gap-px">
                  {(conv.wechat_bound === 1) && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500" title="微信" />
                  )}
                  {(conv.qq_bound === 1) && (
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500" title="QQ" />
                  )}
                </span>
              </span>
              {renamingId === conv.id ? (
                <input
                  ref={inputRef}
                  className="flex-1 text-sm bg-background border rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-ring"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') cancelRename()
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <ConversationTitle title={conv.title === 'New Chat' ? t('sidebar.newChat') : conv.title} />
              )}
              {(conv as any).type === 'group' && (conv as any).agent_count > 0 && (
                <span className="text-xs text-muted-foreground/60 flex-shrink-0">
                  ({(conv as any).agent_count + 1})
                </span>
              )}
              {renamingId !== conv.id && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={(e) => {
                    e.stopPropagation()
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setMenu((prev) => prev?.convId === conv.id ? null : { convId: conv.id, anchorRect: rect })
                  }}
                >
                  <MoreVertical className="h-3 w-3" />
                </Button>
              )}
            </div>
          ))}
          {conversations.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">{t('sidebar.noConversations')}</p>
          )}
        </div>
      </ScrollArea>

      {/* Context menu (portal to escape scroll/overflow) */}
      {menu && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] w-40 rounded-md border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95"
          style={{
            top: menu.anchorRect.bottom + 4,
            left: Math.max(8, menu.anchorRect.right - 160),
          }}
        >
          {(conversations.find((c) => c.id === menu.convId) as any)?.type === 'direct' && onContinueOnIm && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
              onClick={() => { const c = conversations.find((c) => c.id === menu.convId); onContinueOnIm(menu.convId, (c as any)?.agent_id || ''); closeMenu() }}
            >
              <Smartphone className="h-3.5 w-3.5" />
              {t('sidebar.continueOnIm')}
            </button>
          )}
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
            onClick={() => {
              const conv = conversations.find((c) => c.id === menu.convId)
              if (conv) startRename(conv)
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
            {t('sidebar.rename')}
          </button>
          {(conversations.find((c) => c.id === menu.convId) as any)?.type === 'group' && !(conversations.find((c) => c.id === menu.convId) as any)?.qq_bound && onManageGroupAgents && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
              onClick={() => { onManageGroupAgents(menu.convId); closeMenu() }}
            >
              <Users className="h-3.5 w-3.5" />
              {t('sidebar.groupMembers')}
            </button>
          )}
          {(conversations.find((c) => c.id === menu.convId) as any)?.type === 'group' && onMerge && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
              onClick={() => { onMerge(menu.convId); closeMenu() }}
            >
              <GitMerge className="h-3.5 w-3.5" />
              {t('sidebar.mergeGroupChat')}
            </button>
          )}
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
            onClick={() => { onExport(menu.convId); closeMenu() }}
          >
            <Download className="h-3.5 w-3.5" />
            {t('sidebar.saveAsMd')}
          </button>
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
            onClick={() => { onDelete(menu.convId); closeMenu() }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('sidebar.delete')}
          </button>
        </div>,
        document.body,
      )}

      {/* Bottom bar — user info + settings */}
      <div className="border-t flex items-center justify-between px-3" style={{ height: '60px' }}>
        {/* Left: user button with popover */}
        <button
          ref={userBtnRef}
          className="flex items-center gap-2 min-w-0 hover:bg-accent/50 rounded-md px-2 py-1 transition-colors"
          onClick={() => { setSettingsPopoverOpen(false); setUserPopoverOpen(!userPopoverOpen) }}
        >
          <User className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <span className="text-sm truncate">{currentUser}</span>
        </button>

        {/* Right: settings button with popover */}
        <button
          ref={settingsBtnRef}
          className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-accent/50 transition-colors"
          onClick={() => { setUserPopoverOpen(false); setSettingsPopoverOpen(!settingsPopoverOpen) }}
        >
          <Settings className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>

      {/* User popover */}
      {userPopoverOpen && createPortal(
        <div
          ref={userPopoverRef}
          className="fixed z-[9999] w-40 rounded-md border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95"
          style={{
            bottom: '68px',
            left: '12px',
          }}
        >
          {onChangeUsername && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
              onClick={() => { closeAllPopovers(); onChangeUsername() }}
            >
              <PencilLine className="h-3.5 w-3.5" />
              {t('menu.changeUsername')}
            </button>
          )}
          {onChangePin && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
              onClick={() => { closeAllPopovers(); onChangePin() }}
            >
              <Key className="h-3.5 w-3.5" />
              {t('menu.changePin')}
            </button>
          )}
          {onLinkAccount && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
              onClick={() => { closeAllPopovers(); onLinkAccount() }}
            >
              <Link className="h-3.5 w-3.5" />
              {t('menu.linkAccount')}
            </button>
          )}
          {onLogout && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
              onClick={() => { closeAllPopovers(); onLogout() }}
            >
              <LogOut className="h-3.5 w-3.5" />
              {t('menu.logout')}
            </button>
          )}
        </div>,
        document.body,
      )}

      {/* Settings popover */}
      {settingsPopoverOpen && createPortal(
        <div
          ref={settingsPopoverRef}
          className="fixed z-[9999] w-44 rounded-md border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95"
          style={{
            bottom: '68px',
            left: '100px',
          }}
        >
          {/* Language */}
          <div className="px-2 py-1.5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <Languages className="h-3 w-3" />
              {t('menu.language')}
            </div>
            <div className="flex gap-1">
              <button
                className={`flex-1 rounded-sm px-2 py-1 text-xs transition-colors whitespace-nowrap ${
                  language === 'zh-CN' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                }`}
                onClick={() => onLanguageChange?.('zh-CN')}
              >
                {t('menu.languageZhCN')}
              </button>
              <button
                className={`flex-1 rounded-sm px-2 py-1 text-xs transition-colors whitespace-nowrap ${
                  language === 'en' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                }`}
                onClick={() => onLanguageChange?.('en')}
              >
                {t('menu.languageEn')}
              </button>
              <button
                className={`flex-1 rounded-sm px-2 py-1 text-xs transition-colors whitespace-nowrap ${
                  language === 'ja' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                }`}
                onClick={() => onLanguageChange?.('ja')}
              >
                {t('menu.languageJa')}
              </button>
            </div>
          </div>

          {/* Theme */}
          <div className="px-2 py-1.5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
              <SunMoon className="h-3 w-3" />
              {t('menu.theme')}
            </div>
            <div className="flex gap-1">
              <button
                className={`flex-1 rounded-sm px-2 py-1 text-xs transition-colors ${
                  theme === 'light' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                }`}
                onClick={() => onThemeChange?.('light')}
              >
                {t('menu.themeLight')}
              </button>
              <button
                className={`flex-1 rounded-sm px-2 py-1 text-xs transition-colors ${
                  theme === 'dark' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50'
                }`}
                onClick={() => onThemeChange?.('dark')}
              >
                {t('menu.themeDark')}
              </button>
            </div>
          </div>

          {/* Docs */}
          {onDocs && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors mt-1"
              onClick={() => { closeAllPopovers(); onDocs() }}
            >
              <BookOpen className="h-3.5 w-3.5" />
              {t('menu.docs')}
            </button>
          )}
          {/* Admin settings */}
          {onAdminSettings && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors mt-1"
              onClick={() => { closeAllPopovers(); onAdminSettings() }}
            >
              <Wrench className="h-3.5 w-3.5" />
              {t('menu.adminSettings')}
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
}
