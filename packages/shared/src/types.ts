// ============================================================
// Momoi — Shared Types
// ============================================================

import type { TerrainPatch, TerrainSpec } from './world.js'

// 世界地形类型定义在 shared/world.ts（与服务端的噪声实现、校验层同源），此处 re-export
export type { BiomeRule, TerrainPatch, TerrainSpec } from './world.js'

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
  /** 'world' 由 POST /api/worlds 创建；POST /api/conversations 会显式拒绝该值 */
  type: 'direct' | 'group' | 'world'
  agent_count?: number  // 群组/世界内 Agent 数量（不含中立 Agent，不含用户）
  wechat_bound?: number  // 1 if this conversation is bound to WeChat
  qq_bound?: number      // 1 if this conversation is bound to QQ (C2C or group)
  created_at: number
  updated_at: number
  last_read_at?: number
  unread_count?: number
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
  | { type: 'error'; message: string; agent_id?: string; agent_name?: string }
  | { type: 'world_turn_start'; turn: number; entities: WorldEntity[] }
  | { type: 'world_agent_start'; entity_id: string; name: string }
  | { type: 'world_event'; event: WorldEvent }
  | { type: 'world_agent_done'; entity_id: string; name: string }
  | { type: 'world_turn_end'; turn: number }
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
  /**
   * 世界模拟：地形生成状态变更。**只传状态、不传 spec** —— 该事件会扇出到本账号
   * 的每一台设备，而数 KB 的地形参数不该搭上根本没开世界面板的设备；客户端在
   * 转入 'ready' 时自行重拉 GET /api/worlds/:id。
   */
  | { type: 'world_status'; conversation_id: string; status: WorldStatus }
  /**
   * 世界回合中产生的单条事件。世界事件是**离散**的（不是 token 流），
   * 故可直接中继，无需聊天流那条有损的 token 批量路径。
   */
  | { type: 'world_event'; conversation_id: string; event: WorldEvent }
  /**
   * 世界回合的生命周期（开始 / 结束）。其它设备据此禁用输入并显示「谁正在行动」——
   * 单靠 world_event 无法判断一轮是否还在跑（最后一个事件与结束之间没有信号）。
   */
  | { type: 'world_turn'; conversation_id: string; turn: number; running: boolean; auto_tick?: boolean }

// ---- 世界模拟（World Simulation）----

export type WorldStatus = 'generating' | 'ready' | 'failed'

/** GET /api/worlds/:conversationId 的完整载荷 */
export interface WorldSnapshot {
  world: WorldState
  entities: WorldEntity[]
  /** 按 (turn, seq) 升序的最近若干条事件 */
  events: WorldEvent[]
  /** 按 (seq) 升序的改造补丁 —— 渲染时 fold 到基准地形之上，永不写回 terrain_spec */
  patches: TerrainPatch[]
  /** 参与成员（含头像，供沙盘名牌使用） */
  agents: Array<{ id: string; name: string; avatar: string }>
  /**
   * 自动演算开关。**内存态，不落库** —— 与无限演算模式的 infiniteState 同一惯例
   * （重启即关闭是合理且安全的默认，而为此加一个 worlds 列要付的代价是 PG 那条
   * 并不存在的 ALTER 通道）。故它挂在快照旁，而不是塞进 WorldState。
   */
  auto_tick: boolean
}

export type WorldEntityKind = 'agent' | 'god'
export type WorldEntityStatus = 'alive' | 'dead' | 'gone'

/** 世界中的一个存在：Agent，或（Phase 3 起）上帝的 Avatar */
export interface WorldEntity {
  id: string
  conversation_id: string
  kind: WorldEntityKind
  /** kind='agent' 时关联 agents.id；kind='god' 为 null */
  agent_id: string | null
  name: string
  /** 归一化坐标，各自 ∈ [−1, 1]；世界中心为 (0, 0) */
  x: number
  z: number
  status: WorldEntityStatus
  created_at: number
  updated_at: number
}

export type WorldActorKind = 'god' | 'agent' | 'world'
export type WorldEventKind = 'act' | 'speak' | 'move' | 'die' | 'law' | 'narration'

/**
 * 世界里发生的一件事 —— 世界的「消息」。
 * 世界不渲染聊天气泡，事件日志就是它的历史与表达。
 */
export interface WorldEvent {
  id: number
  conversation_id: string
  /** 回合序号：一次「上帝行动 → Agent 依次行动」为一个回合 */
  turn: number
  /** 回合内顺序 */
  seq: number
  actor_kind: WorldActorKind
  /** world_entities.id；'world' 类事件为 null */
  actor_id: string | null
  actor_name: string
  kind: WorldEventKind
  content: string
  /** 结构化增量：坐标移动、状态变更等 */
  payload?: Record<string, unknown> | null
  created_at: number
}

/** GET /api/worlds/:conversationId 返回的世界状态；生成中 terrain_spec 为 null */
export interface WorldState {
  conversation_id: string
  status: WorldStatus
  status_error: string
  /** 用户原文「世界地形规则」—— 创生后**不可修改** */
  terrain_prompt: string
  /** 由 terrain_prompt 翻译出的结构化地形参数（LLM 或关键词兜底） */
  terrain_spec: TerrainSpec | null
  /** 世界法则 —— **可修改** */
  laws: string
  turn: number
  created_at: number
  updated_at: number
}

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
