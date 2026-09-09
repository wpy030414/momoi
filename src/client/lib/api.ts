const BASE = ''

export function getUser(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('user')
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('token')
}

export function setToken(token: string | null) {
  if (token) {
    localStorage.setItem('token', token)
  } else {
    localStorage.removeItem('token')
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const user = getUser()
  const token = getToken()
  const optsHeaders = (options?.headers as Record<string, string>) || {}
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...optsHeaders,
  }
  if (user && !optsHeaders['X-User'] && !optsHeaders['x-user']) {
    headers['X-User'] = encodeURIComponent(user)
  }
  // Only attach the user JWT if the caller didn't supply an explicit Authorization
  // (admin calls pass their own admin JWT and must not be overwritten).
  if (token && !optsHeaders['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  })
  if (!res.ok) {
    if (res.status === 401) {
      localStorage.removeItem('user')
      localStorage.removeItem('token')
      window.dispatchEvent(new CustomEvent('auth:expired'))
    }
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

/**
 * Multipart upload helper — deliberately omits Content-Type so the browser
 * sets the boundary; shares the same 401 handling as `request`.
 */
async function multipartRequest<T>(path: string, token: string, file: File): Promise<T> {
  const formData = new FormData()
  formData.append('file', file)
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  })
  if (!res.ok) {
    if (res.status === 401) {
      localStorage.removeItem('user')
      localStorage.removeItem('token')
      window.dispatchEvent(new CustomEvent('auth:expired'))
    }
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  // User Auth
  getUserStatus: (username: string) => request<{ has_pin: boolean }>(`/api/user/status?username=${encodeURIComponent(username)}`, {
    headers: { 'X-User': username }
  }),
  verifyPin: (username: string, pin: string) => request<{ token: string; expires_at: number }>('/api/user/verify', {
    method: 'POST',
    body: JSON.stringify({ pin }),
    headers: { 'X-User': username }
  }),
  setPin: (username: string, pin: string) => request<{ token: string; expires_at: number }>('/api/user/set-pin', {
    method: 'POST',
    body: JSON.stringify({ pin }),
    headers: { 'X-User': username }
  }),
  changePin: (username: string, oldPin: string, newPin: string) => request<{ success: boolean }>('/api/user/change-pin', {
    method: 'POST',
    body: JSON.stringify({ old_pin: oldPin, new_pin: newPin }),
    headers: { 'X-User': username }
  }),

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

  // App config
  getAppName: () => request<{ app_name: string; app_favicon: string; app_background: string; support_attachments: boolean; show_github: boolean; agents: Array<{ id: string; name: string; avatar: string }> }>('/api/app-name'),

  // Admin
  adminAuth: (key: string) => request<{ token: string; expires_at: number }>('/api/admin/auth', { method: 'POST', body: JSON.stringify({ key }) }),
  getConfig: (token: string) => request<import('@/shared/types').AppConfig>('/api/admin/config', { headers: { Authorization: `Bearer ${token}` } }),
  getEnvGateway: (token: string) => request<{ api_endpoint: string; api_key: string; model: string }>('/api/admin/config/env-gateway', { headers: { Authorization: `Bearer ${token}` } }),
  updateConfig: (token: string, config: Partial<import('@/shared/types').AppConfig>) => request<import('@/shared/types').AppConfig>('/api/admin/config', { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(config) }),

  // Admin - Agent CRUD
  listAdminAgents: (token: string) => request<{ agents: import('@/shared/types').Agent[] }>('/api/admin/agents', { headers: { Authorization: `Bearer ${token}` } }),
  createAgent: (token: string, data: { name: string; model: string; system_prompt: string; avatar?: string }) => request<{ agent: import('@/shared/types').Agent }>('/api/admin/agents', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(data) }),
  updateAgent: (token: string, id: string, data: { name?: string; model?: string; system_prompt?: string; avatar?: string }) => request<{ agent: import('@/shared/types').Agent }>(`/api/admin/agents/${id}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(data) }),
  deleteAgent: (token: string, id: string) => request<{ success: boolean }>(`/api/admin/agents/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }),
  listAdminSkills: (token: string) => request<{ skills: import('@/shared/types').InstalledSkill[] }>('/api/admin/skills', { headers: { Authorization: `Bearer ${token}` } }),
  installSkill: (token: string, name: string) => request('/api/admin/skills/install', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ name }) }),
  uninstallSkill: (token: string, name: string) => request(`/api/admin/skills/${name}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }),
  getAdminStats: (token: string) => request<import('@/shared/types').AdminStats>('/api/admin/stats', { headers: { Authorization: `Bearer ${token}` } }),
  getAdminConversations: (token: string) => request<{ conversations: import('@/shared/types').AdminConversationRow[] }>('/api/admin/stats/conversations', { headers: { Authorization: `Bearer ${token}` } }),
  getAdminConversationMessages: (token: string, id: string) => request<{ conversation: any; messages: import('@/shared/types').Message[] }>(`/api/admin/stats/conversations/${id}/messages`, { headers: { Authorization: `Bearer ${token}` } }),

  // Admin - MCP Servers
  listMcpServers: (token: string) => request<{ servers: import('@/shared/types').McpServerConfig[] }>('/api/admin/mcp-servers', { headers: { Authorization: `Bearer ${token}` } }),
  createMcpServer: (token: string, data: { name: string; url: string }) => request<{ server: import('@/shared/types').McpServerConfig }>('/api/admin/mcp-servers', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(data) }),
  updateMcpServer: (token: string, id: string, data: { name?: string; url?: string; enabled?: boolean }) => request<{ server: import('@/shared/types').McpServerConfig }>(`/api/admin/mcp-servers/${id}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(data) }),
  deleteMcpServer: (token: string, id: string) => request<{ success: boolean }>(`/api/admin/mcp-servers/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }),

  // Upload (multipart/form-data — do NOT set Content-Type, let browser set boundary)
  uploadSkill: (token: string, file: File) =>
    multipartRequest<{ success: boolean; skills: import('@/shared/types').InstalledSkill[] }>('/api/admin/skills/upload', token, file),

  // Admin - Agent package import (AIP)
  importAgentPackage: (token: string, file: File) =>
    multipartRequest<import('@/shared/types').AgentImportPreview>('/api/admin/agents/import', token, file),
  commitAgentImport: (token: string, importId: string, body: import('@/shared/types').AgentImportCommitRequest) =>
    request<import('@/shared/types').AgentImportCommitResult>(`/api/admin/agents/import/${encodeURIComponent(importId)}/commit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
}
