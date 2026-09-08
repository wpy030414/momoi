// ============================================================
// Momoi — Shared Types
// ============================================================

// ---- Conversation & Messages ----

export interface Attachment {
  url: string
  name: string
  size: number
  type: string
}

export interface Conversation {
  id: string
  title: string
  agent_id: string
  type: 'direct' | 'group'
  agent_count?: number  // 群组内 Agent 数量（不含中立 Agent，不含用户）
  created_at: number
  updated_at: number
}

export interface Message {
  id: number
  conversation_id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  thinking?: string | null
  tool_calls?: ToolCall[] | null
  tool_call_id?: string | null
  suggestions?: string[] | null
  attachments?: Attachment[] | null
  agent_id?: string | null
  created_at: number
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  result?: unknown
}

// ---- Config ----

export interface AppConfig {
  app_name: string
  app_favicon: string  // base64 data URL, empty = use default
  app_background: string  // base64 data URL, empty = no custom background
  api_endpoint: string
  api_key: string
  support_attachments: boolean
  show_github: boolean
}

// ---- Agent ----

/** 导入来源溯源，写入 agents.origin（JSON 文本列），仅导入路径产生 */
export interface AgentOrigin {
  protocol: 'aip'
  package: { name: string; version: string }
  personaId: string
  importedAt: number
}

export interface Agent {
  id: string
  name: string
  model: string
  system_prompt: string
  avatar: string
  role: 'default' | 'neutral'
  created_at: number
  origin?: AgentOrigin | null
}

// ---- Tool Definition ----

export interface ToolDefinition {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, { type: string; description?: string; items?: { type: string } }>
    required?: string[]
  }
}

// ---- Skill ----

export interface SkillManifest {
  name: string
  description: string
  version?: string
}

export interface InstalledSkill {
  manifest: SkillManifest
  content: string
  path: string
}

// ---- SSE Events ----

// ThinkingSegment 定义在 shared/thinking.ts（与服务端 loop 共用编解码），此处 re-export
export type { ThinkingSegment } from './thinking.js'

export type ServerMessage =
  | { type: 'conversation_id'; id: string }
  | { type: 'token'; text: string; agent_id?: string; agent_name?: string }
  | { type: 'thinking'; text: string; round?: number; agent_id?: string; agent_name?: string }
  | { type: 'tool_call'; id?: string; name: string; input: Record<string, unknown>; agent_id?: string; agent_name?: string }
  | { type: 'tool_execution_start'; id?: string; name: string; input: Record<string, unknown>; agent_id?: string; agent_name?: string }
  | { type: 'tool_result'; id?: string; name: string; summary: string; artifacts?: Array<{ filename: string; displayName: string; mimeType: string; downloadUrl: string }>; agent_id?: string; agent_name?: string }
  | { type: 'agent_start'; agent_id: string; agent_name: string }
  | { type: 'agent_done'; agent_id: string; agent_name: string; reply: string; suggestions: string[] }
  | { type: 'group_start'; agent_ids: string[] }
  | { type: 'group_done'; infinite?: boolean }
  | { type: 'follow_up'; text: string }
  | { type: 'infinite_mode_off' }
  | { type: 'done'; reply: string; suggestions: string[]; agent_id?: string; agent_name?: string; infinite?: boolean }
  | { type: 'error'; message: string; agent_id?: string; agent_name?: string }

// ---- Admin Auth ----

export interface AdminStats {
  total_users: number
  total_conversations: number
  total_messages: number
}

export interface AdminConversationRow {
  id: string
  user_id: string
  title: string
  created_at: number
  updated_at: number
  message_count: number
}

// ---- Agent Import API ----

export interface AgentImportPackageInfo {
  name: string
  version: string
  host?: string
}

export interface AgentImportPersonaConflict {
  agent_id: string
  agent_name: string
  same_origin: boolean
}

export interface AgentImportPersonaPreview {
  id: string
  name: string
  primary: { file: string; bytes: number }
  has_avatar: boolean
  level_count: number
  conflict?: AgentImportPersonaConflict
}

export interface AgentImportSkillConflict {
  installed: boolean
  content_identical: boolean
}

export interface AgentImportSkillPreview {
  name: string
  description: string
  conflict: AgentImportSkillConflict
}

export interface AgentImportPreview {
  import_id: string
  package: AgentImportPackageInfo
  candidates: AgentImportPersonaPreview[]
  skills: AgentImportSkillPreview[]
  warnings: string[]
  errors: string[]
}

export type AgentImportPersonaAction = 'create' | 'overwrite' | 'skip'
export type AgentImportSkillAction = 'install' | 'skip'

export interface AgentImportPersonaDecision {
  id: string
  action: AgentImportPersonaAction
  name?: string
  model?: string
}

export interface AgentImportSkillDecision {
  name: string
  action: AgentImportSkillAction
}

export interface AgentImportCommitRequest {
  personas?: AgentImportPersonaDecision[]
  skills?: AgentImportSkillDecision[]
}

export interface AgentImportCommitResult {
  imported: Array<{ id: string; name: string }>
  overwritten: Array<{ id: string; name: string }>
  skipped: string[]
  skills: { installed: string[]; overwritten: string[]; skipped: string[] }
  errors: string[]
}

// ---- API Responses ----
