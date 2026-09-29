// ============================================================
// Momoi — Shared Types
// ============================================================

import type { ErrCode, ErrParams } from './errors.js'

// ---- Conversation & Messages ----

export interface Attachment {
  url: string
  workspace_url?: string  // 仅 CDN 模式下有，指向工作区原始路径供 AI 读取
  name: string
  size: number
  type: string
}

export interface Conversation {
  id: string
  title: string
  agent_id: string
  type: 'direct' | 'group' | 'world'
  agent_count?: number  // 群组内 Agent 数量（不含中立 Agent，不含用户）
  wechat_bound?: number  // 1 if this conversation is bound to WeChat
  qq_bound?: number      // 1 if this conversation is bound to QQ (C2C or group)
  created_at: number
  updated_at: number
  last_read_at?: number
  unread_count?: number
}

/** 世界模拟的侧表信息（worlds 行）。世界模拟是纯文本群聊的变体：
 *  只有「法则」（可随时修改）一个文本属性。 */
export interface WorldInfo {
  conversation_id: string
  laws: string         // 世界法则（可随时修改，每轮注入系统提示词）
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

// ---- Trace（时间线渲染）----

/** Agent 处理链路的时间线条目：按实际发生顺序排列思考、文本输出与工具调用。
 *  前端流式接收 SSE 事件时逐条追加；历史消息从 thinkingSegments + toolCalls 重建。 */
export type TraceEntry =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | {
      type: 'tool_call'
      id?: string
      name: string
      input: Record<string, unknown>
      status?: 'running' | 'done' | 'error'
      result?: string
      artifacts?: Array<{ filename: string; displayName: string; mimeType: string; downloadUrl: string }>
    }

// ---- Config ----

export interface OAuth2Provider {
  id: string
  name: string
  client_id: string
  client_secret: string
  authorize_url: string
  token_url: string
  userinfo_url: string
  scopes: string
}

export interface AppConfig {
  app_name: string
  app_favicon: string  // base64 data URL, empty = use default
  app_background: string  // base64 data URL, empty = no custom background
  api_endpoint: string
  api_key: string
  support_attachments: boolean
  support_infinite_mode: boolean
  allow_im_conversations: boolean
  show_github: boolean
  use_external_image_hosting: boolean
  recommended_questions: string[]
  /** 聊天常用追问（最多 5 条，非空对话输入框上方气泡） */
  followup_questions: string[]
  oauth_providers: OAuth2Provider[]
}

// ---- Agent ----

export interface Agent {
  id: string
  name: string
  model: string
  system_prompt: string
  avatar: string
  role: 'default' | 'neutral'
  created_at: number
  // Voice
  voice_enabled: boolean
  voice_sample_url: string
  voice_settings: string  // JSON: VoiceSettings
}

// ---- Config transfer（配置导入导出） ----

/** 导入文件中的 Agent 条目：字段级可选——省略 = 保持该 Agent 原值（导出时始终写全） */
export interface ConfigTransferAgent {
  id?: string
  role?: 'default' | 'neutral'
  name?: string
  model?: string
  system_prompt?: string
  avatar?: string
}

/**
 * 配置导出/导入包（version 1）。所有段与字段均可选：
 * 省略 = 不更新该键（绝非置空），支持手写只含目标字段的最小文件。
 * 绝不包含网关密钥（api_endpoint/api_key）与声线（voice_*）字段。
 */
export interface ConfigExportBundle {
  version: number
  exported_at?: string
  experience?: {
    app_name?: string
    app_favicon?: string
    app_background?: string
    show_github?: boolean
    recommended_questions?: string[]
    followup_questions?: string[]
  }
  agents?: ConfigTransferAgent[]
  users?: {
    direct_registration_open?: boolean
    oauth_registration_open?: boolean
    /** 条目字段可省略：同 id 覆盖时省略字段保留原值，新建时缺省为空串 */
    oauth_providers?: Partial<OAuth2Provider>[]
  }
}

/** 结构化导入问题：path 定位（如 agents[2].name）；code/params 驱动前端 errors.<code> 渲染 */
export interface ImportIssue {
  path: string
  code: ErrCode
  params?: ErrParams
}

/** dry-run / 正式导入共用的变更摘要 */
export interface ImportSummary {
  experience: { changed: string[]; unchanged: string[] } | null
  agents: {
    update: Array<{ id: string; name: string; neutral: boolean }>
    create: Array<{ id: string | null; name: string }>
    skip: Array<{ id: string; name: string; reason: string }>
  } | null
  users: {
    direct_registration_open: { from: boolean; to: boolean } | null
    oauth_registration_open: { from: boolean; to: boolean } | null
    providers_update: number
    providers_create: number
    providers_skip: number
  } | null
}

/** POST /api/admin/config/import 响应（校验失败也返回 HTTP 200 以携带完整错误列表） */
export interface ImportResponse {
  ok: boolean
  errors: ImportIssue[]
  warnings: ImportIssue[]
  /** dry_run=1 且校验通过时存在 */
  summary?: ImportSummary
  /** 正式导入成功时存在 */
  applied?: ImportSummary
}

// ---- MCP Server Config ----

export interface McpServerConfig {
  id: string
  name: string
  url: string
  enabled: boolean
  created_at: number
}

// ---- User-Agent Memory ----

/** 跨会话记忆条目：某用户对某 Agent 的持久化记忆（user_agent_memories 表） */
export interface UserAgentMemory {
  id: string
  user_id: string
  agent_id: string
  content: string
  source: 'agent' | 'user'  // agent = save_memory 工具写入，user = 用户手动添加
  created_at: number        // unix 秒
}

// ---- Tool Definition ----

/** 工具参数 JSON Schema 属性节点（支持嵌套） */
export interface ToolSchemaProperty {
  type: string
  description?: string
  items?: ToolSchemaProperty
  properties?: Record<string, ToolSchemaProperty>
  required?: string[]
  enum?: string[]
  default?: unknown
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
  pattern?: string
}

export interface ToolDefinition {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, ToolSchemaProperty>
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

// ---- Voice ----

export interface VoiceSettings {
  speed: number              // 0.5 - 2.0，默认 1.0
  pitch: number              // -12 ~ +12 semitones，默认 0
  emotionStrength: number    // 0.0 - 1.0，默认 0.8
  speakerId: string          // TTS API 返回的说话人 ID
  provider: string           // 'gpt-sovits' | 'cosyvoice'
}

export interface VoiceAudioSegment {
  index: number
  text: string               // 这段话对应的原文
  audio_url: string          // 音频文件相对路径
  duration_seconds: number
}

// ---- SSE Events ----

// ThinkingSegment 定义在 shared/thinking.ts（与服务端 loop 共用编解码），此处 re-export
export type { ThinkingSegment } from './thinking.js'

export type ServerMessage =
  | { type: 'conversation_id'; id: string }
  | { type: 'user_message_id'; id: number }
  /** 实时中继专用：他设备渲染用户气泡（源设备本地已有，不重发） */
  | { type: 'user_message'; id: number; content: string; attachments?: Attachment[] }
  | { type: 'token'; text: string; agent_id?: string; agent_name?: string }
  | { type: 'thinking'; text: string; round?: number; agent_id?: string; agent_name?: string }
  | { type: 'tool_call'; id?: string; name: string; input: Record<string, unknown>; agent_id?: string; agent_name?: string }
  | { type: 'tool_execution_start'; id?: string; name: string; input: Record<string, unknown>; agent_id?: string; agent_name?: string }
  | { type: 'tool_result'; id?: string; name: string; summary: string; artifacts?: Array<{ filename: string; displayName: string; mimeType: string; downloadUrl: string }>; agent_id?: string; agent_name?: string }
  | { type: 'agent_start'; agent_id: string; agent_name: string }
  | { type: 'agent_done'; agent_id: string; agent_name: string; reply: string; suggestions: string[] }
  | { type: 'group_start'; agent_ids: string[] }
  | { type: 'group_done'; infinite?: boolean }
  | { type: 'suggestions'; suggestions: string[]; agent_id?: string | null }
  | { type: 'follow_up_start' }
  | { type: 'follow_up'; text: string }
  | { type: 'infinite_mode_off' }
  | { type: 'done'; reply: string; suggestions: string[]; agent_id?: string; agent_name?: string; infinite?: boolean }
  | { type: 'ask_user'; question_id: string; tool_call_id: string; questions: AskUserQuestion[]; agent_id?: string; agent_name?: string }
  | { type: 'error'; code: string; params?: ErrParams; agent_id?: string; agent_name?: string }
  | { type: 'voice_segment'; message_id: number; index: number; audio_url: string; text: string; duration_seconds: number }
  | { type: 'voice_done'; message_id: number; total_segments: number }

// ---- Realtime 事件通道（GET /api/events SSE）----

/** 实时事件通道上推送的负载（event 字段见 ServerMessage，wrapper 附带会话 ID） */
export type RealtimeEvent =
  | { type: 'stream'; conversation_id: string; event: ServerMessage }
  | { type: 'conv_sync' }
  | { type: 'conv_changed'; conversation_id: string }
  | { type: 'group_members'; conversation_id: string }
  | { type: 'unread_update'; conversation_id: string; unread_count: number }

// ---- Ask User Tool ----

export interface AskUserOption {
  label: string
  description?: string
}

export interface AskUserQuestion {
  header: string          // 短标签（最多 12 字符）
  question: string        // 完整问题
  options: AskUserOption[]  // 2-4 个选项
  multiSelect: boolean    // 是否多选
}

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

export interface AdminUserRow {
  username: string
  first_login_at: number | null
  last_login_at: number | null
  last_active_at: number | null
  banned: boolean
  oauth_providers: string[]  // OAuth2 provider ids linked to this user
}

// ---- API Responses ----
