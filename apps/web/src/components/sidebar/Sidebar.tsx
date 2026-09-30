import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ScrollArea } from '../ui/scroll-area'
import { Button } from '../ui/button'
import { MarqueeText } from '../ui/MarqueeText'
import { Plus, MessageSquare, MessagesSquare, MoreVertical, Download, Trash2, Pencil, Settings, User, Users, LogOut, Key, Link, PencilLine, Languages, SunMoon, Wrench, Smartphone, GitMerge, BookOpen, Brain, Bell, BellOff, Map, Scale, Search, FolderPlus, Folder, ChevronDown, ChevronRight, Archive } from 'lucide-react'
import { Github } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Conversation, Workspace } from '@momoi/shared/types'
import type { Theme } from '../../hooks/useTheme'

interface SidebarProps {
  conversations: Conversation[]
  workspaces: Workspace[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onNewGroup: () => void
  onRename: (id: string, title: string) => void
  /** 归档会话（服务端软删除：从列表移除、自动解绑 IM，数据保留） */
  onArchive: (id: string) => void
  onExport: (id: string) => void
  /** 打开会话搜索对话框 */
  onOpenSearch: () => void
  /** 新建工作区 */
  onNewWorkspace: () => void
  /** 重命名工作区 */
  onRenameWorkspace: (id: string, name: string) => void
  /** 删除工作区：成员会话变为未分组（workspace_id 悬空），文件保留 */
  onDeleteWorkspace: (id: string) => void
  /** 在指定工作区内新建会话（创建时锁定到该工作区） */
  onNewInWorkspace: (wsId: string) => void
  onMerge?: (convId: string) => void
  onManageGroupAgents?: (convId: string) => void
  onManageWorldMembers?: (convId: string) => void
  onEditWorldLaws?: (convId: string) => void
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
  onMemory?: () => void
  /** Clicking the app name reopens the first-use introduction. */
  onShowIntro?: () => void
  /** Stand-alone mode: show a badge next to the app name. */
  standAlone?: boolean
  /** Push notification toggle — shown only when browser supports Web Push. */
  pushSupported?: boolean
  pushEnabled?: boolean
  onPushToggle?: () => void
  /** 未读计数：conversation_id → 未读 assistant 消息数 */
  unreadCounts?: Record<string, number>
}

type MenuState =
  | { kind: 'conv'; convId: string; anchorRect: DOMRect }
  | { kind: 'ws'; wsId: string; anchorRect: DOMRect }

// ConversationTitle is now MarqueeText from ../ui/MarqueeText

export const Sidebar = React.memo(function Sidebar({ conversations, workspaces, activeId, onSelect, onNew, onNewGroup, onRename, onArchive, onExport, onOpenSearch, onNewWorkspace, onRenameWorkspace, onDeleteWorkspace, onNewInWorkspace, onMerge, onManageGroupAgents, onManageWorldMembers, onEditWorldLaws, onContinueOnIm, appName, currentUser, showGithub = true, onChangePin, onChangeUsername, onLinkAccount, onLogout, language, onLanguageChange, theme, onThemeChange, onAdminSettings, onDocs, onMemory, onShowIntro, standAlone, pushSupported, pushEnabled, onPushToggle, unreadCounts }: SidebarProps) {
  const LANGUAGE_OPTIONS = ['zh-CN', 'en', 'ja'] as const
  const { t, i18n } = useTranslation()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  /** 工作区行内重命名（复刻会话重命名交互） */
  const [renamingWsId, setRenamingWsId] = useState<string | null>(null)
  const [wsRenameValue, setWsRenameValue] = useState('')
  /** 工作区折叠状态（持久化到 localStorage） */
  const [wsCollapsed, setWsCollapsed] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('momoi_ws_collapsed') || '{}') } catch { return {} }
  })
  const inputRef = useRef<HTMLInputElement>(null)
  const wsInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const userPopoverRef = useRef<HTMLDivElement>(null)
  const settingsPopoverRef = useRef<HTMLDivElement>(null)
  const userBtnRef = useRef<HTMLButtonElement>(null)
  const settingsBtnRef = useRef<HTMLButtonElement>(null)
  const [userPopoverOpen, setUserPopoverOpen] = useState(false)
  const [settingsPopoverOpen, setSettingsPopoverOpen] = useState(false)

  /** 未分组 = 无 workspace_id，或指向已删除的工作区（悬空防御——删除工作区后
   *  成员会话的 workspace_id 原样保留，按未分组渲染但沙箱仍锚定原目录） */
  const ungrouped = conversations.filter(
    (c) => !c.workspace_id || !workspaces.some((w) => w.id === c.workspace_id),
  )
  const membersOf = useCallback(
    (wsId: string) => conversations.filter((c) => c.workspace_id === wsId),
    [conversations],
  )

  const toggleCollapse = useCallback((wsId: string) => {
    setWsCollapsed((prev) => {
      const next = { ...prev, [wsId]: !prev[wsId] }
      try { localStorage.setItem('momoi_ws_collapsed', JSON.stringify(next)) } catch { /* 私有模式等场景忽略 */ }
      return next
    })
  }, [])

  // Stand-alone mode passes none of the user-menu callbacks: the popover would
  // be an empty box, so the user button only displays the identity.
  const userMenuHasItems = !!(onChangeUsername || onChangePin || onLinkAccount || onLogout)

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

  const startWsRename = useCallback((ws: Workspace) => {
    setRenamingWsId(ws.id)
    setWsRenameValue(ws.name)
    closeMenu()
    requestAnimationFrame(() => wsInputRef.current?.select())
  }, [closeMenu])

  const commitWsRename = useCallback(() => {
    if (renamingWsId) {
      const trimmed = wsRenameValue.trim()
      if (trimmed) {
        onRenameWorkspace(renamingWsId, trimmed)
      }
    }
    setRenamingWsId(null)
    setWsRenameValue('')
  }, [renamingWsId, wsRenameValue, onRenameWorkspace])

  const cancelWsRename = useCallback(() => {
    setRenamingWsId(null)
    setWsRenameValue('')
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

  /** 单条会话行（工作区分组 / 未分组平铺同源渲染） */
  const renderConversationItem = (conv: Conversation) => (
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
        {conv.type === 'world' ? (
          <Map className="h-4 w-4" />
        ) : conv.type === 'group' ? (
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
        <MarqueeText text={conv.title === "New Chat" ? t("sidebar.newChat") : conv.title} />
      )}
      {(conv as any).type === 'group' && (conv as any).agent_count > 0 && (
        <span className="text-xs text-muted-foreground/60 flex-shrink-0">
          ({(conv as any).agent_count + 1})
        </span>
      )}
      {unreadCounts?.[conv.id] && unreadCounts[conv.id] > 0 && activeId !== conv.id && (
        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none flex-shrink-0">
          {unreadCounts[conv.id] > 99 ? '99+' : unreadCounts[conv.id]}
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
            setMenu((prev) => prev?.kind === 'conv' && prev.convId === conv.id ? null : { kind: 'conv', convId: conv.id, anchorRect: rect })
          }}
        >
          <MoreVertical className="h-3 w-3" />
        </Button>
      )}
    </div>
  )

  return (
    <div className="flex flex-col h-full w-72 bg-card">
      {/* App name + GitHub */}
      <div className="flex items-center justify-between px-4 border-b" style={{ height: '60px' }}>
        <h1 className="text-lg font-semibold flex items-center gap-1.5">
          {onShowIntro ? (
            <button
              type="button"
              onClick={onShowIntro}
              title={t('intro.openFromSidebar')}
              aria-label={t('intro.openFromSidebar')}
              className="text-left rounded-sm -ml-1 px-1 py-0.5 transition-colors cursor-pointer hover:text-primary hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {appName}
            </button>
          ) : appName}
          {standAlone && <span className="inline-flex items-center justify-center h-[18px] w-[18px] rounded-[4px] bg-black text-white dark:bg-white dark:text-black text-[11px] font-bold leading-none">S</span>}
        </h1>
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

      {/* Workspace label + actions（会话搜索 / 添加工作区） */}
      <div className="flex items-center justify-between px-4 pb-1">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {t('sidebar.workspace')}
        </span>
        <span className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title={t('sidebar.searchConversations')}
            onClick={onOpenSearch}
          >
            <Search className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title={t('sidebar.addWorkspace')}
            onClick={onNewWorkspace}
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
        </span>
      </div>

      {/* Workspace folders + ungrouped flat list */}
      <ScrollArea className="flex-1 sidebar-scroll-area">
        <div className="px-2 pb-2 space-y-1">
          {workspaces.map((ws) => {
            const members = membersOf(ws.id)
            const collapsed = !!wsCollapsed[ws.id]
            return (
              <div key={ws.id}>
                <div
                  className={`group flex items-center gap-1.5 px-2 py-1.5 rounded-md cursor-pointer transition-colors text-sm ${
                    renamingWsId === ws.id ? 'bg-accent/50' : 'hover:bg-accent/50'
                  }`}
                  onClick={() => { if (renamingWsId !== ws.id) toggleCollapse(ws.id) }}
                >
                  {collapsed
                    ? <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                    : <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />}
                  <Folder className="h-4 w-4 flex-shrink-0" />
                  {renamingWsId === ws.id ? (
                    <input
                      ref={wsInputRef}
                      className="flex-1 min-w-0 text-sm bg-background border rounded px-1.5 py-0.5 outline-none focus:ring-1 focus:ring-ring"
                      value={wsRenameValue}
                      onChange={(e) => setWsRenameValue(e.target.value)}
                      onBlur={commitWsRename}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitWsRename()
                        if (e.key === 'Escape') cancelWsRename()
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="flex-1 min-w-0 truncate">{ws.name}</span>
                  )}
                  {members.length > 0 && (
                    <span className="text-xs text-muted-foreground/60 flex-shrink-0">({members.length})</span>
                  )}
                  {renamingWsId !== ws.id && (
                    <span className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        title={t('sidebar.newInWorkspace')}
                        onClick={(e) => { e.stopPropagation(); onNewInWorkspace(ws.id) }}
                      >
                        <Plus className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={(e) => {
                          e.stopPropagation()
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                          setMenu((prev) => prev?.kind === 'ws' && prev.wsId === ws.id ? null : { kind: 'ws', wsId: ws.id, anchorRect: rect })
                        }}
                      >
                        <MoreVertical className="h-3 w-3" />
                      </Button>
                    </span>
                  )}
                </div>
                {!collapsed && members.map(renderConversationItem)}
              </div>
            )
          })}
          {/* 未分组平铺列表（含删除工作区后的悬空会话） */}
          {workspaces.length > 0 && ungrouped.length > 0 && (
            <div className="px-4 pt-2 pb-1">
              <span className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wider">
                {t('sidebar.ungrouped')}
              </span>
            </div>
          )}
          {ungrouped.map(renderConversationItem)}
          {conversations.length === 0 && workspaces.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">{t('sidebar.noConversations')}</p>
          )}
        </div>
      </ScrollArea>

      {/* Context menu (portal to escape scroll/overflow) */}
      {menu?.kind === 'conv' && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] w-40 rounded-md border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95"
          style={{
            top: menu.anchorRect.bottom + 4,
            left: Math.max(8, menu.anchorRect.right - 160),
          }}
        >
          {/* 世界：世界法则、世界成员 开头 */}
          {(conversations.find((c) => c.id === menu.convId))?.type === 'world' && onEditWorldLaws && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
              onClick={() => { onEditWorldLaws(menu.convId); closeMenu() }}
            >
              <Scale className="h-3.5 w-3.5" />
              {t('workflow.editLaws')}
            </button>
          )}
          {(conversations.find((c) => c.id === menu.convId))?.type === 'world' && onManageWorldMembers && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
              onClick={() => { onManageWorldMembers(menu.convId); closeMenu() }}
            >
              <Users className="h-3.5 w-3.5" />
              {t('sidebar.worldMembers')}
            </button>
          )}
          {/* 私聊：在 IM 上继续 开头 */}
          {(conversations.find((c) => c.id === menu.convId) as any)?.type === 'direct' && onContinueOnIm && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
              onClick={() => { const c = conversations.find((c) => c.id === menu.convId); onContinueOnIm(menu.convId, (c as any)?.agent_id || ''); closeMenu() }}
            >
              <Smartphone className="h-3.5 w-3.5" />
              {t('sidebar.continueOnIm')}
            </button>
          )}
          {/* 群聊：群成员、合并群聊 开头 */}
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
          {/* 三者通用：重命名、另存为 Markdown、归档 始终排在最后 */}
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
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
            onClick={() => { onExport(menu.convId); closeMenu() }}
          >
            <Download className="h-3.5 w-3.5" />
            {t('sidebar.saveAsMd')}
          </button>
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
            onClick={() => { onArchive(menu.convId); closeMenu() }}
          >
            <Archive className="h-3.5 w-3.5" />
            {t('sidebar.archive')}
          </button>
        </div>,
        document.body,
      )}

      {/* Workspace menu (portal) */}
      {menu?.kind === 'ws' && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[9999] w-40 rounded-md border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95"
          style={{
            top: menu.anchorRect.bottom + 4,
            left: Math.max(8, menu.anchorRect.right - 160),
          }}
        >
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
            onClick={() => {
              const ws = workspaces.find((w) => w.id === menu.wsId)
              if (ws) startWsRename(ws)
            }}
          >
            <Pencil className="h-3.5 w-3.5" />
            {t('sidebar.renameWorkspace')}
          </button>
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10 transition-colors"
            onClick={() => { onDeleteWorkspace(menu.wsId); closeMenu() }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('sidebar.deleteWorkspace')}
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
          onClick={() => { setSettingsPopoverOpen(false); if (userMenuHasItems) setUserPopoverOpen(!userPopoverOpen) }}
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
          {/* Language — cycle through options */}
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
            onClick={() => {
              const idx = (LANGUAGE_OPTIONS as readonly string[]).indexOf(language ?? 'zh-CN')
              onLanguageChange?.((LANGUAGE_OPTIONS as readonly string[])[(idx + 1) % LANGUAGE_OPTIONS.length])
            }}
          >
            <Languages className="h-3.5 w-3.5" />
            <span className="flex-1 text-left">{t('menu.language')}</span>
            <span className="text-xs text-muted-foreground">
              {{ 'zh-CN': t('menu.languageZhCN'), en: t('menu.languageEn'), ja: t('menu.languageJa') }[(language as string) ?? 'zh-CN']}
            </span>
          </button>

          {/* Theme — cycle light/dark */}
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
            onClick={() => onThemeChange?.(theme === 'dark' ? 'light' : 'dark')}
          >
            <SunMoon className="h-3.5 w-3.5" />
            <span className="flex-1 text-left">{t('menu.theme')}</span>
            <span className="text-xs text-muted-foreground">
              {theme === 'dark' ? t('menu.themeDark') : t('menu.themeLight')}
            </span>
          </button>

          {/* Push notifications — only shown when browser supports Web Push */}
          {pushSupported && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
              onClick={onPushToggle}
            >
              {pushEnabled ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
              <span className="flex-1 text-left">{t('menu.pushNotifications')}</span>
              <span className={`text-xs ${pushEnabled ? 'text-emerald-400' : 'text-muted-foreground'}`}>
                {pushEnabled ? t('menu.on') : t('menu.off')}
              </span>
            </button>
          )}

          {/* Docs */}
          {onDocs && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
              onClick={() => { closeAllPopovers(); onDocs() }}
            >
              <BookOpen className="h-3.5 w-3.5" />
              <span className="flex-1 text-left">{t('menu.docs')}</span>
            </button>
          )}
          {/* Memory management */}
          {onMemory && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
              onClick={() => { closeAllPopovers(); onMemory() }}
            >
              <Brain className="h-3.5 w-3.5" />
              <span className="flex-1 text-left">{t('menu.memory')}</span>
            </button>
          )}
          {/* Admin settings */}
          {onAdminSettings && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
              onClick={() => { closeAllPopovers(); onAdminSettings() }}
            >
              <Wrench className="h-3.5 w-3.5" />
              <span className="flex-1 text-left">{t('menu.adminSettings')}</span>
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  )
})
