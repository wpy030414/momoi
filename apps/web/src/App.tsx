import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { useWorldChat } from './hooks/useWorld'
import { useTheme } from './hooks/useTheme'
import { useAdminPanel } from './hooks/useAdminPanel'
import { useDocsPanel } from './hooks/useDocsPanel'
import { useMemoryPanel } from './hooks/useMemoryPanel'
import { Sidebar } from './components/sidebar/Sidebar'
import { AgentPickerList } from './components/sidebar/AgentPickerList'
import { NewWorkflowDialog } from './components/sidebar/NewWorkflowDialog'
import { ChatPanel } from './components/chat/ChatPanel'
import { ChangePinDialog } from './components/settings/ChangePinDialog'
import { ChangeUsernameDialog } from './components/settings/ChangeUsernameDialog'
import { LinkedAccountsDialog } from './components/settings/LinkedAccountsDialog'
import { ImBindDialog } from './components/chat/ImBindDialog'
import { LoginScreen } from './components/auth/LoginScreen'
import { OAuthRegisterScreen } from './components/auth/OAuthRegisterScreen'
import { Button } from './components/ui/button'
import { useToast } from './components/ui/toast'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './components/ui/dialog'
import { PanelLeft, X, Eye, EyeOff } from 'lucide-react'
import { api, getUser, clearSession, setSessionExpiry, getTokenExpiresAt } from './lib/api'
import { ensureLocale } from './i18n'
// 静态导入：模块零依赖且体积 ~1 KB，且 isPushSupported 每次渲染都要同步调用，
// 模块本就在主包中——动态导入不产生任何分包收益（曾因此触发
// INEFFECTIVE_DYNAMIC_IMPORT 警告），故统一走静态导入。
import { isPushSupported, subscribePush, unsubscribePush } from './lib/push-subscription'

// First-use introduction — lazy chunk; users who dismissed it once never load it.
// 世界面板懒加载：不开世界的用户一个字节都不下载。世内部再懒加载 three 那个 chunk。
const WorldPanel = lazy(() =>
  import('./components/world/WorldPanel').then((m) => ({ default: m.WorldPanel })),
)

const IntroductionDialog = lazy(() =>
  import('./components/intro/IntroductionDialog').then(m => ({ default: m.IntroductionDialog })))

export function App() {
  const { t, i18n } = useTranslation()
  const { toast } = useToast()
  const chat = useWorldChat()
  // v7 exhaustive-deps：闭包内经 chat.fn() 成员链「调用」要求把根对象（每渲染
  // 新建）列入 deps → useCallback 失效。解构为裸标识符即可保留逐成员 memo
  // （useChat/useGroupChat 的函数成员均逐个 useCallback，引用稳定）。
  const { selectConversation } = chat
  const { theme, setTheme } = useTheme()

  const [verbose, setVerbose] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('momoi_verbose') === 'true'
    }
    return false
  })
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
      await selectConversation(conversation.id)
      return conversation.id
    }
    const { conversation } = await api.createConversation()
    await selectConversation(conversation.id)
    return conversation.id
  }, [chat.activeId, chat.draftType, chat.groupAgents, selectConversation])

  // When admin disables support_infinite_mode, force-disable any active infinite loop
  useEffect(() => {
    if (!supportInfiniteMode && infiniteMode) {
      setInfiniteMode(false)
      if (chat.activeId) {
        api.setInfiniteMode(chat.activeId, false).catch(console.error)
      }
    }
  }, [supportInfiniteMode, infiniteMode, chat.activeId])

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
    admin.close()
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
    // handleLogin 每渲染重建（闭包捕获 chat），列入 deps 会让本 effect 每渲染
    // 重跑 → getMe() 请求风暴；本 effect 只应在身份/模式变化时触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // 监听器只在挂载时注册一次（解绑/重绑反而漏事件）。handleLogout 虽每渲染
    // 重建，但它只引用稳定成员（resetChat/close 均 useCallback、状态经 ref），
    // 挂载期闭包永不过期，刻意不入 deps。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Re-fetch app config on admin close is handled by useAdminPanel's onConfigChanged
  // (the effect fires inside the hook; the callback below refetches app config)

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

  const handleLanguageChange = async (lang: string) => {
    await ensureLocale(lang)
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
      ensureLocale(saved).then(() => i18n.changeLanguage(saved))
    }
    syncMomoTheme(saved || i18n.language)
  }, [i18n])

  // --- Admin / Docs / Memory panels (state & logic extracted into custom hooks) ---
  const admin = useAdminPanel({
    isAdminUser,
    standAlone: standAlone === true,
    sidebarOpen,
    setSidebarOpen,
    onConfigChanged: useCallback(() => {
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
    }, []),
  })
  const docs = useDocsPanel({ sidebarOpen, setSidebarOpen })
  const memory = useMemoryPanel({ agents, sidebarOpen, setSidebarOpen })

  const [changePinOpen, setChangePinOpen] = useState(false)
  const [changeUsernameOpen, setChangeUsernameOpen] = useState(false)
  const [linkedAccountsOpen, setLinkedAccountsOpen] = useState(false)
  const [imBindOpen, setImBindOpen] = useState(false)
  const [imBindConvId, setImBindConvId] = useState<string | null>(null)
  const [imBindAgentId, setImBindAgentId] = useState<string>('')
  const [introOpen, setIntroOpen] = useState(false)
  // Push notification toggle — persisted in localStorage, only shown when push is supported
  const [pushEnabled, setPushEnabled] = useState(() => localStorage.getItem('momoi_push_enabled') === 'true')
  const pushSupported = isPushSupported()
  const handlePushToggle = useCallback(async () => {
    if (pushEnabled) {
      // Turning off: unsubscribe and forget
      await unsubscribePush()
      setPushEnabled(false)
      localStorage.removeItem('momoi_push_enabled')
    } else {
      // Turning on: request permission — modern Chrome always shows the
      // HTML-based permission dialog on user gesture. Only resolves to
      // "denied" silently when user has blocked the site in browser settings.
      const result = await Notification.requestPermission()
      if (result === 'granted' && currentUser) {
        await subscribePush(currentUser)
        setPushEnabled(true)
        localStorage.setItem('momoi_push_enabled', 'true')
      } else if (result === 'denied') {
        toast({ title: t('menu.pushDeniedHint'), variant: 'info' })
      }
    }
  }, [pushEnabled, currentUser, t, toast])

  // Sync toggle when permission is revoked externally（用户去浏览器设置里关掉通知 → 自动关开关）
  // Deliberately does NOT re-enable when permission is granted externally —
  // that path is handled by the explicit toggle click.
  useEffect(() => {
    if (!pushSupported) return
    navigator.permissions?.query({ name: 'notifications' as PermissionName }).then(perm => {
      const sync = () => {
        // Only react to externally revoked permission — never override explicit user off
        if (Notification.permission !== 'granted' && localStorage.getItem('momoi_push_enabled') === 'true') {
          setPushEnabled(false)
          localStorage.removeItem('momoi_push_enabled')
        }
      }
      perm.onchange = async () => {
        // Small delay so Notification.permission reflects the new state
        await new Promise(r => setTimeout(r, 100))
        sync()
      }
      // Also check on first load: if we stored enabled but permission is now denied
      sync()
    }).catch(() => {})
  }, [pushSupported])
  // Auto-show the first-use introduction once per browser (all login entries
  // — PIN verify / PIN setup / OAuth / stand-alone — funnel through
  // setCurrentUser; a page refresh restores currentUser in the useState
  // initializer, so this single effect covers every path).
  useEffect(() => {
    if (!currentUser) return
    if (localStorage.getItem('momoi_intro_seen') !== 'true') setIntroOpen(true)
    // Auto-subscribe if permission was already granted and toggle is on
    if (pushEnabled && Notification.permission === 'granted') {
      subscribePush(currentUser)
    }
  }, [currentUser, pushEnabled])

  // ⚠ Rules of Hooks：以下回调/记忆化 Hook 必须位于本组件所有「条件早退」
  // （oauthRegisterInfo / !currentUser）之前。它们曾被放在早退之后，导致登录/
  // 退出时同一挂载内两次渲染的 Hook 数量不一致，React 抛
  // "Rendered more/fewer hooks than during the previous render"，
  // 整树卸载 → 白屏，需手动刷新恢复。
  // Stable callbacks for Sidebar (prevent inline arrow re-creation on every render)
  const handleNewGroup = useCallback(() => setGroupDialogOpen(true), [])
  const handleChangePin = useCallback(() => setChangePinOpen(true), [])
  const handleChangeUsername = useCallback(() => setChangeUsernameOpen(true), [])
  const handleLinkAccount = useCallback(() => setLinkedAccountsOpen(true), [])
  // Closing the introduction by ANY means (X / Esc / overlay / "Get started")
  // marks it as seen — it can always be reopened from the sidebar app name.
  const handleIntroOpenChange = useCallback((open: boolean) => {
    setIntroOpen(open)
    if (!open) localStorage.setItem('momoi_intro_seen', 'true')
  }, [])
  const handleShowIntro = useCallback(() => setIntroOpen(true), [])

  const activeAgentId = useMemo(
    () => chat.conversations.find((c) => c.id === chat.activeId)?.agent_id || null,
    [chat.conversations, chat.activeId]
  )

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
        {admin.viewOpen ? admin.sidebarNode
          : docs.viewOpen ? docs.sidebarNode
          : memory.viewOpen ? memory.sidebarNode
          : (
          <Sidebar
            conversations={chat.conversations}
            activeId={chat.activeId}
            onSelect={chat.selectConversation}
            onNew={chat.createConversation}
            onNewWorkflow={handleNewGroup}
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
            onChangePin={standAlone ? undefined : handleChangePin}
            onChangeUsername={standAlone ? undefined : handleChangeUsername}
            onLinkAccount={standAlone ? undefined : handleLinkAccount}
            onLogout={standAlone ? undefined : handleLogout}
            language={i18n.language}
            onLanguageChange={handleLanguageChange}
            theme={theme}
            onThemeChange={setTheme}
            onAdminSettings={isAdminUser ? admin.open : undefined}
            onDocs={docs.open}
            onMemory={memory.open}
            onShowIntro={handleShowIntro}
            standAlone={standAlone === true}
            pushSupported={pushSupported}
            pushEnabled={pushEnabled}
            onPushToggle={handlePushToggle}
            unreadCounts={chat.unreadCounts}
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
        {admin.viewOpen ? admin.mainNode
          : docs.viewOpen ? docs.mainNode
          : memory.viewOpen ? memory.mainNode
          : (
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
            {/* 主区：世界会话渲染三维沙盘，其余渲染消息气泡。
                用 key={chat.activeId} 让切换会话时重挂载 —— 3D 画布的上下文、
                相机与几何体都应随会话重建，而不是复用。 */}
            {chat.isWorldMode ? (
              <Suspense fallback={null}>
                <WorldPanel
                  key={chat.activeId ?? 'world'}
                  worldState={chat.worldState}
                  worldEntities={chat.worldEntities}
                  worldEvents={chat.worldEvents}
                  worldPatches={chat.worldPatches}
                  worldAgents={chat.worldAgents}
                  worldGodEntity={chat.worldGodEntity}
                  worldAutoTick={chat.worldAutoTick}
                  loading={chat.worldLoading}
                  error={chat.worldError}
                  acting={chat.worldActing}
                  actingName={chat.worldActingName}
                  savingLaws={chat.worldSavingLaws}
                  onSaveLaws={chat.saveWorldLaws}
                  onAct={chat.actWorld}
                  onPlaceGod={chat.placeWorldGod}
                  onToggleAutoTick={chat.setWorldAutoTick}
                />
              </Suspense>
            ) : (
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
            )}
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

      {/* First-use introduction — lazy chunk; null fallback avoids a spinner
          flashing inside the dialog overlay (the chunk is tiny, no heavy deps) */}
      <Suspense fallback={null}>
        <IntroductionDialog
          open={introOpen}
          onOpenChange={handleIntroOpenChange}
          appName={appName}
        />
      </Suspense>

      {/* 新工作流：模式选择（群组会话 / 世界模拟）+ Agent 选择 + 世界提示词 */}
      <NewWorkflowDialog
        open={groupDialogOpen}
        onOpenChange={(open) => {
          setGroupDialogOpen(open)
          if (!open) setSelectedGroupAgents([])
        }}
        agents={agents}
        agentsLoading={agentsLoading}
        onConfirmGroup={async (agentIds) => {
          // 侧边栏不自动收回：选好 Agent 后停留在群聊新会话视图
          await chat.createGroupConversation(agentIds)
        }}
        onConfirmWorld={async (agentIds, prompt) => {
          await chat.createWorld(agentIds, prompt)
        }}
      />

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
            <div className="mb-6">
              <AgentPickerList
                agents={agents}
                selected={selectedGroupAgents}
                onToggle={(id) =>
                  setSelectedGroupAgents((prev) =>
                    prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
                  )
                }
              />
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