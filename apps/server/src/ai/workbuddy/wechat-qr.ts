/**
 * WorkBuddy 登录页的微信二维码 —— 纯 HTTP 链路（不依赖本机 / 服务器浏览器）。
 *
 * 早先的实现用 playwright-core 拉起无头浏览器打开登录页、拦截二维码图片；
 * 但服务器上通常没有 Chrome / Edge，playwright-core 也不自带浏览器，部署后
 * 必然拿不到二维码。这里把整条 QR 阶段复刻成纯 HTTP（已对线上接口逐跳验证）：
 *
 *   1) GET /auth/realms/copilot/protocol/openid-connect/auth
 *      先建立 Keycloak 会话。wechat-url 依赖这次响应下发的
 *      `AUTH_SESSION_ID` / `KC_RESTART` Cookie，缺了会 502
 *      「failed to create wechat authorization url」。
 *   2) GET /auth/realms/copilot/console/auth/wechat-url
 *        ?client_id=login&response_type=code&self_redirect=true
 *        &kc_idp_hint=weixinwebchat&prompt=login&redirect_uri=<登录页>
 *      → { url: "https://open.weixin.qq.com/connect/qrconnect?..." }
 *   3) GET 该 qrconnect 页面 → 从中提取 uuid
 *   4) GET https://open.weixin.qq.com/connect/qrcode/<uuid> → 二维码 JPEG
 *   5) GET https://lp.open.weixin.qq.com/connect/l/qrconnect?uuid=<uuid>
 *      长轮询扫码状态：408 未扫码 / 404 已扫码待确认 / 405 已确认
 *      402 二维码失效 → 需要重新取
 *
 * 安全约束：redirect_uri 直接来自服务端握手拿到的 authUrl，而二维码内容是
 * open.weixin.qq.com 返回的图片。这里**只接受** `https://open.weixin.qq.com/`
 * 下的图片与轮询地址，防止上游响应被替换成任意 URL 后把二维码指向别处。
 *
 * 扫码确认后（405）由 token-manager 继续轮询平台换票；本模块不参与换票。
 */

import { workbuddyConfig as cfg } from './config.js'

/** 微信开放平台二维码资源的固定来源（任何其它域名都拒绝请求） */
const WECHAT_OPEN_ORIGIN = 'https://open.weixin.qq.com'
const WECHAT_LP_ORIGIN = 'https://lp.open.weixin.qq.com'

const QR_IMAGE_PATH = '/connect/qrcode/'
const QR_POLL_PATH = '/connect/l/qrconnect'
const QRCONNECT_PATH = '/connect/qrconnect'

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

/** 扫码状态：new = 等待扫码；scanned = 已扫码待确认；confirmed = 已确认 */
export type WechatScanStatus = 'new' | 'scanned' | 'confirmed'

export interface WechatQrSession {
  /** 当前二维码 data URL */
  getQr(): string | null
  /** 最近一次已知的扫码状态：new / scanned / confirmed */
  getStatus(): WechatScanStatus
  /** 推进一次扫码状态轮询（网络抖动时保持上一次状态） */
  pollScan(): Promise<WechatScanStatus>
  /** 下载二维码时使用的真实链接（open.weixin.qq.com/connect/qrcode/<uuid>） */
  getQrSourceUrl(): string | null
  /** 二维码失效（402），需要重新申请 */
  isExpired(): boolean
  /** 释放资源（纯 HTTP 链路无浏览器，保留接口以兼容调用方） */
  close(): Promise<void>
}

export interface WechatQrOptions {
  /** 请求超时（默认 WORKBUDDY_QR_WAIT_MS） */
  timeoutMs?: number
  /** 测试注入：替换 fetch */
  fetchImpl?: typeof fetch
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 极简 Cookie 罐：Keycloak 只在同站内部使用，域名不区分 */
class CookieJar {
  private store = new Map<string, string>()

  absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const first = raw.split(';')[0]
      const eq = first.indexOf('=')
      if (eq <= 0) continue
      this.store.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim())
    }
  }

  header(): string {
    return [...this.store].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

/** 只允许访问微信开放平台的 HTTPS 地址 */
function assertWechatUrl(raw: string, allowedOrigin: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`微信二维码地址非法：${raw.slice(0, 120)}`)
  }
  if (url.protocol !== 'https:' || url.origin !== allowedOrigin) {
    throw new Error(`微信二维码地址不在允许的来源内：${url.origin}`)
  }
  return url
}

/** 从 qrconnect 页面 HTML 中提取二维码 uuid */
function extractUuid(html: string): string {
  // 页面内出现 /connect/qrcode/<uuid>（jssdk 模式）或 img.src 中的同名片段
  const match = html.match(/\/connect\/qrcode\/([A-Za-z0-9_-]{8,})/)
  return match ? match[1] : ''
}

/** 解析轮询响应：window.wx_errcode=408;window.wx_code=''; */
function parsePoll(body: string): { code: number; scan?: WechatScanStatus } {
  const m = /wx_errcode\s*=\s*(\d+)/.exec(body)
  const code = m ? Number(m[1]) : -1
  if (code === 408) return { code, scan: 'new' }
  if (code === 404) return { code, scan: 'scanned' }
  if (code === 405) return { code, scan: 'confirmed' }
  return { code }
}

/**
 * 打开微信扫码登录：申请二维码并返回可轮询的会话对象。
 * 任何一步失败都抛错——调用方据此回退为「复制登录页链接」。
 */
export async function openWechatQrLogin(authUrl: string, opts: WechatQrOptions = {}): Promise<WechatQrSession> {
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? cfg.qrWaitMs
  const signal = () => AbortSignal.timeout(timeoutMs)
  const jar = new CookieJar()

  // 1) 建立 Keycloak 会话（wechat-url 依赖这次下发的 Cookie）
  const authEndpoint =
    `${cfg.authUrlBase}/realms/${cfg.realm}/protocol/openid-connect/auth?` +
    new URLSearchParams({
      client_id: cfg.consoleClientId,
      response_type: 'code',
      redirect_uri: authUrl,
      scope: 'openid offline_access',
    }).toString()
  try {
    const res = await doFetch(authEndpoint, {
      headers: { 'User-Agent': DEFAULT_UA },
      redirect: 'manual',
      signal: signal(),
    })
    jar.absorb(res)
    await res.body?.cancel().catch(() => {})
  } catch (err) {
    throw new Error(`建立登录会话失败：${errMessage(err)}`)
  }

  // 2) 取微信授权地址
  const wechatUrlEndpoint =
    `${cfg.authUrlBase}/realms/${cfg.realm}/console/auth/wechat-url?` +
    new URLSearchParams({
      client_id: cfg.wechatClientId,
      response_type: 'code',
      self_redirect: 'true',
      kc_idp_hint: cfg.wechatIdpHint,
      prompt: 'login',
      redirect_uri: authUrl,
    }).toString()
  let qrconnectUrl: string
  try {
    const res = await doFetch(wechatUrlEndpoint, {
      headers: {
        'User-Agent': DEFAULT_UA,
        'Accept': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        'Cookie': jar.header(),
      },
      signal: signal(),
    })
    const json = (await res.json().catch(() => null)) as { url?: string; message?: string } | null
    if (!res.ok || !json?.url) {
      throw new Error(`HTTP ${res.status} ${json?.message ?? '未返回微信授权地址'}`)
    }
    qrconnectUrl = json.url
  } catch (err) {
    throw new Error(`获取微信授权地址失败：${errMessage(err)}`)
  }

  // 3) 打开 qrconnect 页面拿 uuid
  const qrconnect = assertWechatUrl(qrconnectUrl, WECHAT_OPEN_ORIGIN)
  let uuid = ''
  try {
    const res = await doFetch(qrconnect.toString(), {
      headers: { 'User-Agent': DEFAULT_UA },
      signal: signal(),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    uuid = extractUuid(await res.text())
  } catch (err) {
    throw new Error(`获取微信二维码标识失败：${errMessage(err)}`)
  }
  if (!uuid) throw new Error('微信二维码页面未包含二维码标识')

  // 4) 下载二维码图片
  const qrSourceUrl = `${WECHAT_OPEN_ORIGIN}${QR_IMAGE_PATH}${uuid}`
  let qrDataUrl = ''
  try {
    const res = await doFetch(qrSourceUrl, {
      headers: { 'User-Agent': DEFAULT_UA },
      signal: signal(),
    })
    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    if (!res.ok || !contentType.startsWith('image/')) {
      throw new Error(`HTTP ${res.status} ${contentType || '非图片响应'}`)
    }
    const body = Buffer.from(await res.arrayBuffer())
    if (body.length === 0) throw new Error('二维码图片为空')
    const mime = contentType.split(';')[0].trim() || 'image/jpeg'
    qrDataUrl = `data:${mime};base64,${body.toString('base64')}`
  } catch (err) {
    throw new Error(`下载微信二维码失败：${errMessage(err)}`)
  }

  let status: WechatScanStatus = 'new'
  let expired = false
  const pollUrl = `${WECHAT_LP_ORIGIN}${QR_POLL_PATH}?uuid=${encodeURIComponent(uuid)}`

  return {
    getQr: () => qrDataUrl || null,
    getStatus: () => status,
    getQrSourceUrl: () => qrSourceUrl,
    isExpired: () => expired,
    async pollScan(): Promise<WechatScanStatus> {
      if (expired) return status
      try {
        const res = await doFetch(`${pollUrl}&_=${Date.now()}`, {
          headers: { 'User-Agent': DEFAULT_UA, 'Referer': qrconnect.toString() },
          signal: signal(),
        })
        const parsed = parsePoll(await res.text())
        if (parsed.code === 402) expired = true
        else if (parsed.scan) status = parsed.scan
      } catch (err) {
        // 网络抖动不该中断扫码：保持上一次状态，下一轮重试
        console.warn(`[workbuddy] 微信扫码状态轮询失败：${errMessage(err)}`)
      }
      return status
    },
    // 纯 HTTP 链路没有需要释放的资源
    close: async () => {},
  }
}