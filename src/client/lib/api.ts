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

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  })
  if (!res.ok) {
    if (res.status === 401) {
      clearSession()
      window.dispatchEvent(new CustomEvent('auth:expired'))
    }
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export const api = {
  // User Auth
  getUserStatus: (username: string) => request<{ has_pin: boolean; registration_open: boolean }>(`/api/user/status?username=${encodeURIComponent(username)}`, {
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

  // Conversations
  listConversations: () => request<{ conversations: import('@/shared/types').Conversation[] }>('/api/conversations'),
  getConversation: (id: string) => request<{ conversation: import('@/shared/types').Conversation; messages: import('@/shared/types').Message[]; agents?: Array<{ id: string; name: string; avatar: string }> }>(`/api/conversations/${id}`),
  createConversation: (title?: string) => request<{ conversation: import('@/shared/types').Conversation }>('/api/conversations', { method: 'POST', body: JSON.stringify({ title }) }),
  createGroupConversation: (agentIds: string[]) => request<{ conversation: import('@/shared/types').Conversation }>('/api/conversations', { method: 'POST', body: JSON.stringify({ title: '群组对话', type: 'group', agent_ids: agentIds }) }),
  deleteConversation: (id: string) => request<{ success: boolean }>(`/api/conversations/${id}`, { method: 'DELETE' }),
  renameConversation: (id: string, title: string) => request<{ conversation: import('@/shared/types').Conversation }>(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
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
  getAppName: () => request<{ app_name: string; app_favicon: string; app_background: string; support_attachments: boolean; show_github: boolean; recommended_questions: string[]; agents: Array<{ id: string; name: string; avatar: string }> }>('/api/app-name'),

  // Admin — the HttpOnly cookie authenticates every same-origin request
  // automatically; the server additionally checks ADMIN-list membership.
  getConfig: () => request<import('@/shared/types').AppConfig>('/api/admin/config'),
  getEnvGateway: () => request<{ api_endpoint: string; api_key: string; model: string }>('/api/admin/config/env-gateway'),
  updateConfig: (config: Partial<import('@/shared/types').AppConfig>) => request<import('@/shared/types').AppConfig>('/api/admin/config', { method: 'PUT', body: JSON.stringify(config) }),

  // Admin - Agent CRUD
  listAdminAgents: () => request<{ agents: import('@/shared/types').Agent[] }>('/api/admin/agents'),
  createAgent: (data: { name: string; model: string; system_prompt: string; avatar?: string }) => request<{ agent: import('@/shared/types').Agent }>('/api/admin/agents', { method: 'POST', body: JSON.stringify(data) }),
  updateAgent: (id: string, data: { name?: string; model?: string; system_prompt?: string; avatar?: string }) => request<{ agent: import('@/shared/types').Agent }>(`/api/admin/agents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAgent: (id: string) => request<{ success: boolean }>(`/api/admin/agents/${id}`, { method: 'DELETE' }),
  listAdminSkills: () => request<{ skills: import('@/shared/types').InstalledSkill[] }>('/api/admin/skills'),
  installSkill: (name: string) => request('/api/admin/skills/install', { method: 'POST', body: JSON.stringify({ name }) }),
  uninstallSkill: (name: string) => request(`/api/admin/skills/${name}`, { method: 'DELETE' }),
  getAdminStats: () => request<import('@/shared/types').AdminStats>('/api/admin/stats'),
  getAdminConversations: () => request<{ conversations: import('@/shared/types').AdminConversationRow[] }>('/api/admin/stats/conversations'),
  getAdminConversationMessages: (id: string) => request<{ conversation: any; messages: import('@/shared/types').Message[] }>(`/api/admin/stats/conversations/${id}/messages`),

  // Admin - MCP Servers
  listMcpServers: () => request<{ servers: import('@/shared/types').McpServerConfig[] }>('/api/admin/mcp-servers'),
  createMcpServer: (data: { name: string; url: string }) => request<{ server: import('@/shared/types').McpServerConfig }>('/api/admin/mcp-servers', { method: 'POST', body: JSON.stringify(data) }),
  updateMcpServer: (id: string, data: { name?: string; url?: string; enabled?: boolean }) => request<{ server: import('@/shared/types').McpServerConfig }>(`/api/admin/mcp-servers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteMcpServer: (id: string) => request<{ success: boolean }>(`/api/admin/mcp-servers/${id}`, { method: 'DELETE' }),

  // Admin - User Management
  listAdminUsers: (page = 1, pageSize = 10) =>
    request<{ users: import('@/shared/types').AdminUserRow[]; total: number; page: number; page_size: number }>(
      `/api/admin/users?page=${page}&page_size=${pageSize}`
    ),
  setUserBan: (username: string, banned: boolean) =>
    request<{ success: boolean; banned: boolean }>(`/api/admin/users/${encodeURIComponent(username)}/ban`, { method: 'PUT', body: JSON.stringify({ banned }) }),
  deleteUser: (username: string) =>
    request<{ success: boolean }>(`/api/admin/users/${encodeURIComponent(username)}`, { method: 'DELETE' }),
  getRegistration: () =>
    request<{ registration_open: boolean }>('/api/admin/registration'),
  setRegistration: (open: boolean) =>
    request<{ registration_open: boolean }>('/api/admin/registration', { method: 'PUT', body: JSON.stringify({ open }) }),

  // Upload (multipart/form-data — do NOT set Content-Type, let browser set boundary;
  // the HttpOnly cookie authenticates the request automatically)
  uploadSkill: (file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return fetch('/api/admin/skills/upload', {
      method: 'POST',
      body: formData,
    }).then(async (res) => {
      if (!res.ok) {
        if (res.status === 401) {
          clearSession()
          window.dispatchEvent(new CustomEvent('auth:expired'))
        }
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      return res.json() as Promise<{ success: boolean; skills: import('@/shared/types').InstalledSkill[] }>
    })
  },
}
