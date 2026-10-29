/**
 * Doubao（豆包网页）上游的网关常量与模型预设。
 *
 * 协议来自豆包网页端（www.doubao.com）的登录与对话接口，移植自参考实现
 * `xrp-doubao`（协议细节见该项目的 docs/DOUBAO_REVERSE.md 与
 * docs/specs/module-doubao.md）。默认值与网页端保持一致；个别部署可通过
 * 环境变量覆盖（例如豆包升级后需要改 pc_version）。
 */

import type { GatewayModelOption } from '@momoi/shared/types'

function env(key: string, fallback: string): string {
  const v = process.env[key]
  return v !== undefined && v !== '' ? v : fallback
}

function envInt(key: string, fallback: number): number {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]
  if (v === undefined || v === '') return fallback
  return /^(1|true|yes|on)$/i.test(v.trim())
}

export const doubaoConfig = {
  /** 对话 / 账号网关 */
  baseUrl: env('DOUBAO_BASE_URL', 'https://www.doubao.com').replace(/\/+$/, ''),
  /** 登录网关（与对话网关同源） */
  authBaseUrl: env('DOUBAO_AUTH_BASE_URL', env('DOUBAO_BASE_URL', 'https://www.doubao.com')).replace(/\/+$/, ''),
  aid: env('DOUBAO_AID', '497858'),
  desktopAid: env('DOUBAO_DESKTOP_AID', '582478'),
  pcVersion: env('DOUBAO_PC_VERSION', '3.42.5'),
  botId: env('DOUBAO_BOT_ID', '7338286299411103781'),
  userAgent: env(
    'DOUBAO_USER_AGENT',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  ),
  chatMode: (env('DOUBAO_CHAT_MODE', 'auto') as 'auto' | 'chat' | 'samantha'),

  homePath: env('DOUBAO_HOME_PATH', '/'),
  chatPath: env('DOUBAO_CHAT_PATH', '/chat/completion'),
  legacyChatPath: env('DOUBAO_LEGACY_CHAT_PATH', '/samantha/chat/completion'),
  accountPath: env('DOUBAO_ACCOUNT_PATH', '/passport/account/info/v2/'),
  qrPath: env('DOUBAO_QR_PATH', '/passport/web/get_qrcode/'),
  qrCheckPath: env('DOUBAO_QR_CHECK_PATH', '/passport/web/check_qrconnect/'),
  csrfPath: env('DOUBAO_CSRF_PATH', '/passport/safe/csrf_token/'),

  /** 账号 SDK 版本参数（抖音扫码链路的 get_qrcode / check_qrconnect 需要） */
  passportSdkVersion: env('DOUBAO_PASSPORT_SDK_VERSION', '4.4.6'),
  passportPca: env('DOUBAO_PASSPORT_PCA', '4.0.26'),
  /** 登录链路单次请求超时 */
  loginRequestTimeoutMs: envInt('DOUBAO_LOGIN_REQUEST_TIMEOUT_MS', 20_000),

  /** 扫码登录轮询间隔 / 超时 */
  loginPollMs: envInt('DOUBAO_LOGIN_POLL_MS', 1500),
  loginTimeoutMs: envInt('DOUBAO_LOGIN_TIMEOUT_MS', 5 * 60_000),

  // —— 后台凭证巡检（豆包没有 refresh token：只探测有效性并吸收轮换的 Cookie）——
  /** 巡检间隔 */
  keepaliveMs: envInt('DOUBAO_KEEPALIVE_MS', 15 * 60_000),
  /** 单次巡检请求超时 */
  keepaliveTimeoutMs: envInt('DOUBAO_KEEPALIVE_TIMEOUT_MS', 15_000),

  /**
   * 登录链路（抖音授权是唯一的产品语义，见 D73）：
   *   douyin（默认）= 抖音官方授权页，二维码是抖音授权码；
   *   doubao        = 纯 HTTP 豆包自助扫码（豆包 App 码），仅作应急旁路。
   *
   * 两者都不再要求部署机器必须装有浏览器：douyin 链路正在改造为纯 HTTP
   * 复刻（见 douyin-login.ts 的内部实现）。
   */
  loginFlow: (env('DOUBAO_LOGIN_FLOW', 'douyin') === 'doubao' ? 'doubao' : 'douyin') as 'douyin' | 'doubao',
  /** 登录浏览器是否无头（默认 true：二维码回传到管理端展示） */
  loginHeadless: envBool('DOUBAO_LOGIN_HEADLESS', true),
  /** Playwright 浏览器通道：msedge / chrome / chromium；空 = 按平台自动尝试 */
  browserChannel: env('DOUBAO_BROWSER_CHANNEL', ''),
  /** 直接指定浏览器可执行文件（容器 / 自定义 Chromium 部署时使用） */
  browserExecutablePath: env('DOUBAO_BROWSER_EXECUTABLE_PATH', ''),
  /** 追加浏览器启动参数（空格分隔；容器内常需 --no-sandbox） */
  browserArgs: env('DOUBAO_BROWSER_ARGS', ''),
  /** 等待抖音授权页产出二维码的上限 */
  qrWaitMs: envInt('DOUBAO_QR_WAIT_MS', 45_000),

  /** 灾备：无本地凭证时用一段 Cookie 头直接工作（等同账号密码，仅建议临时使用） */
  cookiesEnv: env('DOUBAO_COOKIES', ''),
  uidEnv: env('DOUBAO_UID', ''),
  deviceIdEnv: env('DOUBAO_DEVICE_ID', ''),
  webIdEnv: env('DOUBAO_WEB_ID', ''),
  fpEnv: env('DOUBAO_FP', ''),

  // —— 附件上传（ImageX）——
  uploadEnabled: envBool('DOUBAO_UPLOAD', true),
  maxAttachmentBytes: Math.max(1, envInt('DOUBAO_MAX_ATTACHMENT_MB', 20)) * 1024 * 1024,
  maxAttachments: Math.max(1, envInt('DOUBAO_MAX_ATTACHMENTS', 10)),
  allowPrivateUrls: envBool('DOUBAO_ALLOW_PRIVATE_URLS', false),
  uploadTimeoutMs: Math.max(1000, envInt('DOUBAO_UPLOAD_TIMEOUT_MS', 120_000)),
  prepareUploadPath: env('DOUBAO_PREPARE_UPLOAD_PATH', '/alice/resource/prepare_upload'),
  preHandlePath: env('DOUBAO_PRE_HANDLE_PATH', '/alice/message/pre_handle_v2_without_conv'),
  topPath: env('DOUBAO_TOP_PATH', '/top/v1'),
  uploadTenantId: env('DOUBAO_UPLOAD_TENANT_ID', '5'),
  uploadSceneId: env('DOUBAO_UPLOAD_SCENE_ID', '5'),

  // —— 会话清理（每轮结束后删除豆包侧会话）——
  autoDeleteConversation: envBool('DOUBAO_AUTO_DELETE_CONVERSATION', true),
  cleanupTimeoutMs: Math.max(1000, envInt('DOUBAO_CLEANUP_TIMEOUT_MS', 10_000)),

  // —— 思考展示 ——
  /** cot_ui_style=summary 时上游只下发步骤标题；开启后把标题映射为 thinking 增量 */
  emitThinkingSummary: envBool('DOUBAO_THINKING_SUMMARY', true),

  debug: envBool('DOUBAO_DEBUG', false),
}

/**
 * 豆包网页端的模式菜单（逆向自 /chat 页面 SSR 的 menu_item_list）。
 * model_item_key 是上游真正识别的模型键；mode_id 区分对话（1）与工作任务（3）。
 */
export interface DoubaoModelPreset {
  id: string
  name: string
  /** 网页菜单的 menu_type，同时也是 need_deep_think / ext.use_deep_think 的值 */
  menuType: number
  modelItemKey: string
  modeId: string
  agentMode: number
  reasoningEffort: 3 | 4 | 5
  deepThink: boolean
  /** 网页端 model_config.model_extra_params */
  modelExtraParams?: Record<string, string>
}

export const MODEL_PRESETS: Record<string, DoubaoModelPreset> = {
  'doubao-fast': {
    id: 'doubao-fast',
    name: '豆包 · 快速',
    menuType: 0,
    modelItemKey: '0',
    modeId: '1',
    agentMode: 2,
    reasoningEffort: 3,
    deepThink: false,
  },
  'doubao-expert': {
    id: 'doubao-expert',
    name: '豆包 · 专家',
    menuType: 3,
    modelItemKey: '3',
    modeId: '1',
    agentMode: 2,
    reasoningEffort: 4,
    deepThink: true,
    modelExtraParams: { total_window_size: '256000' },
  },
  'doubao-work': {
    id: 'doubao-work',
    name: '豆包 · 工作任务 Auto',
    menuType: 9,
    modelItemKey: '9',
    modeId: '3',
    agentMode: 1,
    reasoningEffort: 5,
    deepThink: false,
    modelExtraParams: { total_window_size: '256000' },
  },
  'doubao-work-pro': {
    id: 'doubao-work-pro',
    name: '豆包 · 工作任务 Pro',
    menuType: 5,
    modelItemKey: '5',
    modeId: '3',
    agentMode: 1,
    reasoningEffort: 5,
    deepThink: false,
    modelExtraParams: { total_window_size: '256000' },
  },
  'doubao-2.1-lite': {
    id: 'doubao-2.1-lite',
    name: '豆包 2.1 Lite',
    menuType: 10001,
    modelItemKey: 'seed-lite-7b',
    modeId: '3',
    agentMode: 1,
    reasoningEffort: 5,
    deepThink: false,
    modelExtraParams: { memory_profile: '256k', total_window_size: '256000' },
  },
}

/** 面向客户端的短别名 */
export const MODEL_ALIASES: Record<string, string> = {
  doubao: 'doubao-fast',
  'doubao-pro': 'doubao-expert',
  'doubao-think': 'doubao-expert',
}

export const DEFAULT_MODEL = 'doubao-fast'

export function resolveModelPreset(id: string | undefined): DoubaoModelPreset {
  const name = (id || '').trim()
  if (!name) return MODEL_PRESETS[DEFAULT_MODEL]
  if (MODEL_PRESETS[name]) return MODEL_PRESETS[name]
  const alias = MODEL_ALIASES[name]
  if (alias && MODEL_PRESETS[alias]) return MODEL_PRESETS[alias]
  return MODEL_PRESETS[DEFAULT_MODEL]
}

/**
 * 模型下拉选项：豆包网页端没有可编程的目录接口，直接暴露静态预设。
 * 短别名不重复列出——需要别名时在 Agent 表单里选「自定义」手动填写。
 */
export function listDoubaoModels(): GatewayModelOption[] {
  return Object.values(MODEL_PRESETS).map((preset) => ({ id: preset.id, name: preset.name }))
}
