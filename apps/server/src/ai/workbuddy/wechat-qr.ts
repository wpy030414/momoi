/**
 * WorkBuddy 登录页的微信二维码 —— 纯 HTTP 链路（不依赖服务器浏览器）。
 *
 * 已对线上逐跳验证，完整流程：
 *
 *   A) 建 Keycloak 会话（apisix 专用 redirect_uri）
 *      GET /auth/realms/<realm>/protocol/openid-connect/auth
 *          ?client_id=console&response_type=code&scope=openid offline_access
 *          &state=<32位hex>&redirect_uri=<平台>/console/accounts/.apisix/redirect
 *
 *   B) 取微信授权地址
 *      GET /auth/realms/<realm>/console/auth/wechat-url?client_id=login&...
 *          &redirect_uri=<同一个 .apisix/redirect>
 *      → { url: "https://open.weixin.qq.com/connect/qrconnect?..." }
 *      注意：wechat-url 依赖 A 步下发的 AUTH_SESSION_ID / KC_RESTART，缺了会 502。
 *
 *   C) 二维码：从 qrconnect 页面提取 uuid，再下载 /connect/qrcode/<uuid>
 *      扫码状态：/connect/l/qrconnect?uuid=… → 408 未扫 / 404 已扫 / 405 已确认
 *
 *   D) 微信确认后带 code 回跳 broker，跟随 Keycloak 重定向链，直到落回
 *      `/console/accounts/.apisix/redirect?...&code=…`
 *      **该响应会下发 session 与 session_2** —— 这是换取平台 token 的唯一凭据。
 *
 *   E) 拿到 session_2 后必须**立即**调 POST /console/login/enterprise?state=<A 步的 state>
 *      换出 accessToken。若继续跟随到 /console/accounts，平台会把 session/session_2 清空。
 *
 * 安全约束：二维码只接受 open.weixin.qq.com 下的图片与轮询地址。
 */

import { randomBytes } from 'node:crypto'
import { workbuddyConfig as cfg } from './config.js'

/** 微信开放平台二维码资源的固定来源（任何其它域名都拒绝请求） */
const WECHAT_OPEN_ORIGIN = 'https://open.weixin.qq.com'
const WECHAT_LP_ORIGIN = 'https://lp.open.weixin.qq.com'

const QR_IMAGE_PATH = '/connect/qrcode/'
const QR_POLL_PATH = '/connect/l/qrconnect'

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36'

/** 扫码状态：new = 等待扫码；scanned = 已扫码待确认；confirmed = 已确认 */
export type WechatScanStatus = 'new' | 'scanned' | 'confirmed'

export interface IssuedToken {
  accessToken: string
  refreshToken: string
}

export interface WechatQrSession {
  /** 当前二维码 data URL */
  getQr(): string | null
  /** 最近一次已知的扫码状态 */
  getStatus(): WechatScanStatus
  /** 推进一次扫码状态轮询（网络抖动时保持上一次状态） */
  pollScan(): Promise<WechatScanStatus>
  /** 二维码失效（402），需要重新申请 */
  isExpired(): boolean
  /**
   * 扫码确认后完成回跳并换取 token。
   * 成功返回 accessToken；失败返回 detail 供日志排查。
   */
  completeLogin(): Promise<{ ok: true; token: IssuedToken } | { ok: false; detail: string }>
  /** 释放资源（纯 HTTP 链路无浏览器，保留接口以兼容调用方） */
  close(): Promise<void>
}

export interface WechatQrOptions {
  /** 单次请求超时（默认 WORKBUDDY_QR_WAIT_MS） */
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
      const name = first.slice(0, eq).trim()
      const value = first.slice(eq + 1).trim()
      // 空值表示服务端删除该 Cookie
      if (value) this.store.set(name, value)
      else this.store.delete(name)
    }
  }

  get(name: string): string | undefined {
    return this.store.get(name)
  }

  has(name: string): boolean {
    return this.store.has(name)
  }

  header(): string {
    return [...this.store].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  names(): string[] {
    return [...this.store.keys()]
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
  const match = html.match(/\/connect\/qrcode\/([A-Za-z0-9_-]{8,})/)
  return match ? match[1] : ''
}

/** 解析轮询响应：window.wx_errcode=408;window.wx_code=''; */
function parsePoll(body: string): { code: number; scan?: WechatScanStatus; wxCode?: string } {
  const m = /wx_errcode\s*=\s*(\d+)/.exec(body)
  const code = m ? Number(m[1]) : -1
  if (code === 408) return { code, scan: 'new' }
  if (code === 404) return { code, scan: 'scanned' }
  if (code === 405) {
    const c = /wx_code\s*=\s*'([^']*)'/.exec(body)
    return { code, scan: 'confirmed', wxCode: c ? c[1] : '' }
  }
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

  const authRoot = `${cfg.authBaseUrl}/auth/realms/${cfg.realm}`
  const apisixRedirect = `${cfg.authBaseUrl}/console/accounts/.apisix/redirect`
  // 平台换票用的 state：32 位十六进制（与浏览器行为一致）
  const platformState = randomBytes(16).toString('hex')

  // A) 建立 Keycloak 会话（apisix 专用 redirect_uri）
  const authEndpoint =
    `${authRoot}/protocol/openid-connect/auth?` +
    new URLSearchParams({
      response_type: 'code',
      scope: 'openid offline_access',
      client_id: cfg.consoleClientId,
      state: platformState,
      redirect_uri: apisixRedirect,
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

  // B) 取微信授权地址
  const wechatUrlEndpoint =
    `${authRoot}/console/auth/wechat-url?` +
    new URLSearchParams({
      client_id: cfg.wechatClientId,
      response_type: 'code',
      self_redirect: 'true',
      kc_idp_hint: cfg.wechatIdpHint,
      prompt: 'login',
      redirect_uri: apisixRedirect,
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

  // C) 打开 qrconnect 页面拿 uuid
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

  // 下载二维码图片
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

  /** 手写重定向跟随：每一跳都吸收 Set-Cookie，onHop 返回 true 时提前结束 */
  const follow = async (
    url: string,
    maxHops = 15,
    onHop?: (next: string) => boolean,
  ): Promise<void> => {
    let current = url
    for (let hop = 0; hop <= maxHops; hop++) {
      const res = await doFetch(current, {
        headers: {
          'User-Agent': DEFAULT_UA,
          'Accept': 'text/html,application/xhtml+xml',
          'Cookie': jar.header(),
        },
        redirect: 'manual',
        signal: signal(),
      })
      jar.absorb(res)
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop === maxHops) throw new Error('登录回跳次数过多')
        current = new URL(location, current).toString()
        await res.body?.cancel().catch(() => {})
        if (onHop?.(current)) return
        continue
      }
      await res.body?.cancel().catch(() => {})
      return
    }
    throw new Error('登录回跳次数过多')
  }

  let status: WechatScanStatus = 'new'
  let expired = false
  let wxCode = ''
  const pollUrl = `${WECHAT_LP_ORIGIN}${QR_POLL_PATH}?uuid=${encodeURIComponent(uuid)}`
  const brokerEndpoint = qrconnect.searchParams.get('redirect_uri') || ''
  const wechatState = qrconnect.searchParams.get('state') || ''

  return {
    getQr: () => qrDataUrl || null,
    getStatus: () => status,
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
        else if (parsed.scan) {
          status = parsed.scan
          if (parsed.wxCode) wxCode = parsed.wxCode
        }
      } catch (err) {
        console.warn(`[workbuddy] 微信扫码状态轮询失败：${errMessage(err)}`)
      }
      return status
    },
    async completeLogin(): Promise<{ ok: true; token: IssuedToken } | { ok: false; detail: string }> {
      if (!brokerEndpoint || !wxCode) return { ok: false, detail: '缺少微信 code 或回跳地址' }

      // D) 微信回跳：跟随 Keycloak 重定向链，直到取得 session_2
      const start = `${brokerEndpoint}?` + new URLSearchParams({
        code: wxCode,
        state: wechatState,
        session_state: wechatState,
      }).toString()
      try {
        await follow(start, 15, () => jar.has('session_2'))
      } catch (err) {
        return { ok: false, detail: `微信回跳失败：${errMessage(err)}` }
      }

      if (!jar.has('session_2')) {
        return { ok: false, detail: '回跳未取得平台会话（session_2）' }
      }

      // E) 立即换票（不可继续跟随到 /console/accounts，否则会话会被清空）
      const cookieForConsole = ['_gcl_au', 'session', 'session_2', 'tgw_l7_route']
        .filter((n) => jar.has(n))
        .map((n) => `${n}=${jar.get(n)}`)
        .join('; ')
      try {
        const res = await doFetch(
          `${cfg.authBaseUrl}/console/login/enterprise?state=${encodeURIComponent(platformState)}`,
          {
            method: 'POST',
            headers: {
              'User-Agent': DEFAULT_UA,
              'Accept': '*/*',
              'Origin': cfg.authBaseUrl,
              'Referer': `${cfg.authBaseUrl}/login/?platform=workbuddy&state=${platformState}`,
              'x-product-code': 'workbuddy',
              'x-domain': cfg.domain,
              'Content-Length': '0',
              'Cookie': cookieForConsole,
            },
            signal: signal(),
          },
        )
        const json = (await res.json().catch(() => null)) as
          | { code?: number; msg?: string; data?: Record<string, unknown> }
          | null
        if (!res.ok || !json || json.code !== 0) {
          return { ok: false, detail: `换取 token 失败：HTTP ${res.status} ${json?.msg ?? ''}`.trim() }
        }
        const data = json.data ?? {}
        const accessToken = typeof data.accessToken === 'string' ? data.accessToken : ''
        if (!accessToken) return { ok: false, detail: '换取 token 失败：响应缺少 accessToken' }
        return {
          ok: true,
          token: {
            accessToken,
            refreshToken: typeof data.refreshToken === 'string' ? data.refreshToken : '',
          },
        }
      } catch (err) {
        return { ok: false, detail: `换取 token 失败：${errMessage(err)}` }
      }
    },
    close: async () => {},
  }
}