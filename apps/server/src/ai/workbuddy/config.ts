/**
 * WorkBuddy 上游的网关常量。
 *
 * 协议来自 WorkBuddy/CodeBuddy 桌面客户端的自包含网页登录与推理网关
 * （state 握手 → 浏览器登录 → 轮询换票 → Bearer 调用 copilot.tencent.com）。
 * 默认值与客户端保持一致；个别部署可通过环境变量覆盖（例如客户端升级后
 * 需要改 X-IDE-Version）。
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

export const workbuddyConfig = {
  /** 推理网关：对话 / 模型目录 / token 续期 */
  baseUrl: env('WORKBUDDY_BASE_URL', 'https://copilot.tencent.com').replace(/\/+$/, ''),
  /** 登录网关：state 握手与换票（与推理网关共用同一 state 存储） */
  authBaseUrl: env('WORKBUDDY_AUTH_BASE_URL', 'https://www.workbuddy.cn').replace(/\/+$/, ''),
  domain: env('WORKBUDDY_DOMAIN', 'www.workbuddy.cn'),
  product: env('WORKBUDDY_PRODUCT', 'SaaS'),
  platform: env('WORKBUDDY_PLATFORM', 'workbuddy'),
  /** 桌面客户端身份（网关会校验这组头） */
  ideVersion: env('WORKBUDDY_IDE_VERSION', '5.8.3'),

  chatPath: '/v2/chat/completions',
  /** 云端模型目录：Agent 表单的模型下拉从这里取（随账号套餐变化） */
  modelsPath: env('WORKBUDDY_MODELS_PATH', '/v2/enterprises/personal/models'),
  refreshPath: '/v2/plugin/auth/token/refresh',
  statePath: '/v2/plugin/auth/state',
  tokenPath: '/v2/plugin/auth/token',
  accountPath: '/v2/plugin/account',

  /** 换票轮询中的「登录尚未完成」业务码（HTTP 仍是 200） */
  loginPendingCode: envInt('WORKBUDDY_LOGIN_PENDING_CODE', 11217),
  loginPollMs: envInt('WORKBUDDY_LOGIN_POLL_MS', 1500),
  loginTimeoutMs: envInt('WORKBUDDY_LOGIN_TIMEOUT_MS', 5 * 60_000),

  // —— 登录页微信二维码（纯 HTTP，无需服务器浏览器）——
  /**
   * Keycloak 鉴权根地址。wechat-url 端点需要先建立 Keycloak 会话 Cookie，
   * 否则返回 502「failed to create wechat authorization url」。
   */
  authUrlBase: env('WORKBUDDY_AUTH_URL_BASE', 'https://www.workbuddy.cn/auth').replace(/\/+$/, ''),
  /** Keycloak realm（登录页 /auth/realms/<realm>/...） */
  realm: env('WORKBUDDY_REALM', 'copilot'),
  /** 建立会话所用的 OIDC 客户端 */
  consoleClientId: env('WORKBUDDY_CONSOLE_CLIENT_ID', 'console'),
  /** 申请微信授权地址所用的客户端 */
  wechatClientId: env('WORKBUDDY_WECHAT_CLIENT_ID', 'login'),
  /** 强制走微信扫码身份提供商 */
  wechatIdpHint: env('WORKBUDDY_WECHAT_IDP_HINT', 'weixinwebchat'),
  /** 单次二维码相关请求的超时（建立会话 / 取地址 / 下载图片） */
  qrWaitMs: envInt('WORKBUDDY_QR_WAIT_MS', 30_000),

  /**
   * @deprecated 二维码已改为纯 HTTP 链路，不再启动任何浏览器。
   * 保留这些变量只为兼容旧 .env 文件（读入但不使用）。
   */
  browserChannel: env('WORKBUDDY_BROWSER_CHANNEL', ''),
  browserExecutablePath: env('WORKBUDDY_BROWSER_EXECUTABLE_PATH', ''),
  browserArgs: env('WORKBUDDY_BROWSER_ARGS', ''),
  loginHeadless: envBool('WORKBUDDY_LOGIN_HEADLESS', true),

  /** access token 提前续期窗口 */
  refreshAheadMs: envInt('WORKBUDDY_REFRESH_AHEAD_MS', 5 * 60_000),
  /** 后台轮换巡检间隔 */
  keepAliveMs: envInt('WORKBUDDY_KEEPALIVE_MS', 60_000),
}
