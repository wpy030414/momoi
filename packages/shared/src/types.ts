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
  /** 创建时锁定的分组工作区；null/缺省 = 未分组（独享会话级沙箱）。
   *  值永不 UPDATE——悬空值（工作区已删除）按未分组渲染，但沙箱仍锚定 ws-<id>。 */
  workspace_id?: string | null
  /** 会话状态条统计——**服务端权威快照**。仅会话详情 `GET /api/conversations/:id`
   *  携带（列表端点不返回：状态条随会话上下文下发）；null/缺省 = 尚未生成过。
   *  契约见 `docs/specs/module-chat.md`〈会话状态条〉。 */
  stats?: ConversationStats | null
}

/** 会话状态条数据：工作区 | 累计消耗 | 本轮耗时 · tok/s | 上下文占用 %。
 *  服务端每次生成后计算并持久化到 conversations.stats，客户端一律**原样采用**——
 *  不比较、不合并、不判定新旧（发放权威在服务端）。
 *
 *  注意：`rounds` / `steps` **不上状态条**（界面显示的是 `durationMs`）。它们仍在
 *  快照里，供诊断与将来做「生成中实时进度」之用——见 module-chat.md〈会话状态条〉。 */
export interface ConversationStats {
  /** 本会话**累计消耗**（账单口径）：Σ 每次 LLM 调用的（输入 + 输出），跨所有生成、
   *  所有轮次累加。agent 每轮都会把整个上下文重发一次，**重复投喂也计入**——这就是
   *  网关真正计费的口径。快照每次覆盖写而该值只增不减（见 ai/conversation-stats.ts）。 */
  totalTokens?: number
  /** true = `totalTokens` 中含估算部分（存量会话的历史回填，或某次生成整轮未回 usage）。
   *  一旦置位**永不回退**——估算进来了就不能再假装精确。
   *  标注：状态条当前**不渲染**该标记（只列裸数字），留给工具提示 / 详情视图。 */
  totalEstimated?: boolean
  /** 本轮生成耗时（ms，服务端墙钟）。单聊 = AI 循环段（含工具执行与空回复重试）；
   *  群聊 = 整轮编排（含发言裁决与各成员串行回复）。
   *  缺省 = 该字段上线前写入的存量快照。 */
  durationMs?: number
  /** 最近一次生成的 Agent 循环轮数（LLM 调用次数，含工具往返）——诊断用，不上 UI */
  rounds: number
  /** 最近一次生成的工具执行步数（每个 tool_execution_start 计一步）——诊断用，不上 UI */
  steps: number
  /** 最近一次生成的输出速度（tok/s；无输出时 0） */
  tokensPerSecond: number
  /** **当前上下文占用** token 数（优先上游 usage；estimated = 字符估算值）——百分比的分母侧 */
  contextTokens: number
  /** true = contextTokens 来自字符估算而非上游 usage。
   *  标注：状态条当前**不渲染**该标记（只列裸数字），留给工具提示 / 详情视图。 */
  estimated?: boolean
}

/** 会话分组工作区（workspaces 表）：文件夹语义。
 *  会话创建时锁定一个工作区（或未分组），之后不可移动；
 *  同一工作区内的会话共享文件沙箱目录 data/workspaces/ws-<id>。 */
export interface Workspace {
  id: string
  user_id: string
  name: string
  created_at: number
  updated_at: number
}

/** GET /api/conversations/search 响应条目 */
export interface ConversationSearchResult {
  conversation: Pick<Conversation, 'id' | 'title' | 'type' | 'agent_id' | 'updated_at' | 'workspace_id'>
  matched: 'title' | 'content'
  /** matched='content' 时的命中片段（前后各 ~40 字符，换行已折叠） */
  snippet?: string
}

/** 世界状态 · 属性定义（worlds.states JSON 内一项）。约束见
 *  docs/specs/module-world.md：属性名 ≤20 字且唯一；默认值/值 ≤60 字符、
 *  单行、禁「|」（轮末结算的行解析格式护栏）。 */
export interface WorldStateDef {
  /** 属性名 */
  name: string
  /** 默认值（仅用于初始化；显示字符串） */
  default: string
  /** 属性描述（≤100 字，可选；注入提示词帮助模型理解语义） */
  description?: string
}

/** 世界状态 · 当前值：agentId → { 属性名 → 值 }。值统一为显示字符串
 *  （数值语义由前端按可解析性自行呈现，如方向箭头）。 */
export type WorldStateValues = Record<string, Record<string, string>>

/** 世界运行态（法则 + 状态定义 + 当前值）——编排器 / 提示词片段 /
 *  update_state 工具 / 轮末结算共用的已解析视图。 */
export interface WorldStateRuntime {
  laws: string
  states: WorldStateDef[]
  state_values: WorldStateValues
}

/** 提示词侧世界状态行：成员按名字呈现（供「全员状态表」渲染）。 */
export interface WorldStateRow {
  name: string
  values: Record<string, string>
}

/** 提示词侧世界运行态视图：法则 + 状态定义 + 按名字的状态行。
 *  与 WorldStateRuntime（id 键控）区分——这是注入系统提示词的展示形态，
 *  由编排器按 Agent 从运行态快照构造。 */
export interface WorldStatePromptView {
  laws: string
  states: WorldStateDef[]
  state_rows: WorldStateRow[]
}

/** 世界模拟的侧表信息（worlds 行）。世界模拟是纯文本群聊的变体：
 *  两个可变维度 —— 法则（每轮注入系统提示词）与状态（定义 + 各成员当前值）。 */
export interface WorldInfo extends WorldStateRuntime {
  conversation_id: string
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

// ---- Intelligent UI Cards（生成式卡片）----

/** 卡片组件名。v1 的七种模型可生成卡型一次定死（trace/SSE 历史数据稳定），
 *  前端注册表分期充实；'state' 为引擎合成卡（世界模拟状态变更——非 ui_* 工具
 *  声明，见 docs/specs/module-world.md 与 module-intelligent-ui.md 的引擎合成章节）。
 *  协议与实施见 docs/specs/module-intelligent-ui.md。 */
export type CardComponent = 'chart' | 'stat' | 'table' | 'diagram' | 'form' | 'app' | 'character' | 'state'

/** 卡片描述符：模型经 ui_* 工具声明 → 服务端 catalog 校验（唯一权威）→ SSE `card`
 *  事件推送 + TraceEntry 持久化 → 前端注册表懒加载渲染的统一载体。 */
export interface CardDescriptor {
  component: CardComponent
  /** 卡片标题（可选；CardFrame 渲染） */
  title?: string
  /** 组件 props——shape 由服务端 catalog 按 component 校验；前端按组件本地类型消费 */
  props: Record<string, unknown>
}

/** card-action 协议块：用户与卡片交互时，前端合成的用户消息 content 内
 *  `CARD_ACTION_FENCE`（shared/constants）围栏中的 JSON——模型回喂天然可见，
 *  前端渲染为紧凑交互 chip（D5 suggestions 围栏先例）。 */
export interface CardActionPayload {
  v: 1
  /** 对位 TraceEntry card 变体的 id（= 声明该卡片的工具调用 id） */
  card_id: string
  component: CardComponent
  /** 组件自定义动作名：'submit' | 'click' | ... */
  action: string
  /** 人类可读动作描述（按钮文案等），供摘要行与模型理解 */
  label?: string
  /** 表单值 / 选中项等动作负载 */
  payload?: Record<string, unknown>
  /** 本地计算模式：卡片内算出的结果（随「发送给 AI」带回模型） */
  result?: number
}

// ---- Trace（时间线渲染）----

/** Agent 处理链路的时间线条目：按实际发生顺序排列思考、文本输出、工具调用与卡片。
 *  前端流式接收 SSE 事件时逐条追加；历史消息从 trace 列整体重建。 */
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
  // 卡片：声明位置紧跟对应 ui_* 工具调用条目之后（id = 工具调用 id，card_action 对位用）
  | { type: 'card'; id?: string; card: CardDescriptor }

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

/** 网关上游类型：custom = 管理员自配置的 OpenAI 兼容端点；workbuddy = 内置 WorkBuddy
 *  上游（凭证由服务端托管并后台自动轮换）；doubao = 内置豆包网页上游（扫码登录 +
 *  Cookie 凭证，见 apps/server/src/ai/doubao/）。 */
export type GatewaySource = 'custom' | 'workbuddy' | 'doubao'

export interface AppConfig {
  app_name: string
  app_favicon: string  // base64 data URL, empty = use default
  app_background: string  // base64 data URL, empty = no custom background
  /** 网关上游类型；custom 时 api_endpoint/api_key 生效，workbuddy/doubao 时由内置转发器接管 */
  gateway_source: GatewaySource
  api_endpoint: string
  api_key: string
  /** 模型上下文窗口大小（tokens）：会话状态条「上下文（已用）%」的分母。
   *  管理端网关设置可改；缺省 128000。 */
  context_window: number
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

// ---- WorkBuddy 上游 ----

/** WorkBuddy 凭证状态（不含任何 token 明文，仅用于管理端展示） */
export interface WorkBuddyStatus {
  logged_in: boolean
  /** access token 是否已过期（过期后由后台轮换或需重新登录） */
  expired?: boolean
  uid?: string
  nickname?: string
  domain?: string
  expires_at?: string
  refresh_expires_at?: string
  has_refresh_token?: boolean
  /** 后台是否启用自动轮换 */
  auto_refresh: boolean
}

/** 一次网页登录会话的进度 */
export interface WorkBuddyLoginStatus {
  status: 'idle' | 'pending' | 'scanned' | 'success' | 'failed'
  message?: string
  /** 登录页的微信二维码 data URL（服务端无头浏览器截获；不可用时缺省） */
  qr_data_url?: string
  credential?: WorkBuddyStatus
}

// ---- Doubao（豆包网页）上游 ----

/** 豆包凭证状态（不含任何 Cookie 明文，仅用于管理端展示） */
export interface DoubaoStatus {
  logged_in: boolean
  /** 凭证来源：store = 扫码登录后加密存储；env = DOUBAO_COOKIES 灾备 */
  source?: 'store' | 'env'
  uid?: string
  nickname?: string
  /** 凭证保存时间（ISO） */
  saved_at?: string
  /** 当前有效 Cookie 条数 */
  cookie_count?: number
  /** 上游风控标记：需在浏览器完成人机验证后重置 */
  needs_captcha?: boolean
}

/** 豆包扫码登录进度（二维码由登录链路产出：默认抖音授权码，回退豆包自助扫码码） */
export interface DoubaoLoginStatus {
  status: 'idle' | 'pending' | 'scanned' | 'success' | 'failed' | 'expired'
  /** 登录链路：douyin = 抖音授权页二维码（默认）；doubao = 豆包自助扫码（灾备） */
  flow?: 'douyin' | 'doubao'
  message?: string
  /** 二维码 PNG data URL（pending / scanned 时存在） */
  qr_data_url?: string
  /** 二维码过期时间（ISO；链路未知时缺省） */
  expire_at?: string
  credential?: DoubaoStatus
}

// ---- 上游模型目录（Agent 表单的模型下拉） ----

/** 上游模型目录中的一项 */
export interface GatewayModelOption {
  id: string
  /** 展示名；缺省或与 id 相同时前端只显示 id */
  name?: string
  /** 供应商（WorkBuddy 目录提供，如 GLM / DeepSeek） */
  vendor?: string
}

/**
 * 上游模型目录。拉取失败不抛错：models 为空数组并带 warning，
 * 管理端据此回退为手动填写模型 ID。
 */
export interface GatewayModelList {
  source: GatewaySource
  models: GatewayModelOption[]
  warning?: 'not_logged_in' | 'upstream_error'
  /** 上游原始错误摘要（排查用，随 warning 展示） */
  detail?: string
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
 * 网关段：与后台「网关」页的 7 项一一对应。
 * 导出的是**生效值**（`map.get(key) || env.*`），因此 api_key/api_endpoint 可能来自
 * .env 而从未被管理员在界面上输入过；导入会把它们写进 settings 表，从而「钉住」并
 * 覆盖目标实例的 .env。详见 docs/specs/module-config.md 的导入导出章节。
 */
export interface ConfigExportGateway {
  /** 上游类型（custom / workbuddy / doubao）。凭证本身不可迁移：workbuddy / doubao 导入后仍需在网关页登录。 */
  gateway_source?: GatewaySource
  api_endpoint?: string
  api_key?: string
  context_window?: number
  support_attachments?: boolean
  support_infinite_mode?: boolean
  use_external_image_hosting?: boolean
  allow_im_conversations?: boolean
}

/**
 * 配置导出/导入包（version 1）。所有段与字段均可选：
 * 省略 = 不更新该键（绝非置空），支持手写只含目标字段的最小文件。
 * **含网关段（api_endpoint/api_key 明文）**——文件等同凭证，导出/导入均需 PIN 二次校验；
 * 仍不含声线（voice_*）字段。
 */
export interface ConfigExportBundle {
  version: number
  exported_at?: string
  gateway?: ConfigExportGateway
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

/**
 * dry-run / 正式导入共用的变更摘要。
 * 只承载**字段名**，绝不承载字段值——否则 dry-run 响应会把 api_key / client_secret 回显给客户端。
 */
export interface ImportSummary {
  gateway: { changed: string[]; unchanged: string[] } | null
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
  /** ui_* 卡片工具执行完成时发出——先于同一次工具调用的 tool_result。
   *  与 TraceEntry card 变体同源（id = 工具调用 id）。 */
  | { type: 'card'; id?: string; card: CardDescriptor; agent_id?: string; agent_name?: string }
  | { type: 'agent_start'; agent_id: string; agent_name: string }
  | { type: 'agent_done'; agent_id: string; agent_name: string; reply: string; suggestions: string[] }
  | { type: 'group_start'; agent_ids: string[] }
  | { type: 'group_done'; infinite?: boolean }
  | { type: 'suggestions'; suggestions: string[]; agent_id?: string | null }
  | { type: 'follow_up_start' }
  | { type: 'follow_up'; text: string }
  | { type: 'infinite_mode_off' }
  | { type: 'done'; reply: string; suggestions: string[]; agent_id?: string; agent_name?: string; infinite?: boolean }
  | { type: 'stats'; stats: ConversationStats }
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
