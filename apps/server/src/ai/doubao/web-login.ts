/**
 * 豆包自助扫码登录（应急旁路，`DOUBAO_LOGIN_FLOW=doubao` 时启用）。
 *
 * 注意：这条链路展示的是**豆包 App 的扫码登录码**，不是抖音授权码；
 * 默认链路见 douyin-login.ts（抖音官方授权页）。
 *
 * 纯 HTTP，不依赖 Playwright / 豆包电脑版：
 *   1) GET  /                                  收集 ttwid 等基础 Cookie
 *   2) GET  /passport/safe/csrf_token/?aid=... 取 passport_csrf_token
 *   3) GET  /passport/web/get_qrcode/?next=... 取二维码 PNG + 一次性 token
 *   4) GET  /passport/web/check_qrconnect/     轮询 new → scanned → confirmed
 *   5) 跟随 redirect_url，收集 sessionid 等会话 Cookie
 *   6) GET  /passport/account/info/v2/         尽力取 uid / nickname（失败不阻断）
 *
 * 二维码由管理端直接展示，管理员用手机端豆包 / 抖音扫码确认；服务端不经手口令。
 */

import { doubaoConfig as cfg } from './config.js'
import { CookieJar } from './cookie-jar.js'
import { generateDeviceIdentity, type DeviceIdentity } from './device.js'
import { loginHeaders, toQuery } from './security-params.js'
import { queryDoubaoAccount } from './account.js'
import type { DoubaoSession } from './credentials.js'
import type { LoginFlowDriver, QrCodePayload, QrPollResult } from './login-flow.js'

export interface WebLoginOptions {
  baseUrl?: string
  authBaseUrl?: string
  aid?: string
  device?: DeviceIdentity
}

interface ApiEnvelope {
  message?: string
  data?: Record<string, unknown>
  error_code?: number
  description?: string
}

function parseJson(text: string): ApiEnvelope | null {
  try {
    return JSON.parse(text) as ApiEnvelope
  } catch {
    return null
  }
}

function pickString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return String(v)
  }
  return ''
}

export class DoubaoWebLogin implements LoginFlowDriver {
  readonly kind = 'doubao' as const
  readonly baseUrl: string
  readonly authBaseUrl: string
  readonly aid: string

  private jar = new CookieJar()
  private device: DeviceIdentity
  private qr: QrCodePayload | null = null
  private session: DoubaoSession | null = null
  private consecutiveErrors = 0

  constructor(opts: WebLoginOptions = {}) {
    this.baseUrl = (opts.baseUrl || cfg.baseUrl).replace(/\/+$/, '')
    this.authBaseUrl = (opts.authBaseUrl || cfg.authBaseUrl).replace(/\/+$/, '')
    this.aid = opts.aid || cfg.aid
    this.device = opts.device || generateDeviceIdentity()
  }

  getDevice(): DeviceIdentity {
    return { ...this.device }
  }

  getSession(): DoubaoSession | null {
    return this.session ? { ...this.session, cookies: this.session.cookies.map((c) => ({ ...c })) } : null
  }

  getQr(): QrCodePayload | null {
    return this.qr ? { ...this.qr } : null
  }

  /** 申请二维码（重置 Cookie 罐与会话） */
  async begin(): Promise<QrCodePayload> {
    this.jar = new CookieJar()
    this.qr = null
    this.session = null
    this.consecutiveErrors = 0

    // 1) 首页：拿 ttwid 等基础 Cookie（首页可能 302 到 /chat/）
    const home = await this.fetchFollowing(`${this.authBaseUrl}${cfg.homePath}`, {
      method: 'GET',
      headers: this.loginHeaders(),
    }).catch(() => null)
    await home?.body?.cancel().catch(() => {})

    // 2) CSRF
    let csrf = this.jar.get('passport_csrf_token') || this.jar.get('passport_csrf_token_default') || ''
    if (!csrf) {
      const csrfUrl = `${this.authBaseUrl}${cfg.csrfPath}?aid=${encodeURIComponent(this.aid)}`
      const res = await this.fetchFollowing(csrfUrl, { method: 'GET', headers: this.loginHeaders() })
      const json = parseJson(await res.text())
      csrf =
        pickString(json?.data?.passport_csrf_token, json?.data?.csrf_token) ||
        this.jar.get('passport_csrf_token') ||
        this.jar.get('passport_csrf_token_default') ||
        ''
    }

    // 3) 二维码
    const qrUrl = `${this.authBaseUrl}${cfg.qrPath}?` + toQuery({ next: this.baseUrl, aid: this.aid })
    const res = await this.fetchFollowing(qrUrl, { method: 'GET', headers: this.loginHeaders(csrf) })
    const json = parseJson(await res.text())
    const data = json?.data ?? {}
    const code = Number(data.error_code ?? json?.error_code ?? -1)
    if (!res.ok || !json || json.message !== 'success' || code !== 0) {
      const desc = pickString(data.description, json?.description, json?.message) || `HTTP ${res.status}`
      throw new Error(`获取二维码失败：${desc}`)
    }
    const token = pickString(data.token)
    if (!token) throw new Error('获取二维码失败：响应缺少 token')

    let qrBase64 = ''
    const qrRaw = pickString(data.qrcode, data.qrcode_url)
    if (qrRaw) {
      if (qrRaw.startsWith('data:')) {
        qrBase64 = qrRaw.slice(qrRaw.indexOf(',') + 1)
      } else if (/^https?:\/\//i.test(qrRaw)) {
        const img = await this.fetchFollowing(qrRaw, { method: 'GET', headers: { 'User-Agent': cfg.userAgent } })
        qrBase64 = Buffer.from(await img.arrayBuffer()).toString('base64')
      } else {
        qrBase64 = qrRaw
      }
    } else if (pickString(data.qrcode_index_url)) {
      const img = await this.fetchFollowing(pickString(data.qrcode_index_url), {
        method: 'GET',
        headers: { 'User-Agent': cfg.userAgent },
      })
      qrBase64 = Buffer.from(await img.arrayBuffer()).toString('base64')
    }
    if (!qrBase64) throw new Error('获取二维码失败：响应缺少二维码图片')

    const expireSeconds = Number(data.expire_time)
    const expireAt = Number.isFinite(expireSeconds) && expireSeconds > 0 ? expireSeconds * 1000 : Date.now() + 120_000
    this.qr = { token, qrDataUrl: `data:image/png;base64,${qrBase64}`, expireAt }
    return { ...this.qr }
  }

  /** 轮询一次扫码状态；可在超时前重复调用 */
  async poll(): Promise<QrPollResult> {
    if (!this.qr) return { status: 'error', message: '二维码尚未获取，请刷新二维码重试' }
    try {
      const url =
        `${this.authBaseUrl}${cfg.qrCheckPath}?` +
        toQuery({ next: this.baseUrl, token: this.qr.token, aid: this.aid })
      const res = await this.fetchFollowing(url, { method: 'GET', headers: this.loginHeaders() })
      const json = parseJson(await res.text())
      const data = json?.data ?? {}
      const code = Number(data.error_code ?? json?.error_code ?? -1)

      if (!res.ok || !json || json.message !== 'success' || code !== 0) {
        const desc = pickString(data.description, json?.description, json?.message, `HTTP ${res.status}`)
        if (/expired|expire|过期|失效/i.test(desc)) {
          return { status: 'expired', message: '二维码已过期，请刷新' }
        }
        this.consecutiveErrors += 1
        if (this.consecutiveErrors >= 5) {
          return { status: 'error', message: `登录状态检查失败：${desc}，请刷新二维码重试` }
        }
        return { status: 'new', message: `等待中（${desc}）` }
      }

      this.consecutiveErrors = 0
      const status = String(data.status || '').toLowerCase()
      if (status === 'new') return { status: 'new', message: '等待扫码' }
      if (status === 'scanned') return { status: 'scanned', message: '已扫码，请在手机上确认登录' }
      if (status === 'confirmed' || status === 'login') {
        const session = await this.completeLogin(pickString(data.redirect_url, data.redirectUrl))
        return { status: 'confirmed', message: '登录成功', session }
      }
      if (status === 'expired') return { status: 'expired', message: '二维码已过期，请刷新' }
      if (status === 'refused') return { status: 'refused', message: '扫码已被拒绝，请刷新二维码重试' }
      return { status: 'new', message: `等待中（${status || '未知状态'}）` }
    } catch (err) {
      this.consecutiveErrors += 1
      const message = err instanceof Error ? err.message : String(err)
      if (this.consecutiveErrors >= 5) {
        return { status: 'error', message: `登录轮询失败：${message}，请刷新二维码重试` }
      }
      return { status: 'new', message: '网络波动，继续等待…' }
    }
  }

  /** 确认后：跟随回跳、收集 Cookie、尽力取账号信息 */
  private async completeLogin(redirectUrl: string): Promise<DoubaoSession> {
    if (redirectUrl) {
      try {
        const followed = await this.fetchFollowing(redirectUrl, { method: 'GET', headers: this.loginHeaders() })
        await followed.body?.cancel().catch(() => {})
      } catch {
        /* 回跳失败不阻断：Cookie 可能已在轮询响应中下发 */
      }
    }

    const account = await queryDoubaoAccount(this.jar, { baseUrl: this.baseUrl })
    const uid = account?.uid || this.jar.get('uid_tt') || this.jar.get('uid_tt_ss') || ''
    const nickname = account?.nickname || ''
    const cookies = this.jar.toJSON()
    if (cookies.length === 0) throw new Error('登录成功但未获得任何 Cookie')

    this.session = {
      cookies,
      device: this.getDevice(),
      uid,
      nickname,
      savedAt: Date.now(),
    }
    return this.getSession()!
  }

  /** 纯 HTTP 链路没有浏览器资源需要释放 */
  async close(): Promise<void> {
    /* noop */
  }

  private loginHeaders(csrf?: string): Record<string, string> {
    return loginHeaders(this.jar, csrf)
  }

  /** 手写重定向跟随：每一跳都吸收 Set-Cookie */
  private async fetchFollowing(
    url: string,
    init: { method?: string; headers?: Record<string, string> },
    maxHops = 10,
  ): Promise<Response> {
    let current = /^https?:\/\//i.test(url) ? url : new URL(url, `${this.authBaseUrl}/`).toString()
    for (let hop = 0; hop <= maxHops; hop++) {
      const cookie = this.jar.getCookieHeader(current)
      const headers: Record<string, string> = { ...(init.headers || {}) }
      if (cookie) headers.Cookie = cookie
      const res = await fetch(current, {
        method: init.method || 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      })
      this.jar.absorb(res.headers, current)
      const location = res.headers.get('location')
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop === maxHops) throw new Error('登录回跳次数过多')
        current = new URL(location, current).toString()
        continue
      }
      return res
    }
    throw new Error('登录回跳次数过多')
  }
}
