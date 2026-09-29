// ============================================================
// Momoi — Business Error Codes
//
// 前后端共享的错误码契约（唯一事实来源）：
//  - wire 形状：{ code: string, params?: Record<string, string | number> }
//    （REST 错误响应、SSE error 事件、ImportIssue 三处统一；不发 message）
//  - code 字符串直接作为前端 i18n 键后缀：errors.<CODE>（三语 locale 均须覆盖）
//  - ERR_REGISTRY 声明每码默认 HTTP status 与 params 参数名：
//    server 端 ApiError 取默认状态、契约测试据此校验 locale 模板占位符
//
// 约定：
//  - params.detail = 动态透传内容（上游错误文本、文件名等）；
//    其余（limit/seconds/id/name/…）为结构化参数，供 i18n {{param}} 插值
//  - 某码的 params 为「全有或全无」：调用点要么提供全部声明参数，要么不传
//    （模板可依赖声明的参数存在；可选信息一律折进 detail 或只进日志）
//  - 仅内嵌在 200 载荷中的码（CONFIG_IMPORT_*、WECHAT_CONV_DELETED、
//    QQ_CONNECTION_FAILED、SSE 流内 CHAT_*）的 status 仅为名义值，不上 wire
// ============================================================

/** 错误参数：值为字符串或数字（与 i18next 插值兼容） */
export type ErrParams = Record<string, string | number>

export enum ErrCode {
  // ---- COMMON ----
  /** 未捕获异常兜底（onError；完整堆栈只进日志，不上 wire） */
  INTERNAL = 'INTERNAL',
  /** 未匹配的 API 路由（app.notFound 的 /api/* 分支） */
  NOT_FOUND = 'NOT_FOUND',

  // ---- AUTH（认证通用；userAuth / adminAuth 中间件 + 登录） ----
  /** 未登录 / 无 userId（原 'Unauthorized'，~27 处收敛） */
  UNAUTHORIZED = 'UNAUTHORIZED',
  /** cookie JWT 无效或过期 */
  AUTH_INVALID_TOKEN = 'AUTH_INVALID_TOKEN',
  /** 非管理员访问管理路由 */
  AUTH_FORBIDDEN = 'AUTH_FORBIDDEN',
  /** 登录 PIN 错误 */
  AUTH_INVALID_PIN = 'AUTH_INVALID_PIN',
  /** 修改 PIN 时旧 PIN 错误 */
  AUTH_INVALID_CURRENT_PIN = 'AUTH_INVALID_CURRENT_PIN',

  // ---- USER（user.ts + oauth.ts 共用） ----
  USER_NAME_REQUIRED = 'USER_NAME_REQUIRED',
  /** IP 因连续 PIN 错误被封禁；params.seconds = 剩余秒数 */
  USER_RATE_LIMITED = 'USER_RATE_LIMITED',
  USER_PIN_FORMAT = 'USER_PIN_FORMAT',
  USER_PIN_NOT_SET = 'USER_PIN_NOT_SET',
  USER_DISABLED = 'USER_DISABLED',
  USER_REGISTRATION_CLOSED = 'USER_REGISTRATION_CLOSED',
  USER_PIN_ALREADY_SET = 'USER_PIN_ALREADY_SET',
  USER_NAME_TAKEN = 'USER_NAME_TAKEN',
  USER_RENAME_REQUIRED = 'USER_RENAME_REQUIRED',
  USER_RENAME_SAME = 'USER_RENAME_SAME',
  USER_BINDING_NOT_FOUND = 'USER_BINDING_NOT_FOUND',
  USER_BINDING_NOT_OWNED = 'USER_BINDING_NOT_OWNED',
  USER_CANNOT_REMOVE_ONLY_LOGIN = 'USER_CANNOT_REMOVE_ONLY_LOGIN',

  // ---- OAUTH（* = 主要经 302 ?oauth_error_code= 传递） ----
  OAUTH_UNKNOWN_PROVIDER = 'OAUTH_UNKNOWN_PROVIDER',
  /** IdP 回调自带 error 参数；params.detail = IdP 原始 error 值 * */
  OAUTH_PROVIDER_ERROR = 'OAUTH_PROVIDER_ERROR',
  OAUTH_INVALID_STATE = 'OAUTH_INVALID_STATE',
  OAUTH_NO_AUTH_CODE = 'OAUTH_NO_AUTH_CODE',
  /** 换 token 失败；params.detail = 上游响应体 * */
  OAUTH_TOKEN_EXCHANGE_FAILED = 'OAUTH_TOKEN_EXCHANGE_FAILED',
  OAUTH_LINKED_USER_NOT_FOUND = 'OAUTH_LINKED_USER_NOT_FOUND',
  OAUTH_REGISTRATION_CLOSED = 'OAUTH_REGISTRATION_CLOSED',
  OAUTH_MISSING_FIELDS = 'OAUTH_MISSING_FIELDS',
  OAUTH_ALREADY_LINKED = 'OAUTH_ALREADY_LINKED',
  OAUTH_ACCOUNT_NOT_FOUND = 'OAUTH_ACCOUNT_NOT_FOUND',
  OAUTH_ACCOUNT_NO_PIN = 'OAUTH_ACCOUNT_NO_PIN',

  // ---- CONV（会话） ----
  /** 会话不存在或无权访问（13 处收敛；upload 路由同语义） */
  CONV_NOT_FOUND = 'CONV_NOT_FOUND',
  /** 世界会话只能经 POST /api/worlds 创建（REST + SSE 两处） */
  CONV_WORLD_CREATE_ONLY = 'CONV_WORLD_CREATE_ONLY',
  CONV_MERGE_MIN_TWO = 'CONV_MERGE_MIN_TWO',
  /** params.id = 会话 ID */
  CONV_MERGE_SOURCE_NOT_FOUND = 'CONV_MERGE_SOURCE_NOT_FOUND',
  /** params.id = 会话 ID */
  CONV_MERGE_SOURCE_NOT_GROUP = 'CONV_MERGE_SOURCE_NOT_GROUP',
  CONV_MERGE_MIXED_TYPES = 'CONV_MERGE_MIXED_TYPES',
  CONV_MESSAGE_NOT_FOUND = 'CONV_MESSAGE_NOT_FOUND',

  // ---- CHAT（REST + SSE 流内；SSE 点不 carry HTTP status） ----
  CHAT_CONVERSATION_ID_REQUIRED = 'CHAT_CONVERSATION_ID_REQUIRED',
  /** 会话不存在或无权（REST 404 与 SSE error 事件同码） */
  CHAT_CONVERSATION_ACCESS_DENIED = 'CHAT_CONVERSATION_ACCESS_DENIED',
  CHAT_EMPTY_MESSAGE = 'CHAT_EMPTY_MESSAGE',
  CHAT_QUESTION_ID_REQUIRED = 'CHAT_QUESTION_ID_REQUIRED',
  CHAT_QUESTION_EXPIRED = 'CHAT_QUESTION_EXPIRED',
  CHAT_QUESTION_WRONG_CONVERSATION = 'CHAT_QUESTION_WRONG_CONVERSATION',
  CHAT_QUESTION_ALREADY_ANSWERED = 'CHAT_QUESTION_ALREADY_ANSWERED',
  /** SSE：会话不是世界类型 */
  CHAT_WORLD_ONLY = 'CHAT_WORLD_ONLY',
  /** SSE：世界无成员 */
  CHAT_WORLD_NO_MEMBERS = 'CHAT_WORLD_NO_MEMBERS',
  /** SSE：流水线未捕获异常（原 message 只进日志） */
  CHAT_INTERNAL_ERROR = 'CHAT_INTERNAL_ERROR',

  // ---- AI / SSE 上游 ----
  /** 上游 API 请求超时（120s） */
  AI_UPSTREAM_TIMEOUT = 'AI_UPSTREAM_TIMEOUT',
  /** 上游 API 错误；params.detail = "HTTP <status>: <body>" 等摘要 */
  AI_UPSTREAM_ERROR = 'AI_UPSTREAM_ERROR',
  /** 上游流未收到 [DONE] 即中断 */
  AI_STREAM_CLOSED = 'AI_STREAM_CLOSED',
  /** 探针确认网关不可达（探针细节只进日志） */
  AI_UPSTREAM_UNREACHABLE = 'AI_UPSTREAM_UNREACHABLE',

  // ---- ADMIN ----
  ADMIN_CONTENT_REQUIRED = 'ADMIN_CONTENT_REQUIRED',
  ADMIN_AGENT_NAME_REQUIRED = 'ADMIN_AGENT_NAME_REQUIRED',
  ADMIN_AGENT_NOT_FOUND = 'ADMIN_AGENT_NOT_FOUND',
  ADMIN_NEUTRAL_AGENT_DELETE = 'ADMIN_NEUTRAL_AGENT_DELETE',
  ADMIN_CANNOT_BAN_SELF = 'ADMIN_CANNOT_BAN_SELF',
  ADMIN_CANNOT_DELETE_SELF = 'ADMIN_CANNOT_DELETE_SELF',
  ADMIN_CANNOT_FORGET_OWN = 'ADMIN_CANNOT_FORGET_OWN',
  ADMIN_USER_NOT_FOUND = 'ADMIN_USER_NOT_FOUND',
  ADMIN_SKILL_NO_FILE = 'ADMIN_SKILL_NO_FILE',
  /** params.limit = 上限（如 '50MB'） */
  ADMIN_SKILL_FILE_TOO_LARGE = 'ADMIN_SKILL_FILE_TOO_LARGE',
  ADMIN_SKILL_ZIP_TRAVERSAL = 'ADMIN_SKILL_ZIP_TRAVERSAL',
  ADMIN_SKILL_NO_SKILL_MD = 'ADMIN_SKILL_NO_SKILL_MD',
  ADMIN_SKILL_NO_FRONTMATTER = 'ADMIN_SKILL_NO_FRONTMATTER',
  ADMIN_SKILL_NAME_REQUIRED = 'ADMIN_SKILL_NAME_REQUIRED',
  /** params.name = 技能名 */
  ADMIN_SKILL_NOT_FOUND = 'ADMIN_SKILL_NOT_FOUND',
  ADMIN_MCP_FIELDS_REQUIRED = 'ADMIN_MCP_FIELDS_REQUIRED',
  ADMIN_MCP_NOT_FOUND = 'ADMIN_MCP_NOT_FOUND',
  ADMIN_VOICE_NO_FILE = 'ADMIN_VOICE_NO_FILE',
  /** params.limit = 上限（如 '10MB'） */
  ADMIN_VOICE_FILE_TOO_LARGE = 'ADMIN_VOICE_FILE_TOO_LARGE',
  /** params.ext / params.allowed = 实际扩展名 / 允许列表 */
  ADMIN_VOICE_FORMAT_UNSUPPORTED = 'ADMIN_VOICE_FORMAT_UNSUPPORTED',
  ADMIN_VOICE_NO_SAMPLE = 'ADMIN_VOICE_NO_SAMPLE',
  /** params.detail = TTS 异常摘要（完整 err 只进日志） */
  ADMIN_VOICE_CLONE_FAILED = 'ADMIN_VOICE_CLONE_FAILED',

  // ---- UPLOAD ----
  UPLOAD_NO_FILE = 'UPLOAD_NO_FILE',
  UPLOAD_CONVERSATION_ID_REQUIRED = 'UPLOAD_CONVERSATION_ID_REQUIRED',
  /** params.limit = 上限（如 '20MB'） */
  UPLOAD_FILE_TOO_LARGE = 'UPLOAD_FILE_TOO_LARGE',
  /** 通用上传失败；params.detail = 异常摘要（upload.ts 与 admin.ts 技能上传共用） */
  UPLOAD_FAILED = 'UPLOAD_FAILED',

  // ---- WORKSPACE ----
  WORKSPACE_NOT_FOUND = 'WORKSPACE_NOT_FOUND',
  WORKSPACE_INVALID_PATH = 'WORKSPACE_INVALID_PATH',
  WORKSPACE_FILE_NOT_FOUND = 'WORKSPACE_FILE_NOT_FOUND',

  // ---- GROUP ----
  GROUP_AGENT_ID_REQUIRED = 'GROUP_AGENT_ID_REQUIRED',
  GROUP_NEUTRAL_AGENT_FORBIDDEN = 'GROUP_NEUTRAL_AGENT_FORBIDDEN',

  // ---- WORLD ----
  WORLD_AGENTS_REQUIRED = 'WORLD_AGENTS_REQUIRED',
  WORLD_NOTHING_TO_UPDATE = 'WORLD_NOTHING_TO_UPDATE',
  WORLD_NOT_FOUND = 'WORLD_NOT_FOUND',

  // ---- MEMORY ----
  MEMORY_AGENT_ID_REQUIRED = 'MEMORY_AGENT_ID_REQUIRED',
  MEMORY_CONTENT_EMPTY = 'MEMORY_CONTENT_EMPTY',
  /** params.limit = 字符上限 */
  MEMORY_CONTENT_TOO_LONG = 'MEMORY_CONTENT_TOO_LONG',
  MEMORY_NEUTRAL_AGENT_FORBIDDEN = 'MEMORY_NEUTRAL_AGENT_FORBIDDEN',
  MEMORY_NOT_FOUND = 'MEMORY_NOT_FOUND',

  // ---- VOICE ----
  VOICE_PARAMS_REQUIRED = 'VOICE_PARAMS_REQUIRED',

  // ---- DOCS ----
  DOCS_INVALID_PATH = 'DOCS_INVALID_PATH',
  DOCS_NOT_FOUND = 'DOCS_NOT_FOUND',

  // ---- ASSET（原纯文本响应，统一为 JSON envelope） ----
  ASSET_FORBIDDEN = 'ASSET_FORBIDDEN',
  ASSET_NOT_FOUND = 'ASSET_NOT_FOUND',

  // ---- PUSH ----
  PUSH_FIELDS_REQUIRED = 'PUSH_FIELDS_REQUIRED',

  // ---- PROMPT（/api/admin/prompts） ----
  PROMPT_ID_REQUIRED = 'PROMPT_ID_REQUIRED',
  /** params.id = 片段 ID */
  PROMPT_FRAGMENT_NOT_FOUND = 'PROMPT_FRAGMENT_NOT_FOUND',
  PROMPT_TARGET_REQUIRED = 'PROMPT_TARGET_REQUIRED',

  // ---- WECHAT ----
  WECHAT_CONV_NOT_BINDABLE = 'WECHAT_CONV_NOT_BINDABLE',
  /** iLink 二维码上游失败；params.detail = "HTTP <status> <body>" */
  WECHAT_QR_FAILED = 'WECHAT_QR_FAILED',
  WECHAT_QRCODE_ID_REQUIRED = 'WECHAT_QRCODE_ID_REQUIRED',
  /** 绑定轮询 200 载荷 {status:'expired', code}——目标会话已删除 */
  WECHAT_CONV_DELETED = 'WECHAT_CONV_DELETED',

  // ---- QQ ----
  QQ_AGENT_ID_REQUIRED = 'QQ_AGENT_ID_REQUIRED',
  QQ_CONV_NOT_BINDABLE = 'QQ_CONV_NOT_BINDABLE',
  QQ_CREDENTIALS_REQUIRED = 'QQ_CREDENTIALS_REQUIRED',
  /** params.detail = 上游异常摘要 */
  QQ_CREDENTIALS_INVALID = 'QQ_CREDENTIALS_INVALID',
  QQ_MISSING_EXISTING_BINDING = 'QQ_MISSING_EXISTING_BINDING',
  QQ_CONV_ID_REQUIRED = 'QQ_CONV_ID_REQUIRED',
  /** GET /bind 200 载荷内嵌 error_code + error_detail；params.detail = 网关错误串 */
  QQ_CONNECTION_FAILED = 'QQ_CONNECTION_FAILED',

  // ---- CONFIG_IMPORT（ImportIssue 内嵌，随 HTTP 200 返回；status 名义值不上 wire） ----
  CONFIG_IMPORT_NOT_MAPPING = 'CONFIG_IMPORT_NOT_MAPPING',
  CONFIG_IMPORT_TOO_LARGE = 'CONFIG_IMPORT_TOO_LARGE',
  CONFIG_IMPORT_INVALID_YAML = 'CONFIG_IMPORT_INVALID_YAML',
  /** params.key */
  CONFIG_IMPORT_UNKNOWN_TOP_KEY = 'CONFIG_IMPORT_UNKNOWN_TOP_KEY',
  /** params.version */
  CONFIG_IMPORT_BAD_VERSION = 'CONFIG_IMPORT_BAD_VERSION',
  CONFIG_IMPORT_BAD_EXPORTED_AT = 'CONFIG_IMPORT_BAD_EXPORTED_AT',
  CONFIG_IMPORT_EMPTY = 'CONFIG_IMPORT_EMPTY',
  /** params.section */
  CONFIG_IMPORT_BAD_SECTION = 'CONFIG_IMPORT_BAD_SECTION',
  CONFIG_IMPORT_BAD_AGENTS_TYPE = 'CONFIG_IMPORT_BAD_AGENTS_TYPE',
  /** params.key */
  CONFIG_IMPORT_UNKNOWN_EXPERIENCE_KEY = 'CONFIG_IMPORT_UNKNOWN_EXPERIENCE_KEY',
  CONFIG_IMPORT_BAD_APP_NAME = 'CONFIG_IMPORT_BAD_APP_NAME',
  /** params.field */
  CONFIG_IMPORT_BAD_IMAGE_URL = 'CONFIG_IMPORT_BAD_IMAGE_URL',
  /** params.field */
  CONFIG_IMPORT_BAD_BOOLEAN = 'CONFIG_IMPORT_BAD_BOOLEAN',
  /** params.field */
  CONFIG_IMPORT_NOT_ARRAY = 'CONFIG_IMPORT_NOT_ARRAY',
  CONFIG_IMPORT_TOO_MANY_QUESTIONS = 'CONFIG_IMPORT_TOO_MANY_QUESTIONS',
  CONFIG_IMPORT_TOO_MANY_FOLLOWUPS = 'CONFIG_IMPORT_TOO_MANY_FOLLOWUPS',
  /** params.field */
  CONFIG_IMPORT_BAD_QUESTION = 'CONFIG_IMPORT_BAD_QUESTION',
  /** params.key */
  CONFIG_IMPORT_UNKNOWN_AGENT_KEY = 'CONFIG_IMPORT_UNKNOWN_AGENT_KEY',
  CONFIG_IMPORT_BAD_ROLE = 'CONFIG_IMPORT_BAD_ROLE',
  CONFIG_IMPORT_BAD_AGENT_ID = 'CONFIG_IMPORT_BAD_AGENT_ID',
  CONFIG_IMPORT_NEUTRAL_NAME_IMMUTABLE = 'CONFIG_IMPORT_NEUTRAL_NAME_IMMUTABLE',
  /** warning：中立 Agent 的 avatar 被忽略 */
  CONFIG_IMPORT_NEUTRAL_AVATAR_IGNORED = 'CONFIG_IMPORT_NEUTRAL_AVATAR_IGNORED',
  CONFIG_IMPORT_AGENT_NAME_REQUIRED = 'CONFIG_IMPORT_AGENT_NAME_REQUIRED',
  CONFIG_IMPORT_BAD_AGENT_NAME = 'CONFIG_IMPORT_BAD_AGENT_NAME',
  CONFIG_IMPORT_BAD_MODEL = 'CONFIG_IMPORT_BAD_MODEL',
  CONFIG_IMPORT_BAD_SYSTEM_PROMPT = 'CONFIG_IMPORT_BAD_SYSTEM_PROMPT',
  /** params.id */
  CONFIG_IMPORT_DUPLICATE_AGENT_ID = 'CONFIG_IMPORT_DUPLICATE_AGENT_ID',
  CONFIG_IMPORT_TOO_MANY_AGENTS = 'CONFIG_IMPORT_TOO_MANY_AGENTS',
  /** params.key */
  CONFIG_IMPORT_UNKNOWN_USERS_KEY = 'CONFIG_IMPORT_UNKNOWN_USERS_KEY',
  CONFIG_IMPORT_TOO_MANY_PROVIDERS = 'CONFIG_IMPORT_TOO_MANY_PROVIDERS',
  CONFIG_IMPORT_BAD_PROVIDER_ENTRY = 'CONFIG_IMPORT_BAD_PROVIDER_ENTRY',
  /** params.key */
  CONFIG_IMPORT_UNKNOWN_PROVIDER_KEY = 'CONFIG_IMPORT_UNKNOWN_PROVIDER_KEY',
  /** params.field */
  CONFIG_IMPORT_BAD_PROVIDER_FIELD = 'CONFIG_IMPORT_BAD_PROVIDER_FIELD',
  CONFIG_IMPORT_BAD_PROVIDER_ID = 'CONFIG_IMPORT_BAD_PROVIDER_ID',
  CONFIG_IMPORT_BAD_PROVIDER_NAME = 'CONFIG_IMPORT_BAD_PROVIDER_NAME',
  /** params.field */
  CONFIG_IMPORT_BAD_PROVIDER_URL = 'CONFIG_IMPORT_BAD_PROVIDER_URL',
  /** params.field */
  CONFIG_IMPORT_PROVIDER_TOO_LONG = 'CONFIG_IMPORT_PROVIDER_TOO_LONG',
  /** params.id */
  CONFIG_IMPORT_DUPLICATE_PROVIDER_ID = 'CONFIG_IMPORT_DUPLICATE_PROVIDER_ID',
}

/** 每码元数据：默认 HTTP status + i18n 模板参数名（全有或全无） */
export interface ErrMeta {
  status: number
  params?: readonly string[]
}

export const ERR_REGISTRY: Readonly<Record<ErrCode, ErrMeta>> = {
  // COMMON
  [ErrCode.INTERNAL]: { status: 500 },
  [ErrCode.NOT_FOUND]: { status: 404 },

  // AUTH
  [ErrCode.UNAUTHORIZED]: { status: 401 },
  [ErrCode.AUTH_INVALID_TOKEN]: { status: 401 },
  [ErrCode.AUTH_FORBIDDEN]: { status: 403 },
  [ErrCode.AUTH_INVALID_PIN]: { status: 401 },
  [ErrCode.AUTH_INVALID_CURRENT_PIN]: { status: 401 },

  // USER
  [ErrCode.USER_NAME_REQUIRED]: { status: 400 },
  [ErrCode.USER_RATE_LIMITED]: { status: 429, params: ['seconds'] },
  [ErrCode.USER_PIN_FORMAT]: { status: 400 },
  [ErrCode.USER_PIN_NOT_SET]: { status: 404 },
  [ErrCode.USER_DISABLED]: { status: 403 },
  [ErrCode.USER_REGISTRATION_CLOSED]: { status: 403 },
  [ErrCode.USER_PIN_ALREADY_SET]: { status: 409 },
  [ErrCode.USER_NAME_TAKEN]: { status: 409 },
  [ErrCode.USER_RENAME_REQUIRED]: { status: 400 },
  [ErrCode.USER_RENAME_SAME]: { status: 400 },
  [ErrCode.USER_BINDING_NOT_FOUND]: { status: 404 },
  [ErrCode.USER_BINDING_NOT_OWNED]: { status: 403 },
  [ErrCode.USER_CANNOT_REMOVE_ONLY_LOGIN]: { status: 400 },

  // OAUTH
  [ErrCode.OAUTH_UNKNOWN_PROVIDER]: { status: 404 },
  [ErrCode.OAUTH_PROVIDER_ERROR]: { status: 400, params: ['detail'] },
  [ErrCode.OAUTH_INVALID_STATE]: { status: 400 },
  [ErrCode.OAUTH_NO_AUTH_CODE]: { status: 400 },
  [ErrCode.OAUTH_TOKEN_EXCHANGE_FAILED]: { status: 502, params: ['detail'] },
  [ErrCode.OAUTH_LINKED_USER_NOT_FOUND]: { status: 404 },
  [ErrCode.OAUTH_REGISTRATION_CLOSED]: { status: 403 },
  [ErrCode.OAUTH_MISSING_FIELDS]: { status: 400 },
  [ErrCode.OAUTH_ALREADY_LINKED]: { status: 409 },
  [ErrCode.OAUTH_ACCOUNT_NOT_FOUND]: { status: 404 },
  [ErrCode.OAUTH_ACCOUNT_NO_PIN]: { status: 400 },

  // CONV
  [ErrCode.CONV_NOT_FOUND]: { status: 404 },
  [ErrCode.CONV_WORLD_CREATE_ONLY]: { status: 400 },
  [ErrCode.CONV_MERGE_MIN_TWO]: { status: 400 },
  [ErrCode.CONV_MERGE_SOURCE_NOT_FOUND]: { status: 404, params: ['id'] },
  [ErrCode.CONV_MERGE_SOURCE_NOT_GROUP]: { status: 400, params: ['id'] },
  [ErrCode.CONV_MERGE_MIXED_TYPES]: { status: 400 },
  [ErrCode.CONV_MESSAGE_NOT_FOUND]: { status: 404 },

  // CHAT（SSE 流内码为名义 status）
  [ErrCode.CHAT_CONVERSATION_ID_REQUIRED]: { status: 400 },
  [ErrCode.CHAT_CONVERSATION_ACCESS_DENIED]: { status: 404 },
  [ErrCode.CHAT_EMPTY_MESSAGE]: { status: 400 },
  [ErrCode.CHAT_QUESTION_ID_REQUIRED]: { status: 400 },
  [ErrCode.CHAT_QUESTION_EXPIRED]: { status: 410 },
  [ErrCode.CHAT_QUESTION_WRONG_CONVERSATION]: { status: 403 },
  [ErrCode.CHAT_QUESTION_ALREADY_ANSWERED]: { status: 410 },
  [ErrCode.CHAT_WORLD_ONLY]: { status: 400 },
  [ErrCode.CHAT_WORLD_NO_MEMBERS]: { status: 400 },
  [ErrCode.CHAT_INTERNAL_ERROR]: { status: 500 },

  // AI / SSE 上游
  [ErrCode.AI_UPSTREAM_TIMEOUT]: { status: 504 },
  [ErrCode.AI_UPSTREAM_ERROR]: { status: 502, params: ['detail'] },
  [ErrCode.AI_STREAM_CLOSED]: { status: 502 },
  [ErrCode.AI_UPSTREAM_UNREACHABLE]: { status: 502 },

  // ADMIN
  [ErrCode.ADMIN_CONTENT_REQUIRED]: { status: 400 },
  [ErrCode.ADMIN_AGENT_NAME_REQUIRED]: { status: 400 },
  [ErrCode.ADMIN_AGENT_NOT_FOUND]: { status: 404 },
  [ErrCode.ADMIN_NEUTRAL_AGENT_DELETE]: { status: 403 },
  [ErrCode.ADMIN_CANNOT_BAN_SELF]: { status: 403 },
  [ErrCode.ADMIN_CANNOT_DELETE_SELF]: { status: 403 },
  [ErrCode.ADMIN_CANNOT_FORGET_OWN]: { status: 403 },
  [ErrCode.ADMIN_USER_NOT_FOUND]: { status: 404 },
  [ErrCode.ADMIN_SKILL_NO_FILE]: { status: 400 },
  [ErrCode.ADMIN_SKILL_FILE_TOO_LARGE]: { status: 400, params: ['limit'] },
  [ErrCode.ADMIN_SKILL_ZIP_TRAVERSAL]: { status: 400 },
  [ErrCode.ADMIN_SKILL_NO_SKILL_MD]: { status: 400 },
  [ErrCode.ADMIN_SKILL_NO_FRONTMATTER]: { status: 400 },
  [ErrCode.ADMIN_SKILL_NAME_REQUIRED]: { status: 400 },
  [ErrCode.ADMIN_SKILL_NOT_FOUND]: { status: 404, params: ['name'] },
  [ErrCode.ADMIN_MCP_FIELDS_REQUIRED]: { status: 400 },
  [ErrCode.ADMIN_MCP_NOT_FOUND]: { status: 404 },
  [ErrCode.ADMIN_VOICE_NO_FILE]: { status: 400 },
  [ErrCode.ADMIN_VOICE_FILE_TOO_LARGE]: { status: 400, params: ['limit'] },
  [ErrCode.ADMIN_VOICE_FORMAT_UNSUPPORTED]: { status: 400, params: ['ext', 'allowed'] },
  [ErrCode.ADMIN_VOICE_NO_SAMPLE]: { status: 400 },
  [ErrCode.ADMIN_VOICE_CLONE_FAILED]: { status: 500, params: ['detail'] },

  // UPLOAD
  [ErrCode.UPLOAD_NO_FILE]: { status: 400 },
  [ErrCode.UPLOAD_CONVERSATION_ID_REQUIRED]: { status: 400 },
  [ErrCode.UPLOAD_FILE_TOO_LARGE]: { status: 400, params: ['limit'] },
  [ErrCode.UPLOAD_FAILED]: { status: 500, params: ['detail'] },

  // WORKSPACE
  [ErrCode.WORKSPACE_NOT_FOUND]: { status: 404 },
  [ErrCode.WORKSPACE_INVALID_PATH]: { status: 400 },
  [ErrCode.WORKSPACE_FILE_NOT_FOUND]: { status: 404 },

  // GROUP
  [ErrCode.GROUP_AGENT_ID_REQUIRED]: { status: 400 },
  [ErrCode.GROUP_NEUTRAL_AGENT_FORBIDDEN]: { status: 403 },

  // WORLD
  [ErrCode.WORLD_AGENTS_REQUIRED]: { status: 400 },
  [ErrCode.WORLD_NOTHING_TO_UPDATE]: { status: 400 },
  [ErrCode.WORLD_NOT_FOUND]: { status: 404 },

  // MEMORY
  [ErrCode.MEMORY_AGENT_ID_REQUIRED]: { status: 400 },
  [ErrCode.MEMORY_CONTENT_EMPTY]: { status: 400 },
  [ErrCode.MEMORY_CONTENT_TOO_LONG]: { status: 400, params: ['limit'] },
  [ErrCode.MEMORY_NEUTRAL_AGENT_FORBIDDEN]: { status: 403 },
  [ErrCode.MEMORY_NOT_FOUND]: { status: 404 },

  // VOICE
  [ErrCode.VOICE_PARAMS_REQUIRED]: { status: 400 },

  // DOCS
  [ErrCode.DOCS_INVALID_PATH]: { status: 403 },
  [ErrCode.DOCS_NOT_FOUND]: { status: 404 },

  // ASSET
  [ErrCode.ASSET_FORBIDDEN]: { status: 403 },
  [ErrCode.ASSET_NOT_FOUND]: { status: 404 },

  // PUSH
  [ErrCode.PUSH_FIELDS_REQUIRED]: { status: 400 },

  // PROMPT
  [ErrCode.PROMPT_ID_REQUIRED]: { status: 400 },
  [ErrCode.PROMPT_FRAGMENT_NOT_FOUND]: { status: 404, params: ['id'] },
  [ErrCode.PROMPT_TARGET_REQUIRED]: { status: 400 },

  // WECHAT
  [ErrCode.WECHAT_CONV_NOT_BINDABLE]: { status: 400 },
  [ErrCode.WECHAT_QR_FAILED]: { status: 502, params: ['detail'] },
  [ErrCode.WECHAT_QRCODE_ID_REQUIRED]: { status: 400 },
  [ErrCode.WECHAT_CONV_DELETED]: { status: 400 },

  // QQ
  [ErrCode.QQ_AGENT_ID_REQUIRED]: { status: 400 },
  [ErrCode.QQ_CONV_NOT_BINDABLE]: { status: 400 },
  [ErrCode.QQ_CREDENTIALS_REQUIRED]: { status: 400 },
  [ErrCode.QQ_CREDENTIALS_INVALID]: { status: 400, params: ['detail'] },
  [ErrCode.QQ_MISSING_EXISTING_BINDING]: { status: 400 },
  [ErrCode.QQ_CONV_ID_REQUIRED]: { status: 400 },
  [ErrCode.QQ_CONNECTION_FAILED]: { status: 400, params: ['detail'] },

  // CONFIG_IMPORT（200 内嵌，status 名义值）
  [ErrCode.CONFIG_IMPORT_NOT_MAPPING]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_TOO_LARGE]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_INVALID_YAML]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_UNKNOWN_TOP_KEY]: { status: 400, params: ['key'] },
  [ErrCode.CONFIG_IMPORT_BAD_VERSION]: { status: 400, params: ['version'] },
  [ErrCode.CONFIG_IMPORT_BAD_EXPORTED_AT]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_EMPTY]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_BAD_SECTION]: { status: 400, params: ['section'] },
  [ErrCode.CONFIG_IMPORT_BAD_AGENTS_TYPE]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_UNKNOWN_EXPERIENCE_KEY]: { status: 400, params: ['key'] },
  [ErrCode.CONFIG_IMPORT_BAD_APP_NAME]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_BAD_IMAGE_URL]: { status: 400, params: ['field'] },
  [ErrCode.CONFIG_IMPORT_BAD_BOOLEAN]: { status: 400, params: ['field'] },
  [ErrCode.CONFIG_IMPORT_NOT_ARRAY]: { status: 400, params: ['field'] },
  [ErrCode.CONFIG_IMPORT_TOO_MANY_QUESTIONS]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_TOO_MANY_FOLLOWUPS]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_BAD_QUESTION]: { status: 400, params: ['field'] },
  [ErrCode.CONFIG_IMPORT_UNKNOWN_AGENT_KEY]: { status: 400, params: ['key'] },
  [ErrCode.CONFIG_IMPORT_BAD_ROLE]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_BAD_AGENT_ID]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_NEUTRAL_NAME_IMMUTABLE]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_NEUTRAL_AVATAR_IGNORED]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_AGENT_NAME_REQUIRED]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_BAD_AGENT_NAME]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_BAD_MODEL]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_BAD_SYSTEM_PROMPT]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_DUPLICATE_AGENT_ID]: { status: 400, params: ['id'] },
  [ErrCode.CONFIG_IMPORT_TOO_MANY_AGENTS]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_UNKNOWN_USERS_KEY]: { status: 400, params: ['key'] },
  [ErrCode.CONFIG_IMPORT_TOO_MANY_PROVIDERS]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_BAD_PROVIDER_ENTRY]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_UNKNOWN_PROVIDER_KEY]: { status: 400, params: ['key'] },
  [ErrCode.CONFIG_IMPORT_BAD_PROVIDER_FIELD]: { status: 400, params: ['field'] },
  [ErrCode.CONFIG_IMPORT_BAD_PROVIDER_ID]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_BAD_PROVIDER_NAME]: { status: 400 },
  [ErrCode.CONFIG_IMPORT_BAD_PROVIDER_URL]: { status: 400, params: ['field'] },
  [ErrCode.CONFIG_IMPORT_PROVIDER_TOO_LONG]: { status: 400, params: ['field'] },
  [ErrCode.CONFIG_IMPORT_DUPLICATE_PROVIDER_ID]: { status: 400, params: ['id'] },
}

/** REST 错误响应体（唯一形状；code 放宽为 string 以容忍未知码） */
export interface ErrorEnvelope {
  code: string
  params?: ErrParams
}
