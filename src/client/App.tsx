import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useGroupChat } from './hooks/useGroupChat'
import { useTheme } from './hooks/useTheme'
import { Sidebar } from './components/sidebar/Sidebar'
import { AdminSidebar } from './components/admin/AdminSidebar'
import { ChatPanel } from './components/chat/ChatPanel'
import { ChangePinDialog } from './components/settings/ChangePinDialog'
import { ChangeUsernameDialog } from './components/settings/ChangeUsernameDialog'
import { LinkedAccountsDialog } from './components/settings/LinkedAccountsDialog'
import { LoginScreen } from './components/auth/LoginScreen'
import { OAuthRegisterScreen } from './components/auth/OAuthRegisterScreen'
import { AgentManager, type AgentManagerHandle } from './components/admin/tabs/AgentManager'
import { GatewaySettings, type GatewaySettingsHandle } from './components/admin/tabs/GatewaySettings'
import { BrandingSettings } from './components/admin/tabs/BrandingSettings'
import { McpManager, type McpManagerHandle } from './components/admin/tabs/McpManager'
import { SkillManager, type SkillManagerHandle } from './components/admin/tabs/SkillManager'
import { ReviewPanel } from './components/admin/tabs/ReviewPanel'
import { UserManager, type UserManagerHandle } from './components/admin/tabs/UserManager'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './components/ui/dialog'
import { PanelLeft, X, Check, Plus, RotateCcw, Upload, Server } from 'lucide-react'
import { api, getUser, clearSession, setSessionExpiry, getTokenExpiresAt } from './lib/api'

export function App() {
  const { t, i18n } = useTranslation()
  const chat = useGroupChat()
  const { theme, setTheme } = useTheme()
  const [adminViewOpen, setAdminViewOpen] = useState(false)
  // Active tab in the admin management sidebar
  const [adminTab, setAdminTab] = useState('agent')
  // Refs to tab action-triggers (exposed via useImperativeHandle)
  const agentRef = useRef<AgentManagerHandle>(null)
  const gatewayRef = useRef<GatewaySettingsHandle>(null)
  const mcpRef = useRef<McpManagerHandle>(null)
  const skillRef = useRef<SkillManagerHandle>(null)
  const userRef = useRef<UserManagerHandle>(null)
  const [changePinOpen, setChangePinOpen] = useState(false)
  const [changeUsernameOpen, setChangeUsernameOpen] = useState(false)
  const [linkedAccountsOpen, setLinkedAccountsOpen] = useState(false)
  const [oauthRegisterInfo, setOauthRegisterInfo] = useState<{ providerId: string; providerUserId: string } | null>(null)
  const [appName, setAppName] = useState('Momoi')
  const [backgroundImage, setBackgroundImage] = useState('')
  const [supportAttachments, setSupportAttachments] = useState(false)
  const [supportInfiniteMode, setSupportInfiniteMode] = useState(true)
  const [showGithub, setShowGithub] = useState(true)
  const [recommendedQuestions, setRecommendedQuestions] = useState<string[]>([])
  const [currentUser, setCurrentUser] = useState<string | null>(() => getUser())
  // Admin status of the logged-in user (ADMIN usernames from server .env)
  const [isAdminUser, setIsAdminUser] = useState(false)

  // OAuth2 callback → sync localStorage from query params, then clean URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const oauthUser = params.get('oauth_user')
    const oauthExpires = params.get('oauth_expires')
    const oauthRegister = params.get('oauth_register')
    const providerId = params.get('provider_id')
    const providerUserId = params.get('provider_user_id')

    if (oauthRegister === '1' && providerId && providerUserId) {
      setOauthRegisterInfo({ providerId, providerUserId })
      // Clean query params from URL without reload
      const url = new URL(window.location.href)
      url.searchParams.delete('oauth_register')
      url.searchParams.delete('provider_id')
      url.searchParams.delete('provider_user_id')
      history.replaceState(null, '', url.toString())
      return
    }

    if (oauthUser) {
      localStorage.setItem('user', oauthUser)
      if (oauthExpires) {
        const exp = Number(oauthExpires)
        if (Number.isFinite(exp)) setSessionExpiry(exp)
      }
      setCurrentUser(oauthUser)
      // Clean query params from URL without reload
      const url = new URL(window.location.href)
      url.searchParams.delete('oauth_user')
      url.searchParams.delete('oauth_expires')
      url.searchParams.delete('oauth_error')
      history.replaceState(null, '', url.toString())
    }
  }, [])
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768)
  const [agents, setAgents] = useState<Array<{ id: string; name: string; avatar: string }>>([])
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  // 移动端判定走 JS（不依赖 CSS 媒体查询）——钉钉 Android 内置内核会丢弃
  // 响应式规则，导致侧边栏在那里永远展开、无法收起。
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768)

  // Group chat: agent selection dialog
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [selectedGroupAgents, setSelectedGroupAgents] = useState<string[]>([])
  const [groupManageOpen, setGroupManageOpen] = useState(false)
  const [groupManageConvId, setGroupManageConvId] = useState<string | null>(null)
  const [infiniteMode, setInfiniteMode] = useState(false)

  // Delete confirmation
  const [deleteConvId, setDeleteConvId] = useState<string | null>(null)
  const [deleteConvTitle, setDeleteConvTitle] = useState('')

  // Toggle infinite mode: notify server to enable/disable the loop
  const handleInfiniteModeChange = async (enabled: boolean) => {
    setInfiniteMode(enabled)
    if (chat.activeId) {
      api.setInfiniteMode(chat.activeId, enabled).catch(console.error)
    }
  }

  // Ensure a conversation exists for file upload — create one lazily if needed
  const ensureConversation = useCallback(async (): Promise<string> => {
    if (chat.activeId) return chat.activeId
    const { conversation } = await api.createConversation()
    await chat.selectConversation(conversation.id)
    return conversation.id
  }, [chat.activeId, chat.selectConversation])

  // When admin disables support_infinite_mode, force-disable any active infinite loop
  useEffect(() => {
    if (!supportInfiniteMode && infiniteMode) {
      setInfiniteMode(false)
      if (chat.activeId) {
        api.setInfiniteMode(chat.activeId, false).catch(console.error)
      }
    }
  }, [supportInfiniteMode])

  // Open group agent management dialog
  const handleManageGroupAgents = async (convId: string) => {
    setGroupManageConvId(convId)
    // Pre-fetch current agents so the selection is initialized correctly
    try {
      const res = await api.getConversation(convId)
      if (res.agents) {
        setSelectedGroupAgents(res.agents.map((a: { id: string }) => a.id))
      } else {
        setSelectedGroupAgents(chat.groupAgents.map((a: { id: string }) => a.id))
      }
    } catch {
      setSelectedGroupAgents(chat.groupAgents.map((a: { id: string }) => a.id))
    }
    setGroupManageOpen(true)
  }

  // Delete conversation with confirmation
  const handleDeleteConversation = (id: string) => {
    const conv = chat.conversations.find((c) => c.id === id)
    setDeleteConvId(id)
    setDeleteConvTitle(conv?.title || '')
  }

  const confirmDeleteConversation = async () => {
    if (!deleteConvId) return
    await chat.deleteConversation(deleteConvId)
    setDeleteConvId(null)
    setDeleteConvTitle('')
  }

  const handleLogin = (username: string, expiresAt?: number) => {
    localStorage.setItem('user', username)
    setSessionExpiry(expiresAt)
    setCurrentUser(username)
    // Reload conversations for the new user
    setTimeout(() => chat.refreshConversations(), 100)
  }

  const handleLogout = () => {
    // Ask the server to clear the HttpOnly cookie (JS cannot delete it)
    api.logout().catch(() => {})
    clearSession()
    setCurrentUser(null)
    setIsAdminUser(false)
    // Leave admin view (if open) and return home
    setAdminViewOpen(false)
    if (window.location.hash === '#/settings') {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
    // Clear current session
    chat.createConversation()
  }

  // Detect admin status for the logged-in user
  useEffect(() => {
    if (!currentUser) {
      setIsAdminUser(false)
      return
    }
    api.getMe()
      .then((r) => setIsAdminUser(!!r.is_admin))
      .catch(() => setIsAdminUser(false))
  }, [currentUser])

  // Auto-renew the JWT (14-day TTL) once less than half its life remains —
  // sliding session. While the tab is alive the token never runs out; after
  // 14 days without the app open, the token is gone and PIN login is required.
  useEffect(() => {
    if (!currentUser) return
    // Keep in sync with USER_TOKEN_TTL_SECONDS (src/server/auth.ts)
    const TOKEN_TTL_SEC = 14 * 24 * 60 * 60
    const RENEW_WINDOW_SEC = TOKEN_TTL_SEC / 2 // renew when less than half remains
    const RETRY_MS = 5 * 60 * 1000 // network failure retry interval
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false

    const schedule = () => {
      if (stopped) return
      const exp = getTokenExpiresAt()
      if (!exp) { renew(); return } // legacy token without stored expiry — refresh once to learn it
      const waitMs = (exp - RENEW_WINDOW_SEC) * 1000 - Date.now()
      if (waitMs <= 0) { renew(); return }
      timer = setTimeout(renew, Math.min(waitMs, 2 ** 31 - 1))
    }

    const renew = async () => {
      if (stopped) return
      try {
        const res = await api.refreshToken()
        setSessionExpiry(res.expires_at)
        schedule()
      } catch {
        // 401 already triggers the auth:expired logout; other failures retry later
        if (!stopped) timer = setTimeout(renew, RETRY_MS)
      }
    }

    const onWake = () => { if (document.visibilityState === 'visible') schedule() }
    schedule()
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
    }
  }, [currentUser])

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
      setSupportInfiniteMode(r.support_infinite_mode !== false)
      setShowGithub(r.show_github !== false)
      setRecommendedQuestions(r.recommended_questions || [])
      if (r.agents?.length > 0) {
        setAgents(r.agents)
        setSelectedAgentId((prev) => prev && r.agents.some((a) => a.id === prev) ? prev : r.agents[0].id)
      }
    }).catch(() => {}).finally(() => setAgentsLoading(false))
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
        setSupportInfiniteMode(r.support_infinite_mode !== false)
        setShowGithub(r.show_github !== false)
        setRecommendedQuestions(r.recommended_questions || [])
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

  // 监听视口宽度：切到移动端尺寸时自动收起侧边栏
  useEffect(() => {
    let wasMobile = window.innerWidth < 768
    const handleResize = () => {
      const mobile = window.innerWidth < 768
      setIsMobile(mobile)
      if (mobile && !wasMobile) setSidebarOpen(false)
      wasMobile = mobile
    }
    window.addEventListener('resize', handleResize)
    window.addEventListener('orientationchange', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      window.removeEventListener('orientationchange', handleResize)
    }
  }, [])

  const handleLanguageChange = (lang: string) => {
    i18n.changeLanguage(lang)
  }

  const handleAdminSettings = () => {
    // Radix Dialog 关闭时需要等待焦点管理完成，再打开新页面
    setTimeout(() => {
      setAdminViewOpen(true)
      history.pushState(null, '', `#/settings/${adminTab}`)
    }, 300)
  }

  const handleAdminTabChange = (tab: string) => {
    setAdminTab(tab)
    history.pushState(null, '', `#/settings/${tab}`)
  }

  const closeAdminView = () => {
    setAdminViewOpen(false)
    // Clear hash if currently on settings
    if (window.location.hash.startsWith('#/settings')) {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }

  // Route guard: #/settings/{tab} only opens for admins (mount + browser back/forward).
  // Anyone else typing the path is bounced back home.
  useEffect(() => {
    const leaveAdminRoute = () => {
      setAdminViewOpen(false)
      if (window.location.hash.startsWith('#/settings')) {
        history.replaceState(null, '', window.location.pathname + window.location.search)
      }
    }
    const syncAdminRoute = () => {
      const match = window.location.hash.match(/^#\/settings(?:\/(\w+))?$/)
      if (match) {
        if (isAdminUser) {
          const tab = match[1]
          if (tab) setAdminTab(tab)
          setAdminViewOpen(true)
        } else {
          leaveAdminRoute()
        }
      } else {
        setAdminViewOpen(false)
      }
    }
    syncAdminRoute()
    window.addEventListener('hashchange', syncAdminRoute)
    return () => window.removeEventListener('hashchange', syncAdminRoute)
  }, [isAdminUser])

  // Show OAuth2 registration screen for new OAuth users
  if (oauthRegisterInfo) {
    return (
      <OAuthRegisterScreen
        providerId={oauthRegisterInfo.providerId}
        providerUserId={oauthRegisterInfo.providerUserId}
        onLogin={(username, expiresAt) => {
          setOauthRegisterInfo(null)
          handleLogin(username, expiresAt)
        }}
      />
    )
  }

  // Show login screen if not logged in
  if (!currentUser) {
    return <LoginScreen onLogin={handleLogin} />
  }

  // 当前会话的 Agent（单聊气泡标签/头像优先用它，而非下拉选择）
  const activeAgentId = chat.conversations.find((c) => c.id === chat.activeId)?.agent_id || null

  return (
    <div className="flex h-full overflow-hidden bg-background relative">
      {/* Sidebar */}
      {/* 布局宽度由 JS（isMobile）驱动，不用 CSS 媒体查询 —— 钉钉 Android
          内置内核会整条丢弃响应式规则，导致侧边栏永远展开又收不起来。
          mobile：绝对定位浮层，translate-x 滑入/滑出；
          desktop：普通 flex 子项，宽度 288px ↔ 0 切换。 */}
      <div className={`
        flex-shrink-0 border-r
        transition-all duration-300 overflow-hidden
        ${isMobile
          ? `absolute inset-y-0 left-0 z-50 w-72 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`
          : `relative ${sidebarOpen ? 'w-72' : 'w-0 border-r-0'}`}
      `}>
        {/* Sidebar — admin mode: management nav; otherwise: conversations */}
        {adminViewOpen ? (
          <AdminSidebar
            activeTab={adminTab}
            onTabChange={handleAdminTabChange}
            onBack={closeAdminView}
          />
        ) : (
          <Sidebar
            conversations={chat.conversations}
            activeId={chat.activeId}
            onSelect={chat.selectConversation}
            onNew={chat.createConversation}
            onNewGroup={() => setGroupDialogOpen(true)}
            onRename={chat.renameConversation}
            onDelete={handleDeleteConversation}
            onExport={chat.exportConversation}
            onManageGroupAgents={handleManageGroupAgents}
            appName={appName}
            currentUser={currentUser}
            showGithub={showGithub}
            onChangePin={() => setChangePinOpen(true)}
            onChangeUsername={() => setChangeUsernameOpen(true)}
            onLinkAccount={() => setLinkedAccountsOpen(true)}
            onLogout={handleLogout}
            language={i18n.language}
            onLanguageChange={handleLanguageChange}
            theme={theme}
            onThemeChange={setTheme}
            onAdminSettings={isAdminUser ? handleAdminSettings : undefined}
          />
        )}
      </div>

      {/* Mobile backdrop（同样由 JS 驱动，避免媒体查询失效） */}
      {isMobile && sidebarOpen && (
        <div
          className="absolute inset-0 bg-black/50 z-40"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Main area — admin mode: management content; otherwise: chat */}
        {adminViewOpen ? (
          <div className="flex-1 flex flex-col min-w-0">
            {/* Top bar — same height as AdminSidebar header, holds toggle + actions */}
            <div className="flex items-center justify-between px-3 border-b shrink-0" style={{ height: '60px' }}>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 hover:bg-accent/50"
                onClick={() => setSidebarOpen(!sidebarOpen)}
              >
                <PanelLeft className="h-4 w-4" />
              </Button>
              <div className="flex items-center gap-1.5">
                {adminTab === 'agent' && (
                  <Button variant="outline" size="sm" onClick={() => agentRef.current?.triggerCreate()}>
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    {t('settings.agentAdd')}
                  </Button>
                )}
                {adminTab === 'gateway' && (
                  <Button variant="outline" size="sm" onClick={() => gatewayRef.current?.loadFromEnv()}>
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                    {t('settings.gatewayLoadFromEnv')}
                  </Button>
                )}
                {adminTab === 'mcp' && (
                  <Button variant="outline" size="sm" onClick={() => mcpRef.current?.triggerAdd()}>
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    {t('settings.mcpAddServer')}
                  </Button>
                )}
                {adminTab === 'skills' && (
                  <Button variant="outline" size="sm" onClick={() => skillRef.current?.triggerUpload()}>
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    {t('settings.uploadSkill')}
                  </Button>
                )}
            </div>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 px-6">
              {adminTab === 'agent' && <AgentManager ref={agentRef} />}
              {adminTab === 'gateway' && <GatewaySettings ref={gatewayRef} />}
              {adminTab === 'branding' && <BrandingSettings />}
              {adminTab === 'mcp' && <McpManager ref={mcpRef} />}
              {adminTab === 'skills' && <SkillManager ref={skillRef} />}
              {adminTab === 'users' && <UserManager ref={userRef} />}
              {adminTab === 'review' && <ReviewPanel />}
            </div>
          </div>
        ) : (
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
              supportInfiniteMode={supportInfiniteMode}
              agents={agents}
              agentsLoading={agentsLoading}
              selectedAgentId={selectedAgentId}
              activeAgentId={activeAgentId}
              onAgentChange={setSelectedAgentId}
              isGroup={chat.isGroupMode}
              groupAgents={chat.groupAgents}
              onSendGroup={chat.sendGroupMessage}
              infiniteMode={infiniteMode}
              onInfiniteModeChange={handleInfiniteModeChange}
              pendingQuestion={chat.pendingQuestion}
              onSendAnswer={(answer, selectedOptions) => chat.sendAnswer(chat.pendingQuestion?.question_id || '', answer, selectedOptions)}
              onSkipAnswer={() => chat.sendAnswer(chat.pendingQuestion?.question_id || '', '', [])}
              recommendedQuestions={recommendedQuestions}
              conversationId={chat.activeId}
              onEnsureConversation={ensureConversation}
            />
          </div>
        )}

      {/* Change PIN Dialog */}
      <ChangePinDialog
        open={changePinOpen}
        onOpenChange={setChangePinOpen}
        username={currentUser}
      />

      {/* Change Username Dialog */}
      <ChangeUsernameDialog
        open={changeUsernameOpen}
        onOpenChange={setChangeUsernameOpen}
        username={currentUser}
        onDone={(newUsername, expiresAt) => {
          localStorage.setItem('user', newUsername)
          setSessionExpiry(expiresAt)
          setCurrentUser(newUsername)
        }}
      />

      {/* Linked Accounts Dialog */}
      <LinkedAccountsDialog
        open={linkedAccountsOpen}
        onOpenChange={setLinkedAccountsOpen}
      />

      {/* Group Chat Agent Selection Dialog */}
      {groupDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card rounded-xl border shadow-lg p-6 w-full max-w-sm mx-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">{t('chat.selectAgents')}</h3>
              <button onClick={() => { setGroupDialogOpen(false); setSelectedGroupAgents([]) }} className="hover:bg-muted rounded-md p-1">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{t('chat.minAgentsRequired')}</p>
            <div className="space-y-2 mb-6">
              {agents.map((agent) => {
                const isSelected = selectedGroupAgents.includes(agent.id)
                return (
                  <button
                    key={agent.id}
                    onClick={() => {
                      setSelectedGroupAgents((prev) =>
                        isSelected ? prev.filter((id) => id !== agent.id) : [...prev, agent.id],
                      )
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
                      isSelected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                    }`}
                  >
                    {agent.avatar ? (
                      <img src={agent.avatar} alt={agent.name} className="w-8 h-8 rounded-full object-cover" />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium">
                        {agent.name.charAt(0)}
                      </div>
                    )}
                    <span className="flex-1 text-left text-sm font-medium">{agent.name}</span>
                    {isSelected && <Check className="h-4 w-4 text-primary" />}
                  </button>
                )
              })}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => { setGroupDialogOpen(false); setSelectedGroupAgents([]) }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                className="flex-1"
                disabled={selectedGroupAgents.length < 2}
                onClick={async () => {
                  if (selectedGroupAgents.length >= 2) {
                    setGroupDialogOpen(false)
                    const conv = await chat.createGroupConversation(selectedGroupAgents)
                    setSelectedGroupAgents([])
                    setSidebarOpen(false) // Close sidebar on mobile
                  }
                }}
              >
                {t('common.confirm')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Group Member Management Dialog (same UI as new group agent selection) */}
      {groupManageOpen && groupManageConvId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card rounded-xl border shadow-lg p-6 w-full max-w-sm mx-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">{t('sidebar.groupMembers')}</h3>
              <button onClick={() => { setGroupManageOpen(false); setGroupManageConvId(null); setSelectedGroupAgents([]) }} className="hover:bg-muted rounded-md p-1">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{t('chat.minAgentsRequired')}</p>
            <div className="space-y-2 mb-6">
              {agents.map((agent) => {
                const isSelected = selectedGroupAgents.includes(agent.id)
                return (
                  <button
                    key={agent.id}
                    onClick={() => {
                      setSelectedGroupAgents((prev) =>
                        isSelected ? prev.filter((id) => id !== agent.id) : [...prev, agent.id],
                      )
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
                      isSelected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                    }`}
                  >
                    {agent.avatar ? (
                      <img src={agent.avatar} alt={agent.name} className="w-8 h-8 rounded-full object-cover" />
                    ) : (
                      <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium">
                        {agent.name.charAt(0)}
                      </div>
                    )}
                    <span className="flex-1 text-left text-sm font-medium">{agent.name}</span>
                    {isSelected && <Check className="h-4 w-4 text-primary" />}
                  </button>
                )
              })}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => { setGroupManageOpen(false); setGroupManageConvId(null); setSelectedGroupAgents([]) }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                className="flex-1"
                disabled={selectedGroupAgents.length < 2}
                onClick={async () => {
                  if (selectedGroupAgents.length < 2) return
                  const currentIds = chat.groupAgents.map((a: { id: string }) => a.id)
                  const toAdd = selectedGroupAgents.filter((id) => !currentIds.includes(id))
                  const toRemove = currentIds.filter((id: string) => !selectedGroupAgents.includes(id))
                  // Batch add/remove
                  for (const id of toAdd) await chat.addAgentToGroup(id)
                  for (const id of toRemove) await chat.removeAgentFromGroup(id)
                  setGroupManageOpen(false)
                  setGroupManageConvId(null)
                  setSelectedGroupAgents([])
                }}
              >
                {t('common.confirm')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete conversation confirmation dialog */}
      <Dialog open={!!deleteConvId} onOpenChange={(open) => { if (!open) { setDeleteConvId(null); setDeleteConvTitle('') } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('sidebar.delete')}</DialogTitle>
            <DialogDescription>
              {t('sidebar.deleteConfirm', { name: deleteConvTitle })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDeleteConvId(null); setDeleteConvTitle('') }}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmDeleteConversation}>
              {t('sidebar.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}