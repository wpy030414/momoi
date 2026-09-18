import { st } from '../i18n'

const BASE = ''

// Auth transport: the JWT lives in an HttpOnly cookie the browser attaches to
// every same-origin request automatically — JS never touches the token, so XSS
// cannot read or exfiltrate it. localStorage only keeps non-secret session
// metadata: the username and the token expiry (for renewal scheduling).

export function getUser(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('user')
}

export function setSessionExpiry(expiresAt?: number) {
  if (expiresAt) localStorage.setItem('token_expires_at', String(expiresAt))
  else localStorage.removeItem('token_expires_at')
}

export function getTokenExpiresAt(): number | null {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem('token_expires_at')
  const n = raw ? Number(raw) : 0
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Wipe the persisted session metadata (also drops the legacy 'token' key) */
export function clearSession() {
  localStorage.removeItem('user')
  localStorage.removeItem('token') // legacy pre-cookie storage
  localStorage.removeItem('token_expires_at')
}

/**
 * Notify the app that the session is dead (an authenticated endpoint returned 401).
 *
 * - Throttled: a burst of parallel 401s must not fan out into a logout storm
 *   (each dispatch triggers handleLogout, which fires more requests → more 401s).
 * - Carries the request's start time: the app drops "stale" 401s whose request
 *   began BEFORE the most recent successful login. Those verdicts describe the
 *   dead OLD session; honoring them after login would call /logout and destroy
 *   the brand-new cookie — the "instantly kicked back to the login screen" bug.
 */
let lastAuthExpiredDispatch = 0
export function notifyAuthExpired(requestStartedAt: number) {
  const now = Date.now()
  if (now - lastAuthExpiredDispatch < 1000) return
  lastAuthExpiredDispatch = now
  window.dispatchEvent(new CustomEvent('auth:expired', { detail: { startedAt: requestStartedAt } }))
}

// ---- Device identity (for realtime multi-device sync) ----
// 每个「标签页」一个稳定随机 ID（存 sessionStorage，标签页独立）：
// - POST /api/chat 用它标记「来源」，服务端只跳过该标签页的中继，
//   同一浏览器的其他标签页（不同 ID）也能实时收到 —— 修复多标签页
//   顶掉问题（localStorage 会共享 deviceId，后开的标签页顶掉先开的订阅）
// - GET /api/events 用它维护本标签页唯一长连接；刷新页面 sessionStorage
//   保留同 ID，重连时服务端替换旧订阅，不双发
let deviceId: string | null = null
export function getDeviceId(): string {
  if (deviceId) return deviceId
  try {
    deviceId = sessionStorage.getItem('momoi_device_id')
  } catch { deviceId = null }
  if (!deviceId) {
    deviceId = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    try { sessionStorage.setItem('momoi_device_id', deviceId) } catch { /* ignore */ }
  }
  return deviceId
}

// ---- Realtime 事件通道（SSE 长连接）----

type RealtimeListener = (event: import('@momoi/shared/types').RealtimeEvent) => void

const realtimeListeners = new Set<RealtimeListener>()
let realtimeSource: EventSource | null = null
let realtimeSourceKey: string | null = null // `${username}:${deviceId}`
let realtimeConnectedOnce = false // 本次连接是否已成功过一次（区分首次/重连）

/**
 * 建立（或复用）GET /api/events SSE 长连接，监听同账号其他设备推送的事件。
 * 多标签页 / 多设备并发打开时，由 useChat 协调同一 (username, deviceId)
 * 只建一条连接。返回取消监听函数（不影响其他监听者）。
 */
export function subscribeRealtime(listener: RealtimeListener): () => void {
  realtimeListeners.add(listener)
  return () => {
    realtimeListeners.delete(listener)
    if (realtimeListeners.size === 0) {
      realtimeSource?.close()
      realtimeSource = null
      realtimeSourceKey = null
      realtimeConnectedOnce = false
    }
  }
}

function ensureRealtimeSource(username: string) {
  const key = `${username}:${getDeviceId()}`
  if (realtimeSource && realtimeSourceKey === key) return
  if (realtimeSource) realtimeSource.close()
  // EventSource 默认携带 Cookie（HttpOnly JWT 认证）；X-User 头无法附加到
  // EventSource，改走查询参数传递用户名（服务端仍以 Cookie JWT 为准校验）。
  realtimeSource = new EventSource(`/api/events?device_id=${encodeURIComponent(getDeviceId())}&user=${encodeURIComponent(username)}`)
  realtimeSourceKey = key
  realtimeSource.onopen = () => {
    if (realtimeConnectedOnce) {
      // 断线重连成功：SSE 无历史重放，断线期间错过的事件需主动对账。
      // 通知订阅者刷新会话列表与当前会话消息（避免「没立刻出现」）。
      dispatchRealtime({ type: 'conv_sync' })
      const m = window.location.hash.match(/^#\/c\/(.+)$/)
      if (m) {
        dispatchRealtime({ type: 'conv_changed', conversation_id: decodeURIComponent(m[1]) })
      }
    } else {
      realtimeConnectedOnce = true
    }
  }
  // 统一从默认 message 事件解析：data 已是完整 JSON（含 type），
  // 不依赖自定义事件名（老内核 WebView 对 `event:` 字段支持不可靠）。
  realtimeSource.onmessage = (e) => {
    let payload: import('@momoi/shared/types').RealtimeEvent
    try {
      payload = JSON.parse((e as MessageEvent).data) as import('@momoi/shared/types').RealtimeEvent
    } catch { return /* malformed */ }
    dispatchRealtime(payload)
  }
  // 断线自动重连（EventSource 内建）；onerror 保持打开由浏览器按 retry 重连
  realtimeSource.onerror = () => {
    console.warn('[realtime] SSE error/closed, browser will auto-reconnect')
  }
}

function dispatchRealtime(payload: import('@momoi/shared/types').RealtimeEvent) {
  for (const listener of [...realtimeListeners]) {
    try { listener(payload) } catch (err) { console.error('Realtime listener error:', err) }
  }
}

/** 供 useChat 挂载时按 (username, deviceId) 确保唯一长连接。 */
export function connectRealtime(username: string) {
  ensureRealtimeSource(username)
}

/** 供 useChat 卸载时清理监听（事件源保留给其他监听者）。 */
export function disconnectRealtime() {
  if (realtimeListeners.size > 0) return
  realtimeSource?.close()
  realtimeSource = null
  realtimeSourceKey = null
}

export function getDeviceIdForRequest(): string | null {
  try {
    return typeof window !== 'undefined' ? getDeviceId() : null
  } catch {
    return null
  }
}

// Endpoints where 401 means "wrong credentials", not "session expired" —
// a wrong-PIN attempt must never trigger the expired-session logout path.
const CREDENTIALS_ENDPOINTS = ['/api/user/verify', '/api/user/change-pin']

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const user = getUser()
  const optsHeaders = (options?.headers as Record<string, string>) || {}
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...optsHeaders,
  }
  if (user && !optsHeaders['X-User'] && !optsHeaders['x-user']) {
    headers['X-User'] = encodeURIComponent(user)
  }
  // The HttpOnly cookie rides along on same-origin fetches — no manual
  // Authorization header needed (or possible: JS cannot read the cookie).

  const startedAt = Date.now()
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  })
  if (!res.ok) {
    const isCredentialsRejection =
      res.status === 401 && CREDENTIALS_ENDPOINTS.some((p) => path.startsWith(p))
    if (res.status === 401 && !isCredentialsRejection) {
      clearSession()
      notifyAuthExpired(startedAt)
    }
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(st(err.error || `HTTP ${res.status}`))
  }
  return res.json()
}

export const api = {
  // Generic GET helper
  get: <T>(path: string) => request<T>(path),
  // User Auth
  getUserStatus: (username: string) => request<{ has_pin: boolean; direct_registration_open: boolean; oauth_registration_open: boolean }>(`/api/user/status?username=${encodeURIComponent(username)}`, {
    headers: { 'X-User': encodeURIComponent(username) }
  }),
  // Token arrives via Set-Cookie (HttpOnly); the body only carries the expiry
  verifyPin: (username: string, pin: string) => request<{ expires_at: number }>('/api/user/verify', {
    method: 'POST',
    body: JSON.stringify({ pin }),
    headers: { 'X-User': encodeURIComponent(username) }
  }),
  setPin: (username: string, pin: string) => request<{ expires_at: number }>('/api/user/set-pin', {
    method: 'POST',
    body: JSON.stringify({ pin }),
    headers: { 'X-User': encodeURIComponent(username) }
  }),
  changePin: (username: string, oldPin: string, newPin: string) => request<{ success: boolean }>('/api/user/change-pin', {
    method: 'POST',
    body: JSON.stringify({ old_pin: oldPin, new_pin: newPin }),
    headers: { 'X-User': encodeURIComponent(username) }
  }),
  // Current user info (admin status detection)
  getMe: () => request<{ username: string; is_admin: boolean }>('/api/user/me'),
  // Exchange a still-valid cookie for a fresh 14-day one (sliding session renewal)
  refreshToken: () => request<{ expires_at: number }>('/api/user/refresh', { method: 'POST' }),
  // Clear the HttpOnly cookie server-side (JS cannot delete it itself)
  logout: () => request<{ success: boolean }>('/api/user/logout', { method: 'POST' }),
  renameUser: (newUsername: string) => request<{ username: string; expires_at: number }>(
    '/api/user/rename',
    { method: 'POST', body: JSON.stringify({ new_username: newUsername }) }
  ),
  getOauthBindings: () => request<{ bindings: Array<{ id: string; provider_id: string; created_at: number }> }>(
    '/api/user/oauth-bindings'
  ),
  unbindOauth: (bindingId: string) => request<{ success: boolean }>(
    `/api/user/oauth-bindings/${bindingId}`,
    { method: 'DELETE' }
  ),
  oauthRegister: (data: { provider_id: string; provider_user_id: string; action: 'link' | 'create'; username: string; pin: string }) => request<{ username: string; expires_at: number }>(
    '/api/oauth/register',
    { method: 'POST', body: JSON.stringify(data) }
  ),

  // Conversations
  listConversations: () => request<{ conversations: import('@momoi/shared/types').Conversation[] }>('/api/conversations'),
  getConversation: (id: string) => request<{ conversation: import('@momoi/shared/types').Conversation; messages: import('@momoi/shared/types').Message[]; agents?: Array<{ id: string; name: string; avatar: string }>; is_qq_group?: boolean }>(`/api/conversations/${id}`),
  createConversation: (title?: string) => request<{ conversation: import('@momoi/shared/types').Conversation }>('/api/conversations', { method: 'POST', body: JSON.stringify({ title }) }),
  createGroupConversation: (agentIds: string[]) => request<{ conversation: import('@momoi/shared/types').Conversation }>('/api/conversations', { method: 'POST', body: JSON.stringify({ title: '群组对话', type: 'group', agent_ids: agentIds }) }),
  deleteConversation: (id: string) => request<{ success: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' }),
  renameConversation: (id: string, title: string) => request<{ conversation: import('@momoi/shared/types').Conversation }>(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  mergeConversations: (sourceIds: string[]) => request<{ conversation: import('@momoi/shared/types').Conversation }>('/api/conversations/merge', { method: 'POST', body: JSON.stringify({ source_ids: sourceIds }) }),
  revertMessages: (conversationId: string, messageId: number) => request<{ success: boolean }>(`/api/conversations/${conversationId}/messages/${messageId}`, { method: 'DELETE' }),

  // Group Chat
  getGroupAgents: (convId: string) => request<{ agents: Array<{ id: string; name: string; avatar: string }> }>(`/api/group/${convId}/agents`),
  addGroupAgent: (convId: string, agentId: string) => request<{ success: boolean }>(`/api/group/${convId}/agents`, { method: 'POST', body: JSON.stringify({ agent_id: agentId }) }),
  removeGroupAgent: (convId: string, agentId: string) => request<{ success: boolean }>(`/api/group/${convId}/agents/${agentId}`, { method: 'DELETE' }),

  // Infinite Mode
  setInfiniteMode: (conversationId: string, enabled: boolean) => request<{ success: boolean; enabled: boolean }>('/api/chat/infinite-mode', { method: 'POST', body: JSON.stringify({ conversation_id: conversationId, enabled }) }),

  // Ask User
  answerQuestion: (conversationId: string, questionId: string, answer: string, selectedOptions?: string[]) => request<{ success: boolean }>(`/api/chat/${conversationId}/answer`, { method: 'POST', body: JSON.stringify({ question_id: questionId, answer, selected_options: selectedOptions }) }),

  // App config
  getAppName: () => request<{ app_name: string; app_favicon: string; app_background: string; support_attachments: boolean; support_infinite_mode: boolean; show_github: boolean; use_external_image_hosting: boolean; recommended_questions: string[]; stand_alone?: boolean; agents: Array<{ id: string; name: string; avatar: string }> }>('/api/app-name'),

  // Admin — the HttpOnly cookie authenticates every same-origin request
  // automatically; the server additionally checks ADMIN-list membership.
  getConfig: () => request<import('@momoi/shared/types').AppConfig>('/api/admin/config'),
  getEnvGateway: () => request<{ api_endpoint: string; api_key: string; model: string }>('/api/admin/config/env-gateway'),
  updateConfig: (config: Partial<import('@momoi/shared/types').AppConfig>) => request<import('@momoi/shared/types').AppConfig>('/api/admin/config', { method: 'PUT', body: JSON.stringify(config) }),

  // Admin - Agent CRUD
  listAdminAgents: () => request<{ agents: import('@momoi/shared/types').Agent[] }>('/api/admin/agents'),
  createAgent: (data: { name: string; model: string; system_prompt: string; avatar?: string }) => request<{ agent: import('@momoi/shared/types').Agent }>('/api/admin/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (id: string, data: { name?: string; model?: string; system_prompt?: string; avatar?: string }) => request<{ agent: import('@momoi/shared/types').Agent }>(`/api/admin/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAgent: (id: string) => request<{ success: boolean }>(`/api/admin/agents/${id}`, { method: 'DELETE' }),
  listAdminSkills: () => request<{ skills: import('@momoi/shared/types').InstalledSkill[] }>('/api/admin/skills'),
  installSkill: (name: string) => request('/api/admin/skills/install', { method: 'POST', body: JSON.stringify({ name }) }),
  uninstallSkill: (name: string) => request(`/api/admin/skills/${name}`, { method: 'DELETE' }),
  getAdminStats: () => request<import('@momoi/shared/types').AdminStats>('/api/admin/stats'),
  getAdminConversations: () => request<{ conversations: import('@momoi/shared/types').AdminConversationRow[] }>('/api/admin/stats/conversations'),
  getAdminConversationMessages: (id: string) => request<{ conversation: any; messages: import('@momoi/shared/types').Message[] }>(`/api/admin/stats/conversations/${id}/messages`),

  // Admin - MCP Servers
  listMcpServers: () => request<{ servers: import('@momoi/shared/types').McpServerConfig[] }>('/api/admin/mcp-servers'),
  createMcpServer: (data: { name: string; url: string }) => request<{ server: import('@momoi/shared/types').McpServerConfig }>('/api/admin/mcp-servers', { method: 'POST', body: JSON.stringify(data) }),
  updateMcpServer: (id: string, data: { name?: string; url?: string; enabled?: boolean }) => request<{ server: import('@momoi/shared/types').McpServerConfig }>(`/api/admin/mcp-servers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteMcpServer: (id: string) => request<{ success: boolean }>(`/api/admin/mcp-servers/${id}`, { method: 'DELETE' }),

  // Admin - User Management
  listAdminUsers: (page = 1, pageSize = 10) =>
    request<{ users: import('@momoi/shared/types').AdminUserRow[]; total: number; page: number; page_size: number }>(
      `/api/admin/users?page=${page}&page_size=${pageSize}`
    ),
  setUserBan: (username: string, banned: boolean) =>
    request<{ success: boolean; banned: boolean }>(`/api/admin/users/${encodeURIComponent(username)}/ban`, { method: 'PUT', body: JSON.stringify({ banned }) }),
  deleteUser: (username: string) =>
    request<{ success: boolean }>(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' }),
  getDirectRegistration: () =>
    request<{ direct_registration_open: boolean }>('/api/admin/direct-registration'),
  setDirectRegistration: (open: boolean) =>
    request<{ direct_registration_open: boolean }>('/api/admin/direct-registration', { method: 'PUT', body: JSON.stringify({ open }) }),
  getOauthRegistration: () =>
    request<{ oauth_registration_open: boolean }>('/api/admin/oauth-registration'),
  setOauthRegistration: (open: boolean) =>
    request<{ oauth_registration_open: boolean }>('/api/admin/oauth-registration', { method: 'PUT', body: JSON.stringify({ open }) }),

  // OAuth2 login
  getOauthProviders: () =>
    request<{ providers: Array<{ id: string; name: string }> }>('/api/oauth/providers'),

  // Upload (multipart/form-data — do NOT set Content-Type, let browser set boundary;
  // the HttpOnly cookie authenticates the request automatically)
  uploadSkill: (file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    const startedAt = Date.now()
    return fetch('/api/admin/skills/upload', {
      method: 'POST',
      body: formData,
    }).then(async (res) => {
      if (!res.ok) {
        if (res.status === 401) {
          clearSession()
          notifyAuthExpired(startedAt)
        }
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(st(err.error || `HTTP ${res.status}`))
      }
      return res.json() as Promise<{ success: boolean; skills: import('@momoi/shared/types').InstalledSkill[] }>
    })
  },

  // Voice
  getVoiceSegments: (agentId: string, messageId: number) =>
    request<{ segments: import('@momoi/shared/types').VoiceAudioSegment[]; complete: boolean }>(
      '/api/voice/segments', { method: 'POST', body: JSON.stringify({ agent_id: agentId, message_id: messageId }) }
    ),

  // Admin - TTS
  getTtsConfig: () => request<{ endpoint: string; provider: string }>('/api/admin/tts/config'),
  updateTtsConfig: (cfg: { endpoint?: string; provider?: string }) =>
    request<{ endpoint: string; provider: string }>('/api/admin/tts/config', { method: 'PUT', body: JSON.stringify(cfg) }),

  // WeChat binding
  wechatBindInfo: () =>
    request<{ bound: boolean; wechat_user_id?: string; bound_at?: number; conversation_id?: string; session_expired?: boolean }>(
      '/api/wechat/bind'
    ),

  wechatBindStart: (convId?: string) =>
    request<{ qrcode_id: string; qrcode_page_url: string; qrcode_data_uri: string; expires_at: number }>(
      '/api/wechat/bind',
      { method: 'POST', body: JSON.stringify({ conv_id: convId || '' }) }
    ),

  wechatBindStatus: (qrcodeId: string) =>
    request<{ status: 'wait' | 'confirmed' | 'expired'; error?: string }>(
      `/api/wechat/bind/status?qrcode_id=${encodeURIComponent(qrcodeId)}`
    ),

  wechatUnbind: () =>
    request<{ success: boolean }>(
      '/api/wechat/bind',
      { method: 'DELETE' }
    ),

  // QQ binding
  qqBindInfo: (agentId: string) =>
    request<{ bound: boolean; agent_id?: string; app_id?: string; bound_at?: number; conversation_id?: string; status?: 'connected' | 'error'; error?: string; ws_connected?: boolean; group_enabled?: boolean }>(
      `/api/qq/bind?agent_id=${encodeURIComponent(agentId)}`
    ),

  qqBindStart: (convId: string, agentId: string, appId?: string, appSecret?: string, groupEnabled?: boolean) =>
    request<{ success: boolean }>(
      '/api/qq/bind',
      { method: 'POST', body: JSON.stringify({ conv_id: convId || '', agent_id: agentId, app_id: appId || '', app_secret: appSecret || '', group_enabled: groupEnabled }) }
    ),

  qqUnbind: (agentId: string) =>
    request<{ success: boolean }>(
      '/api/qq/bind',
      { method: 'DELETE', body: JSON.stringify({ agent_id: agentId }) }
    ),
}
