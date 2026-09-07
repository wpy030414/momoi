import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ScrollArea } from '../ui/scroll-area'
import { Button } from '../ui/button'
import { Plus, MessageSquare, MessagesSquare, MoreVertical, Download, Trash2, Pencil, Settings, User, Users } from 'lucide-react'
import { Github } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Conversation } from '@/shared/types'

interface SidebarProps {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onNewGroup: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onExport: (id: string) => void
  onMenuClick: () => void
  onManageGroupAgents?: (convId: string) => void
  appName: string
  currentUser: string
  showGithub?: boolean
}

interface MenuState {
  convId: string
  anchorRect: DOMRect
}

export function Sidebar({ conversations, activeId, onSelect, onNew, onNewGroup, onRename, onDelete, onExport, onMenuClick, onManageGroupAgents, appName, currentUser, showGithub = true }: SidebarProps) {
  const { t } = useTranslation()
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const closeMenu = useCallback(() => setMenu(null), [])

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

  return (
    <div className="flex flex-col h-full w-72 bg-card">
      {/* App name + GitHub */}
      <div className="flex items-center justify-between px-4 border-b" style={{ height: '60px' }}>
        <h1 className="text-lg font-semibold">{appName}</h1>
        {showGithub && (
          <a
            href="https://github.com/wpy030414/open-agent"
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
          <MessagesSquare className="h-4 w-4" />
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
      <ScrollArea className="flex-1">
        <div className="px-2 pb-2 space-y-1">
          {conversations.map((conv) => (
            <div
              key={conv.id}
              className={`group flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer transition-colors ${
                activeId === conv.id
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/50'
              }`}
              onClick={() => { if (renamingId !== conv.id) onSelect(conv.id) }}
            >
              {(conv as any).type === 'group' ? (
                <MessagesSquare className="h-4 w-4 flex-shrink-0" />
              ) : (
                <MessageSquare className="h-4 w-4 flex-shrink-0" />
              )}
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
                <span className="flex-1 text-sm truncate">{conv.title}</span>
              )}
              {renamingId !== conv.id && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
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
          {(conversations.find((c) => c.id === menu.convId) as any)?.type === 'group' && onManageGroupAgents && (
            <button
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
              onClick={() => { onManageGroupAgents(menu.convId); closeMenu() }}
            >
              <Users className="h-3.5 w-3.5" />
              {t('sidebar.groupMembers')}
            </button>
          )}
          <button
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 transition-colors"
            onClick={() => { onExport(menu.convId); closeMenu() }}
          >
            <Download className="h-3.5 w-3.5" />
            {t('sidebar.saveAsTxt')}
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
        <div className="flex items-center gap-2 min-w-0 ml-2">
          <User className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <span className="text-sm truncate">{currentUser}</span>
        </div>
        <button
          onClick={onMenuClick}
          className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-accent/50 transition-colors"
        >
          <Settings className="h-4 w-4 text-muted-foreground" />
        </button>
      </div>
    </div>
  )
}
