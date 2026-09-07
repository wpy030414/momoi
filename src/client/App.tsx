import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useChat } from './hooks/useChat'
import { useAdmin } from './hooks/useAdmin'
import { useTheme } from './hooks/useTheme'
import { Sidebar } from './components/sidebar/Sidebar'
import { ChatPanel } from './components/chat/ChatPanel'
import { AdminScreen } from './components/admin/AdminScreen'
import { MenuDialog } from './components/settings/MenuDialog'
import { ChangePinDialog } from './components/settings/ChangePinDialog'
import { LoginScreen } from './components/auth/LoginScreen'
import { Button } from './components/ui/button'
import { PanelLeft } from 'lucide-react'
import { api, getUser, setToken } from './lib/api'

export function App() {
  const { t, i18n } = useTranslation()
  const chat = useChat()
  const admin = useAdmin()
  const { theme, setTheme } = useTheme()
  const [adminViewOpen, setAdminViewOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [changePinOpen, setChangePinOpen] = useState(false)
  const [appName, setAppName] = useState('Open Agent')
  const [backgroundImage, setBackgroundImage] = useState('')
  const [supportAttachments, setSupportAttachments] = useState(false)
  const [showGithub, setShowGithub] = useState(true)
  const [currentUser, setCurrentUser] = useState<string | null>(() => getUser())
  const [agents, setAgents] = useState<Array<{ id: string; name: string; avatar: string }>>([])
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth >= 768
    }
    return false
  })

  const handleLogin = (username: string, token: string) => {
    localStorage.setItem('user', username)
    setToken(token)
    setCurrentUser(username)
    // Reload conversations for the new user
    setTimeout(() => chat.refreshConversations(), 100)
  }

  const handleLogout = () => {
    localStorage.removeItem('user')
    setToken(null)
    setCurrentUser(null)
    // Clear current session
    chat.createConversation()
  }

  // Listen for auth:expired events dispatched by the API layer
  // when a 401 response is received (token invalid/expired).
  useEffect(() => {
    const onAuthExpired = () => handleLogout()
    window.addEventListener('auth:expired', onAuthExpired)
    return () => window.removeEventListener('auth:expired', onAuthExpired)
  }, [])

  useEffect(() => {
    api.getAppName().then((r) => {
      setAppName(r.app_name)
      if (r.app_favicon) {
        const link = document.getElementById('favicon') as HTMLLinkElement | null
        if (link) link.href = r.app_favicon
      }
      if (r.app_background) {
        setBackgroundImage(r.app_background)
      }
      setSupportAttachments(!!r.support_attachments)
      setShowGithub(r.show_github !== false)
      if (r.agents?.length > 0) {
        setAgents(r.agents)
        setSelectedAgentId((prev) => prev && r.agents.some((a) => a.id === prev) ? prev : r.agents[0].id)
      }
    }).catch(() => {})
  }, [])

  // Re-fetch appName + agents when admin view closes (user may have changed them)
  useEffect(() => {
    if (!adminViewOpen) {
      api.getAppName().then((r) => {
        setAppName(r.app_name)
        if (r.app_favicon) {
          const link = document.getElementById('favicon') as HTMLLinkElement | null
          if (link) link.href = r.app_favicon
        }
        setBackgroundImage(r.app_background || '')
        setSupportAttachments(!!r.support_attachments)
        setShowGithub(r.show_github !== false)
        if (r.agents?.length > 0) {
          setAgents(r.agents)
          setSelectedAgentId((prev) => prev && r.agents.some((a) => a.id === prev) ? prev : r.agents[0].id)
        } else {
          setAgents([])
          setSelectedAgentId(null)
        }
      }).catch(() => {})
    }
  }, [adminViewOpen])

  // Update document title when appName changes
  useEffect(() => {
    document.title = appName
  }, [appName])

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 767px)')
    const handleChange = (e: MediaQueryListEvent) => {
      if (e.matches) {
        setSidebarOpen(false)
      }
    }
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  const handleLanguageChange = (lang: string) => {
    i18n.changeLanguage(lang)
  }

  const handleAdminSettings = () => {
    setMenuOpen(false)
    // Radix Dialog 关闭时需要等待焦点管理完成，再打开新页面
    setTimeout(() => {
      setAdminViewOpen(true)
      history.pushState(null, '', '#/settings')
    }, 300)
  }

  const closeAdminView = () => {
    setAdminViewOpen(false)
    // Clear hash if currently on settings
    if (window.location.hash === '#/settings') {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }

  // Sync adminViewOpen with hash #/settings (mount + browser back/forward)
  useEffect(() => {
    const onHashChange = () => {
      setAdminViewOpen(window.location.hash === '#/settings')
    }
    // Check on mount
    if (window.location.hash === '#/settings') {
      setAdminViewOpen(true)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Show admin settings as full-page view (accessible even without login)
  if (adminViewOpen) {
    return <AdminScreen onBack={closeAdminView} admin={admin} />
  }

  // Show login screen if not logged in
  if (!currentUser) {
    return <LoginScreen onLogin={handleLogin} />
  }

  return (
    <div className="flex h-full overflow-hidden bg-background">
      {/* Sidebar */}
      <div className={`
        w-72 flex-shrink-0 border-r
        transition-all duration-300 overflow-hidden
        max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50
        ${sidebarOpen ? '' : 'max-md:w-0 md:w-0 md:border-r-0'}
      `}>
        <Sidebar
          conversations={chat.conversations}
          activeId={chat.activeId}
          onSelect={chat.selectConversation}
          onNew={chat.createConversation}
          onRename={chat.renameConversation}
          onDelete={chat.deleteConversation}
          onExport={chat.exportConversation}
          onMenuClick={() => setMenuOpen(true)}
          appName={appName}
          currentUser={currentUser}
          showGithub={showGithub}
        />
      </div>

      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0 relative">
        {/* Sidebar toggle button */}
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-[14px] left-3 z-30 h-8 w-8 hover:bg-accent/50"
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <PanelLeft className="h-4 w-4" />
        </Button>

        {/* Chat area */}
        <ChatPanel
          messages={chat.messages}
          loading={chat.loading}
          onSend={chat.sendMessage}
          onCancel={chat.cancel}
          onRevert={chat.revertMessage}
          backgroundImage={backgroundImage}
          supportAttachments={supportAttachments}
          agents={agents}
          selectedAgentId={selectedAgentId}
          onAgentChange={setSelectedAgentId}
        />
      </div>

      {/* Menu Dialog */}
      <MenuDialog
        open={menuOpen}
        onOpenChange={setMenuOpen}
        language={i18n.language}
        onLanguageChange={handleLanguageChange}
        theme={theme}
        onThemeChange={setTheme}
        onAdminSettings={handleAdminSettings}
        currentUser={currentUser}
        onLogout={handleLogout}
        onChangePin={() => setChangePinOpen(true)}
      />

      {/* Change PIN Dialog */}
      <ChangePinDialog
        open={changePinOpen}
        onOpenChange={setChangePinOpen}
        username={currentUser}
      />
    </div>
  )
}