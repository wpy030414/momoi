import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useGroupChat } from './hooks/useGroupChat'
import { useTheme } from './hooks/useTheme'
import { Sidebar } from './components/sidebar/Sidebar'
import { AdminSidebar, ADMIN_TABS } from './components/admin/AdminSidebar'
import { DocsSidebar } from './components/docs/DocsSidebar'
import type { DocEntry } from './components/docs/DocsSidebar'
import { DocsViewer, TocItem } from './components/docs/DocsViewer'
import { MemorySidebar } from './components/memory/MemorySidebar'
import { MemoryManager } from './components/memory/MemoryManager'
import type { UserAgentMemory } from '@momoi/shared/types'
import { ChatPanel } from './components/chat/ChatPanel'
import { ChangePinDialog } from './components/settings/ChangePinDialog'
import { ChangeUsernameDialog } from './components/settings/ChangeUsernameDialog'
import { LinkedAccountsDialog } from './components/settings/LinkedAccountsDialog'
import { ImBindDialog } from './components/chat/ImBindDialog'
import { LoginScreen } from './components/auth/LoginScreen'
import { OAuthRegisterScreen } from './components/auth/OAuthRegisterScreen'
import { AgentManager } from './components/admin/tabs/AgentManager'
import { GatewaySettings } from './components/admin/tabs/GatewaySettings'
import { ExperienceSettings } from './components/admin/tabs/ExperienceSettings'
import { McpManager } from './components/admin/tabs/McpManager'
import { SkillManager } from './components/admin/tabs/SkillManager'
import { ReviewPanel } from './components/admin/tabs/ReviewPanel'
import { UserManager } from './components/admin/tabs/UserManager'

// Type-only imports for ref handles (not used at runtime, only for TS)
import type { AgentManagerHandle } from './components/admin/tabs/AgentManager'
import type { GatewaySettingsHandle } from './components/admin/tabs/GatewaySettings'
import type { McpManagerHandle } from './components/admin/tabs/McpManager'
import type { SkillManagerHandle } from './components/admin/tabs/SkillManager'
import type { UserManagerHandle } from './components/admin/tabs/UserManager'
import { Button } from './components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './components/ui/dialog'
import { PanelLeft, X, Check, Plus, RotateCcw, Upload, Server, Eye, EyeOff, List } from 'lucide-react'
import { api, getUser, clearSession, setSessionExpiry, getTokenExpiresAt } from './lib/api'

export function App() {
  const { t, i18n } = useTranslation()
  const chat = useGroupChat()
  const { theme, setTheme } = useTheme()
  const [adminViewOpen, setAdminViewOpen] = useState(false)
  // Docs view state
  const [docsViewOpen, setDocsViewOpen] = useState(false)
  const [docsEntries, setDocsEntries] = useState<DocEntry[]>([])
  const [activeDoc, setActiveDoc] = useState<string | null>(null)
  // Docs TOC（由 DocsViewer 渲染后回传）
  const [docToc, setDocToc] = useState<TocItem[]>([])
  const [tocOpen, setTocOpen] = useState(false)
  const tocWrapRef = useRef<HTMLDivElement>(null)
  // Memory view state
  const [memoryViewOpen, setMemoryViewOpen] = useState(false)
  const [memoryEntries, setMemoryEntries] = useState<UserAgentMemory[]>([])
  const [memoryAgentId, setMemoryAgentId] = useState<string | null>(null)
  const [memoriesLoading, setMemoriesLoading] = useState(false)

  // 目录气泡：点击外部 / Esc 关闭
  useEffect(() => {
    if (!tocOpen) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!tocWrapRef.current?.contains(e.target as Node)) setTocOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTocOpen(false) }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [tocOpen])
  const [verbose, setVerbose] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('momoi_verbose') === 'true'
    }
    return false
  })
  // Active tab in the admin management sidebar
  const [adminTab, setAdminTab] = useState<string>(ADMIN_TABS[0].value)
  // Refs to tab action-triggers (exposed via useImperativeHandle)
  const agentRef = useRef<AgentManagerHandle>(null)
  const gatewayRef = useRef<GatewaySettingsHandle>(null)
  const mcpRef = useRef<McpManagerHandle>(null)
  const skillRef = useRef<SkillManagerHandle>(null)
  const userRef = useRef<UserManagerHandle>(null)
  const [changePinOpen, setChangePinOpen] = useState(false)
  const [changeUsernameOpen, setChangeUsernameOpen] = useState(false)
  const [linkedAccountsOpen, setLinkedAccountsOpen] = useState(false)
  const [imBindOpen, setImBindOpen] = useState(false)
  const [imBindConvId, setImBindConvId] = useState<string | null>(null)
  const [imBindAgentId, setImBindAgentId] = useState<string>('')
  const [oauthRegisterInfo, setOauthRegisterInfo] = useState<{ providerId: string; providerUserId: string } | null>(null)
  const [appName, setAppName] = useState('Momoi')
  const [backgroundImage, setBackgroundImage] = useState('')
  const [supportAttachments, setSupportAttachments] = useState(false)
  const [supportInfiniteMode, setSupportInfiniteMode] = useState(true)
  const [allowImConversations, setAllowImConversations] = useState(true)
  const [showGithub, setShowGithub] = useState(true)
  const [recommendedQuestions, setRecommendedQuestions] = useState<string[]>([])
  const [followupQuestions, setFollowupQuestions] = useState<string[]>([])
  const [currentUser, setCurrentUser] = useState<string | null>(() => getUser())
  // Admin status of the logged-in user (ADMIN usernames from server .env)
  const [isAdminUser, setIsAdminUser] = useState(false)
  // Stand-alone mode: null = unknown yet (waiting for /api/app-name), true =
  // single-user no-auth deployment (auto-login as the fixed 'admin')
  const [standAlone, setStandAlone] = useState<boolean | null>(null)

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
      // New session just established (Set-Cookie on the OAuth redirect response)
      lastLoginAtRef.current = Date.now()
      // Clean query params from URL without reload
      const url = new URL(window.location.href)
      url.searchParams.delete('oauth_user')
      url.searchParams.delete('oauth_expires')
      url.searchParams.delete('oauth_error')
      history.replaceState(null, '', url.toString())
    }
  }, [])
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 768)
  const [agents, setAgents] = useState<Array<{ id: string; name: string; avatar: string; voice_enabled?: boolean }>>([])
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

  // Merge group chats
  const [mergeSourceId, setMergeSourceId] = useState<string | null>(null)
  const [mergeSelectedIds, setMergeSelectedIds] = useState<string[]>([])

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
    // 草稿态（尚未发出首条消息）：上传附件需要真实会话 ID（workspace 落盘）。
    // 按当前草稿类型创建对应会话 —— 群聊草稿带 agent_ids，避免误建成单聊。
    if (chat.draftType === 'group') {
      const agentIds = chat.groupAgents.map((a: { id: string }) => a.id)
      const { conversation } = await api.createGroupConversation(agentIds)
      await chat.selectConversation(conversation.id)
      return conversation.id
    }
    const { conversation } = await api.createConversation()
    await chat.selectConversation(conversation.id)
    return conversation.id
  }, [chat.activeId, chat.draftType, chat.groupAgents, chat.selectConversation])

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

  const handleContinueOnIm = (convId: string, agentId: string) => {
    setImBindConvId(convId)
    setImBindAgentId(agentId)
    setImBindOpen(true)
  }

  const confirmDeleteConversation = async () => {
    if (!deleteConvId) return
    await chat.deleteConversation(deleteConvId)
    setDeleteConvId(null)
    setDeleteConvTitle('')
  }

  const handleMergeConversation = (convId: string) => {
    setMergeSourceId(convId)
    setMergeSelectedIds([convId])
  }

  const toggleMergeSelect = (convId: string) => {
    setMergeSelectedIds(prev =>
      prev.includes(convId) ? prev.filter(id => id !== convId) : [...prev, convId]
    )
  }

  const confirmMergeConversation = async () => {
    if (!mergeSourceId || mergeSelectedIds.length < 2) return
    try {
      const { conversation } = await api.mergeConversations(mergeSelectedIds)
      await chat.selectConversation(conversation.id)
      setMergeSourceId(null)
      setMergeSelectedIds([])
    } catch (e) {
      console.error('Merge failed:', e)
    }
  }

  const handleLogin = (username: string, expiresAt?: number) => {
    localStorage.setItem('user', username)
    setSessionExpiry(expiresAt)
    setCurrentUser(username)
    // 标记新会话生效时刻：晚于此时刻才发起的请求，其 401 才代表「这个新会话已失效」
    lastLoginAtRef.current = Date.now()
    // Reload conversations for the new user
    setTimeout(() => chat.refreshConversations(), 100)
  }

  const handleLogout = () => {
    // Stand-alone mode: logging out is not allowed — there is no other session
    // to go back to (no login screen exists). Also guards the auth:expired
    // listener below from ever evicting the fixed 'admin' session.
    if (standAloneRef.current) return
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
    // Clear current session LOCALLY. 绝不能在这里调 chat.createConversation()：
    // 那会在服务端预创建会话，无会话时必然 401 → auth:expired → handleLogout →
    // 又发请求 → ……无限 401 死循环，还会把刚登录拿到的新 cookie 通过 /logout 误杀。
    chat.resetChat()
  }

  // Detect admin status for the logged-in user.
  // Stand-alone mode: identity is the fixed 'admin' — always an admin, no
  // /api/user/me round trip (or its failure mode) needed.
  useEffect(() => {
    if (standAlone) {
      setIsAdminUser(true)
      return
    }
    if (!currentUser) {
      setIsAdminUser(false)
      return
    }
    api.getMe()
      .then((r) => {
        setIsAdminUser(!!r.is_admin)
        // 服务器身份权威校验：同一浏览器在常规模式与单机模式之间切换时，
        // localStorage 可能残留上一模式的用户名（如单机残留 alice 或常规残留 admin）。
        // /api/user/me 永远返回服务端实际解析出的 userId（常规模式来自 JWT cookie，
        // 单机模式固定为 'admin'），不一致则强制修正 localStorage + state 并刷新会话列表。
        if (r.username && r.username !== currentUser) {
          handleLogin(r.username)
        }
      })
      .catch(() => setIsAdminUser(false))
  }, [currentUser, standAlone])

  // Stand-alone mode: log straight in as the fixed 'admin' user. Also
  // normalizes a stale localStorage username left over from a multi-user
  // deployment on the same origin.
  useEffect(() => {
    if (!standAlone) return
    if (currentUser !== 'admin') handleLogin('admin')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standAlone, currentUser])

  // Auto-renew the JWT (14-day TTL) once less than half its life remains —
  // sliding session. While the tab is alive the token never runs out; after
  // 14 days without the app open, the token is gone and PIN login is required.
  // (Not in stand-alone mode: there is no token at all.)
  useEffect(() => {
    if (!currentUser || standAlone) return
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
  }, [currentUser, standAlone])

  // Most recent successful login (PIN / OAuth / rename re-issue). Used to drop
  // "stale" 401s whose request started BEFORE that moment: their verdict
  // describes the dead old session, and honoring them right after login would
  // /logout and destroy the brand-new cookie — the "instantly kicked out" bug.
  const lastLoginAtRef = useRef(0)

  // Stand-alone mode flag kept in a ref so the []-deps auth:expired listener
  // closure (registered once on mount) always reads the up-to-date value.
  const standAloneRef = useRef(false)
  useEffect(() => { standAloneRef.current = standAlone === true }, [standAlone])

  // Listen for auth:expired events dispatched by the API layer
  // when a 401 response is received (token invalid/expired).
  useEffect(() => {
    const onAuthExpired = (e: Event) => {
      const startedAt = (e as CustomEvent).detail?.startedAt ?? 0
      if (startedAt <= lastLoginAtRef.current) return // stale 401 from before the current login
      handleLogout()
    }
    window.addEventListener('auth:expired', onAuthExpired as EventListener)
    return () => window.removeEventListener('auth:expired', onAuthExpired as EventListener)
  }, [])

  useEffect(() => {
    api.getAppName().then((r) => {
      setStandAlone(r.stand_alone === true)
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
      setAllowImConversations(r.allow_im_conversations !== false)
      setShowGithub(r.show_github !== false)
      setRecommendedQuestions(r.recommended_questions || [])
      setFollowupQuestions(r.followup_questions || [])
      if (r.agents?.length > 0) {
        setAgents(r.agents)
        setSelectedAgentId((prev) => prev && r.agents.some((a) => a.id === prev) ? prev : r.agents[0].id)
      }
    }).catch(() => setStandAlone(false)).finally(() => setAgentsLoading(false))
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
        setAllowImConversations(r.allow_im_conversations !== false)
        setShowGithub(r.show_github !== false)
        setRecommendedQuestions(r.recommended_questions || [])
        setFollowupQuestions(r.followup_questions || [])
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

  // 会话归属同步：切进已有会话（侧栏点击 / F5 hash 恢复 / 前进后退）时，把 Agent
  // 下拉选择同步为该会话归属的 Agent。selectedAgentId 是与「当前会话」无关的全局
  // 状态——后台增删 Agent 触发列表刷新后会被重置为 agents[0]，若不同步，继续
  // 聊天时请求携带的 agent_id 会与会话归属错位（Agent 漂移的客户端一半；另一半
  // 由服务端按 conversations.agent_id 锚定兜底）。
  useEffect(() => {
    const convAgent = chat.conversations.find((c) => c.id === chat.activeId)?.agent_id
    if (convAgent && agents.some((a) => a.id === convAgent)) {
      setSelectedAgentId((prev) => (prev === convAgent ? prev : convAgent))
    }
  }, [chat.activeId, chat.conversations, agents])

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
    localStorage.setItem('language', lang)
    syncMomoTheme(lang)
  }

  function syncMomoTheme(lang: string) {
    const root = document.documentElement
    if (lang === 'ja') {
      root.classList.add('theme-momo')
    } else {
      root.classList.remove('theme-momo')
    }
  }

  // Restore language + momo theme on first load
  useEffect(() => {
    const saved = localStorage.getItem('language')
    if (saved && saved !== i18n.language) {
      i18n.changeLanguage(saved)
    }
    syncMomoTheme(saved || i18n.language)
  }, [])

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

  const handleDocs = () => {
    // Fetch doc list on first open (cache it for the session)
    if (docsEntries.length === 0) {
      api.get<DocEntry[]>('/api/docs').then((r) => {
        setDocsEntries(r)
        const firstDoc = r[0]?.path ?? null
        setActiveDoc(firstDoc)
        history.pushState(null, '', firstDoc ? `#/docs/${encodeURIComponent(firstDoc)}` : '#/docs')
      }).catch(() => {})
    } else {
      history.pushState(null, '', activeDoc ? `#/docs/${encodeURIComponent(activeDoc)}` : '#/docs')
    }
    setTimeout(() => {
      setDocsViewOpen(true)
    }, 100)
  }

  const handleSelectDoc = (path: string) => {
    setActiveDoc(path)
    history.pushState(null, '', `#/docs/${encodeURIComponent(path)}`)
  }

  const closeDocsView = () => {
    setDocsViewOpen(false)
    if (window.location.hash.startsWith('#/docs')) {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }

  const refreshMemories = () => {
    setMemoriesLoading(true)
    api.listMemories()
      .then((r) => setMemoryEntries(r.memories))
      .catch(() => {})
      .finally(() => setMemoriesLoading(false))
  }

  const handleMemory = () => {
    // Always refetch — agents keep writing memories during chats, no session cache
    api.listMemories().then((r) => {
      setMemoryEntries(r.memories)
      // Default selection: keep the previous agent if still valid, else the agent
      // of the newest memory, else the first agent
      const stillValid = (id: string | null): string | null =>
        id && (agents.some((a) => a.id === id) || r.memories.some((m) => m.agent_id === id)) ? id : null
      setMemoryAgentId((prev) =>
        stillValid(prev) ?? stillValid(r.memories[0]?.agent_id ?? null) ?? agents[0]?.id ?? null
      )
    }).catch(() => {})
    history.pushState(null, '', '#/memories')
    // Radix popover focus management needs a beat before the view swap (same as handleDocs)
    setTimeout(() => { setMemoryViewOpen(true) }, 100)
  }

  const handleSelectMemoryAgent = (agentId: string) => {
    setMemoryAgentId(agentId)
    history.replaceState(null, '', `#/memories/${encodeURIComponent(agentId)}`)
  }

  const closeMemoryView = () => {
    setMemoryViewOpen(false)
    if (window.location.hash.startsWith('#/memories')) {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }

  // Effective selected agent — computed at render time: the stored selection wins
  // when it maps to a live agent OR an orphan with leftover entries (agent deleted),
  // otherwise falls back to the first agent.
  const activeMemoryAgent =
    memoryAgentId && (agents.some((a) => a.id === memoryAgentId) || memoryEntries.some((m) => m.agent_id === memoryAgentId))
      ? memoryAgentId
      : agents[0]?.id ?? null

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
          // Stand-alone mode hides the users tab — bounce that hash to the default.
          // 'branding' predates the rename to 体验 — map it so old bookmarks still land.
          const tab = match[1]
          if (tab) {
            const normalized = tab === 'branding' ? 'experience' : tab
            setAdminTab(standAlone && normalized === 'users' ? ADMIN_TABS[0].value : normalized)
          }
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
  }, [isAdminUser, standAlone])

  // Route guard: #/docs/{path} — syncs docs view from hash
  useEffect(() => {
    const leaveDocsRoute = () => {
      setDocsViewOpen(false)
      if (window.location.hash.startsWith('#/docs')) {
        history.replaceState(null, '', window.location.pathname + window.location.search)
      }
    }
    const ensureDocsLoaded = () => {
      if (docsEntries.length === 0) {
        api.get<DocEntry[]>('/api/docs').then((r) => {
          setDocsEntries(r)
        }).catch(() => {})
      }
    }
    const syncDocsRoute = () => {
      const match = window.location.hash.match(/^#\/docs(?:\/(.+))?$/)
      if (match) {
        const docPath = match[1] ? decodeURIComponent(match[1]) : null
        ensureDocsLoaded()
        setDocsViewOpen(true)
        setActiveDoc((prev) => docPath || (docsEntries[0]?.path ?? null))
      } else {
        setDocsViewOpen(false)
      }
    }
    syncDocsRoute()
    window.addEventListener('hashchange', syncDocsRoute)
    return () => window.removeEventListener('hashchange', syncDocsRoute)
  }, [docsEntries.length])

  // Route guard: #/memories/{agentId} — syncs memory view from hash
  // (agent ids are uuids with hyphens, hence [^/]+ instead of \w+)
  useEffect(() => {
    const syncMemoryRoute = () => {
      const match = window.location.hash.match(/^#\/memories(?:\/([^/]+))?$/)
      if (match) {
        // Direct URL entry / refresh — fetch fresh data
        api.listMemories().then((r) => setMemoryEntries(r.memories)).catch(() => {})
        if (match[1]) setMemoryAgentId(decodeURIComponent(match[1]))
        setMemoryViewOpen(true)
      } else {
        setMemoryViewOpen(false)
      }
    }
    syncMemoryRoute()
    window.addEventListener('hashchange', syncMemoryRoute)
    return () => window.removeEventListener('hashchange', syncMemoryRoute)
  }, [])

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

  // Show login screen if not logged in.
  // Stand-alone boot: hold a blank splash until /api/app-name tells us the
  // mode — the auto-login effect then signs in as the fixed 'admin' user and
  // the LoginScreen never appears.
  if (!currentUser) {
    if (standAlone === null || standAlone) return null
    return <LoginScreen onLogin={handleLogin} />
  }

  // 当前会话的 Agent（单聊气泡标签/头像优先用它，而非下拉选择）
  const activeAgentId = chat.conversations.find((c) => c.id === chat.activeId)?.agent_id || null

  // 合并群聊：源会话是否为 QQ 群聊（用于过滤候选列表）
  const mergeSourceIsQq = (chat.conversations.find((c: any) => c.id === mergeSourceId) as any)?.qq_bound === 1

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
        {/* Sidebar — admin mode: management nav; docs mode: doc tree; otherwise: conversations */}
        {adminViewOpen ? (
          <AdminSidebar
            activeTab={adminTab}
            onTabChange={handleAdminTabChange}
            onBack={closeAdminView}
            standAlone={standAlone === true}
          />
        ) : docsViewOpen ? (
          <DocsSidebar
            docs={docsEntries}
            activeDoc={activeDoc}
            onSelect={handleSelectDoc}
            onBack={closeDocsView}
          />
        ) : memoryViewOpen ? (
          <MemorySidebar
            agents={agents}
            memories={memoryEntries}
            activeAgentId={activeMemoryAgent}
            onSelect={handleSelectMemoryAgent}
            onBack={closeMemoryView}
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
            onMerge={handleMergeConversation}
            onExport={chat.exportConversation}
            onManageGroupAgents={handleManageGroupAgents}
            onContinueOnIm={allowImConversations ? handleContinueOnIm : undefined}
            appName={appName}
            currentUser={currentUser}
            showGithub={showGithub}
            // Stand-alone mode: the fixed 'admin' identity cannot be renamed,
            // re-PIN'd, OAuth-linked, or logged out — hide those entries.
            onChangePin={standAlone ? undefined : () => setChangePinOpen(true)}
            onChangeUsername={standAlone ? undefined : () => setChangeUsernameOpen(true)}
            onLinkAccount={standAlone ? undefined : () => setLinkedAccountsOpen(true)}
            onLogout={standAlone ? undefined : handleLogout}
            language={i18n.language}
            onLanguageChange={handleLanguageChange}
            theme={theme}
            onThemeChange={setTheme}
            onAdminSettings={isAdminUser ? handleAdminSettings : undefined}
            onDocs={handleDocs}
            onMemory={handleMemory}
            standAlone={standAlone === true}
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

      {/* Main area — admin mode: management content; docs mode: doc viewer; otherwise: chat */}
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
            <div className="flex-1 overflow-y-auto min-h-0">
              {/* 与文档视图一致：内容限宽水平居中，桌面端两侧留白，移动端自动收缩 */}
              <div className="max-w-3xl mx-auto px-6 pb-8">
                {adminTab === 'agent' && <AgentManager ref={agentRef} />}
                  {adminTab === 'gateway' && <GatewaySettings ref={gatewayRef} />}
                  {adminTab === 'experience' && <ExperienceSettings />}
                  {adminTab === 'mcp' && <McpManager ref={mcpRef} />}
                  {adminTab === 'skills' && <SkillManager ref={skillRef} />}
                  {adminTab === 'users' && !standAlone && <UserManager ref={userRef} />}
                  {adminTab === 'review' && <ReviewPanel />}
              </div>
            </div>
          </div>
        ) : docsViewOpen ? (
          <div className="flex-1 flex flex-col min-w-0">
            {/* Top bar */}
            <div className="flex items-center justify-between px-3 border-b shrink-0" style={{ height: '60px' }}>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 hover:bg-accent/50"
                onClick={() => setSidebarOpen(!sidebarOpen)}
              >
                <PanelLeft className="h-4 w-4" />
              </Button>
              <div className="relative" ref={tocWrapRef}>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 hover:bg-accent/50"
                  onClick={() => setTocOpen(v => !v)}
                  title="目录"
                >
                  <List className="h-4 w-4" />
                </Button>
                {tocOpen && (
                  <div className="absolute right-0 top-full mt-2 w-64 rounded-md border bg-popover p-1 shadow-md z-50">
                    <div className="max-h-[60vh] overflow-y-auto">
                      {docToc.length === 0 ? (
                        <p className="px-2 py-3 text-sm text-muted-foreground text-center">暂无章节</p>
                      ) : docToc.map((h) => (
                        <button
                          key={h.id}
                          className={`w-full text-left rounded-sm py-1.5 pr-2 text-sm truncate hover:bg-accent/60 transition-colors ${
                            h.level === 1 ? 'font-medium' : 'text-muted-foreground'
                          }`}
                          style={{ paddingLeft: `${(h.level - 1) * 14 + 8}px` }}
                          onClick={() => {
                            setTocOpen(false)
                            document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                          }}
                        >
                          {h.text}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
            <DocsViewer docPath={activeDoc} onTocChange={setDocToc} />
          </div>
        ) : memoryViewOpen ? (
          <div className="flex-1 flex flex-col min-w-0">
            {/* Top bar — only the sidebar toggle */}
            <div className="flex items-center justify-between px-3 border-b shrink-0" style={{ height: '60px' }}>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 hover:bg-accent/50"
                onClick={() => setSidebarOpen(!sidebarOpen)}
              >
                <PanelLeft className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0">
              {/* 与文档视图一致：内容限宽水平居中，桌面端两侧留白，移动端自动收缩 */}
              <div className="max-w-3xl mx-auto px-6 pb-8">
                <MemoryManager
                  agentId={activeMemoryAgent}
                  agent={activeMemoryAgent ? agents.find((a) => a.id === activeMemoryAgent) ?? null : null}
                  memories={memoryEntries}
                  loading={memoriesLoading}
                  onChanged={refreshMemories}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-w-0 relative">
            {/* Top bar — gradient background, bottom aligned with sidebar top-bar */}
            <div className="absolute inset-x-0 top-0 z-30 flex items-center justify-between px-3 shrink-0" style={{ height: '60px', background: 'linear-gradient(to bottom, hsl(var(--background)), transparent)' }}>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 hover:bg-accent/50"
                onClick={() => setSidebarOpen(!sidebarOpen)}
              >
                <PanelLeft className="h-4 w-4" />
              </Button>
              {chat.messages.length > 0 && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 hover:bg-accent/50"
                  onClick={() => {
                    const newVerbose = !verbose
                    setVerbose(newVerbose)
                    if (typeof window !== 'undefined') {
                      localStorage.setItem('momoi_verbose', String(newVerbose))
                    }
                  }}
                  title={verbose ? t('chat.hideThinking') : t('chat.showThinking')}
                >
                  {verbose ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                </Button>
              )}
            </div>
            {/* Chat area */}
            <ChatPanel
              messages={chat.messages}
              loading={chat.loading}
              onSend={chat.sendMessage}
              onCancel={chat.cancel}
              onRevert={chat.revertMessage}
              onForceRetry={chat.forceComplianceRetry}
              onForceRetryGroup={chat.forceComplianceRetryGroup}
              backgroundImage={backgroundImage}
              supportAttachments={supportAttachments}
              supportInfiniteMode={supportInfiniteMode}
              verbose={verbose}
              agents={agents}
              agentsLoading={agentsLoading}
              selectedAgentId={selectedAgentId}
              activeAgentId={activeAgentId}
              onAgentChange={setSelectedAgentId}
              isGroup={chat.isGroupMode}
              isQqGroup={chat.isQqGroup}
              groupAgents={chat.groupAgents}
              onSendGroup={chat.sendGroupMessage}
              infiniteMode={infiniteMode}
              onInfiniteModeChange={handleInfiniteModeChange}
              pendingQuestion={chat.pendingQuestion}
              onSendAnswer={(answer, selectedOptions) => chat.sendAnswer(chat.pendingQuestion?.question_id || '', answer, selectedOptions)}
              onSkipAnswer={() => chat.sendAnswer(chat.pendingQuestion?.question_id || '', '', [])}
              recommendedQuestions={recommendedQuestions}
              followupQuestions={followupQuestions}
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
          // rename re-issues the auth cookie — treat as a fresh login
          lastLoginAtRef.current = Date.now()
        }}
      />

      {/* Linked Accounts Dialog */}
      <LinkedAccountsDialog
        open={linkedAccountsOpen}
        onOpenChange={setLinkedAccountsOpen}
      />

      {/* IM Bind Dialog (WeChat / QQ channel selection) */}
      <ImBindDialog
        open={imBindOpen}
        onOpenChange={(open) => {
          setImBindOpen(open)
          if (!open) { setImBindConvId(null); setImBindAgentId('') }
        }}
        convId={imBindConvId || ''}
        agentId={imBindAgentId}
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
            <div className="space-y-2 mb-6 max-h-[60vh] overflow-y-auto">
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
                    await chat.createGroupConversation(selectedGroupAgents)
                    setSelectedGroupAgents([])
                    // 侧边栏不自动收回：选好 Agent 后停留在群聊新会话视图
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
            <div className="space-y-2 mb-6 max-h-[60vh] overflow-y-auto">
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
                  // Re-fetch authoritative agent list from server so the @mention
                  // popup and sidebar counts immediately reflect the change
                  await chat.refreshGroupAgents()
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

      {/* Merge group conversations dialog */}
      <Dialog open={!!mergeSourceId} onOpenChange={(open) => { if (!open) { setMergeSourceId(null); setMergeSelectedIds([]) } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('sidebar.mergeGroupChat')}</DialogTitle>
            <DialogDescription>
              {t('sidebar.mergeSelectTarget')}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {chat.conversations
              .filter((c: any) => c.type === 'group' && c.id !== mergeSourceId && (c.qq_bound === 1 ? mergeSourceIsQq : !mergeSourceIsQq))
              .map((c: any) => (
                <label
                  key={c.id}
                  className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent/60 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5"
                    checked={mergeSelectedIds.includes(c.id)}
                    onChange={() => toggleMergeSelect(c.id)}
                  />
                  <span className="flex-1 truncate">{c.title}</span>
                  {c.agent_count != null && (
                    <span className="text-xs text-muted-foreground">({c.agent_count + 1})</span>
                  )}
                </label>
              ))
            }
            {chat.conversations.filter((c: any) => c.type === 'group' && c.id !== mergeSourceId && (c.qq_bound === 1 ? mergeSourceIsQq : !mergeSourceIsQq)).length === 0 && (
              <p className="text-sm text-muted-foreground py-2 text-center">
                {t('sidebar.mergeNoTargets')}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setMergeSourceId(null); setMergeSelectedIds([]) }}>
              {t('common.cancel')}
            </Button>
            <Button onClick={confirmMergeConversation} disabled={mergeSelectedIds.length < 2}>
              {t('sidebar.mergeGroupChat')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}