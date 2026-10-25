/**
 * Doubao（豆包网页）上游的网关常量与模型预设。
 *
 * 协议来自豆包网页端（www.doubao.com）的登录与对话接口，移植自参考实现
 * `xrp-doubao`（协议细节见该项目的 docs/DOUBAO_REVERSE.md 与
 * docs/specs/module-doubao.md）。默认值与网页端保持一致；个别部署可通过
 * 环境变量覆盖（例如豆包升级后需要改 pc_version）。
 */

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

  /** 扫码登录轮询间隔 / 超时 */
  loginPollMs: envInt('DOUBAO_LOGIN_POLL_MS', 1500),
  loginTimeoutMs: envInt('DOUBAO_LOGIN_TIMEOUT_MS', 5 * 60_000),

  /**
   * 登录链路：
   *   douyin（默认）= 无头浏览器打开豆包登录弹窗 → 抖音官方授权页，展示抖音授权二维码；
   *   doubao        = 纯 HTTP 豆包自助扫码（无浏览器依赖，作为灾备链路）。
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

  debug: envBool('DOUBAO_DEBUG', false),
}

/**
 * 豆包网页端的模式菜单（逆向自 /chat 页面 SSR 的 menu_item_list）。
 * model_item_key 是上游真正识别的模型键；mode_id 区分对话（1）与工作任务（3）。
 */
export interface DoubaoModelPreset {
  id: string
  name: string
  modelItemKey: string
  modeId: string
  agentMode: number
  reasoningEffort: 3 | 4 | 5
  deepThink: boolean
}

export const MODEL_PRESETS: Record<string, DoubaoModelPreset> = {
  'doubao-fast': {
    id: 'doubao-fast',
    name: '豆包 · 快速',
    modelItemKey: '0',
    modeId: '1',
    agentMode: 2,
    reasoningEffort: 3,
    deepThink: false,
  },
  'doubao-expert': {
    id: 'doubao-expert',
    name: '豆包 · 专家',
    modelItemKey: '3',
    modeId: '1',
    agentMode: 2,
    reasoningEffort: 4,
    deepThink: true,
  },
  'doubao-work': {
    id: 'doubao-work',
    name: '豆包 · 工作任务 Auto',
    modelItemKey: '9',
    modeId: '3',
    agentMode: 1,
    reasoningEffort: 5,
    deepThink: false,
  },
  'doubao-work-pro': {
    id: 'doubao-work-pro',
    name: '豆包 · 工作任务 Pro',
    modelItemKey: '5',
    modeId: '3',
    agentMode: 1,
    reasoningEffort: 5,
    deepThink: false,
  },
  'doubao-2.1-lite': {
    id: 'doubao-2.1-lite',
    name: '豆包 2.1 Lite',
    modelItemKey: 'seed-lite-7b',
    modeId: '3',
    agentMode: 1,
    reasoningEffort: 5,
    deepThink: false,
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
