/**
 * 抖音扫码登录（默认链路）—— 纯 HTTP，不依赖服务器浏览器。
 *
 * 产品语义：二维码必须是**抖音官方授权码**，用户用抖音 App 扫。豆包网页端
 * 的「抖音一键登录」会在登录弹窗里拉起账号 SDK 的扫码验证，描述文案为
 * 「为保障账号安全，请使用『抖音 APP』扫码验证」，正是抖音 App 扫码；
 * 二维码由 accounts.doubao.com 直接返回 base64 PNG，不需要浏览器渲染。
 *
 * 链路（全部已在线上实测）：
 *   0) GET /chat/                       收集 ttwid 等基础 Cookie
 *   1) GET /passport/safe/csrf_token/   取 passport_csrf_token
 *   2) GET accounts.doubao.com/passport/web/get_qrcode/
 *        ?next=<站点>&aid=<aid>...       → { token, qrcode: "data:image/png;base64,..." }
 *   3) GET accounts.doubao.com/passport/web/check_qrconnect/
 *        ?next=<站点>&token=<token>&aid=<aid> → status: new / scanned / confirmed
 *
 * 关键约束（缺一律 2035「非法请求」）：请求头必须带
 * `x-tt-passport-csrf-token`，且值等于 Cookie 里的 `passport_csrf_token`。
 * a_bogus / sign / fp / account_sdk_source_info 均已验证**非必需**，故不生成。
 *
 * 扫码确认后：follow redirect_url 收集 sessionid 等会话 Cookie（与豆包自助扫码
 * 链路一致），再查账号信息落库。
 */

import { doubaoConfig as cfg } from './config.js'
import { CookieJar } from './cookie-jar.js'
import { generateDeviceIdentity, type DeviceIdentity } from './device.js'
import { queryDoubaoAccount } from './account.js'
import type { DoubaoSession } from './credentials.js'
import type { LoginFlowDriver, QrCodePayload, QrPollResult } from './login-flow.js'

/** 账号 SDK 网关：二维码与扫码状态都在这里，不在 www.doubao.com */
const ACCOUNT_SDK_ORIGIN = 'https://accounts.doubao.com'

interface ApiEnvelope {
  message?: string
  data?: Record<string, unknown>
}

export interface DouyinLoginOptions {
  device?: DeviceIdentity
  /** 测试注入：替换 fetch */
  fetchImpl?: typeof fetch
}

function pickString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return String(v)
  }
  return ''
}

function parseJson(text: string): ApiEnvelope | null {
  try {
    return JSON.parse(text) as ApiEnvelope
  } catch {
    return null
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class DouyinQrLogin implements LoginFlowDriver {
  readonly kind = 'douyin' as const

  private readonly device: DeviceIdentity
  private readonly doFetch: typeof fetch
  private jar = new CookieJar()
  private qr: QrCodePayload | null = null
  private session: DoubaoSession | null = null
  private consecutiveErrors = 0
  private expired = false

  constructor(opts: DouyinLoginOptions = {}) {
    this.device = opts.device || generateDeviceIdentity()
    this.doFetch = opts.fetchImpl || fetch
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

  /** 申请抖音扫码二维码 */
  async begin(): Promise<QrCodePayload> {
    this.jar = new CookieJar()
    this.qr = null
    this.session = null
    this.consecutiveErrors = 0
    this.expired = false

    // 0) 首页：拿 ttwid（后续 token 与该 Cookie 绑定）
    const home = await this.request(`${cfg.baseUrl}/chat/`, { method: 'GET', headers: this.baseHeaders() }).catch(() => null)
    await home?.body?.cancel().catch(() => {})

    // 1) CSRF：check_qrconnect 的 x-tt-passport-csrf-token 必须与这个 Cookie 一致
    if (!this.jar.get('passport_csrf_token')) {
      const res = await this.request(`${cfg.baseUrl}/passport/safe/csrf_token/?aid=${encodeURIComponent(cfg.aid)}`, {
        method: 'GET',
        headers: this.baseHeaders(),
      })
      const json = parseJson(await res.text())
      const csrf = pickString(json?.data?.passport_csrf_token) || this.jar.get('passport_csrf_token') || ''
      if (!csrf) throw new Error('获取登录 CSRF token 失败')
    }

    // 2) 二维码
    const query = new URLSearchParams({
      next: cfg.baseUrl,
      aid: cfg.aid,
      passport_jssdk_version: cfg.passportSdkVersion,
      passport_jssdk_type: 'normal',
      is_from_ttaccountsdk: '1',
      language: 'zh',
      account_app_language: 'zh-CN',
      p_ca: cfg.passportPca,
      multi_login: '1',
      account_sdk_source: 'web',
    })
    const res = await this.request(`${ACCOUNT_SDK_ORIGIN}/passport/web/get_qrcode/?${query}`, {
      method: 'GET',
      headers: this.apiHeaders(),
    })
    const json = parseJson(await res.text())
    const data = json?.data ?? {}
    const code = Number(data.error_code ?? -1)
    if (!res.ok || !json || json.message !== 'success' || code !== 0) {
      throw new Error(`获取抖音扫码二维码失败：${pickString(data.description, json?.message) || `HTTP ${res.status}`}`)
    }
    const token = pickString(data.token)
    const raw = pickString(data.qrcode)
    if (!token) throw new Error('获取抖音扫码二维码失败：响应缺少 token')
    if (!raw) throw new Error('获取抖音扫码二维码失败：响应缺少二维码图片')

    const expireSeconds = Number(data.expire_time)
    const expireAt = Number.isFinite(expireSeconds) && expireSeconds > 0 ? expireSeconds * 1000 : undefined
    this.qr = { token, qrDataUrl: raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`, expireAt }
    return { ...this.qr }
  }

  /** 轮询一次扫码状态 */
  async poll(): Promise<QrPollResult> {
    if (!this.qr) return { status: 'error', message: '二维码尚未获取，请刷新二维码重试' }

    try {
      const query = new URLSearchParams({ next: cfg.baseUrl, token: this.qr.token, aid: cfg.aid })
      const res = await this.request(`${ACCOUNT_SDK_ORIGIN}/passport/web/check_qrconnect/?${query}`, {
        method: 'GET',
        headers: this.apiHeaders(),
      })
      const json = parseJson(await res.text())
      const data = json?.data ?? {}
      const code = Number(data.error_code ?? -1)

      if (!res.ok || !json || json.message !== 'success' || code !== 0) {
        const desc = pickString(data.description, json?.message, `HTTP ${res.status}`)
        if (code === 2035) {
          // 非法请求：通常是 CSRF / 会话失配，重新申请二维码即可恢复
          return { status: 'error', message: `登录状态校验失败（${desc}），请刷新二维码重试` }
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
      const message = errMessage(err)
      if (this.consecutiveErrors >= 5) {
        return { status: 'error', message: `登录轮询失败：${message}，请刷新二维码重试` }
      }
      return { status: 'new', message: '网络波动，继续等待…' }
    }
  }

  /** 确认后：跟随回跳收集会话 Cookie（与豆包自助扫码链路一致） */
  private async completeLogin(redirectUrl: string): Promise<DoubaoSession> {
    if (redirectUrl) {
      try {
        const followed = await this.request(redirectUrl, { method: 'GET', headers: this.baseHeaders() })
        await followed.body?.cancel().catch(() => {})
      } catch {
        /* 回跳失败不阻断：Cookie 可能已在轮询响应中下发 */
      }
    }

    const account = await queryDoubaoAccount(this.jar, { baseUrl: cfg.baseUrl })
    const uid = account?.uid || this.jar.get('uid_tt') || this.jar.get('uid_tt_ss') || ''
    const cookies = this.jar.toJSON()
    if (cookies.length === 0) throw new Error('登录成功但未获得任何 Cookie')

    this.session = { cookies, device: this.getDevice(), uid, nickname: account?.nickname || '', savedAt: Date.now() }
    return this.getSession()!
  }

  /** 纯 HTTP 链路没有浏览器资源需要释放 */
  async close(): Promise<void> {
    /* noop */
  }

  // ---- 请求 ----

  private baseHeaders(): Record<string, string> {
    return {
      'User-Agent': cfg.userAgent,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': `${cfg.baseUrl}/`,
      'Origin': cfg.baseUrl,
      'Cookie': this.jar.getCookieHeader(`${cfg.baseUrl}/`),
    }
  }

  /** accounts.doubao.com 的 JSON 接口头：必须带与 Cookie 一致的 csrf token */
  private apiHeaders(): Record<string, string> {
    const csrf = this.jar.get('passport_csrf_token') || this.jar.get('passport_csrf_token_default') || ''
    return {
      'User-Agent': cfg.userAgent,
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': `${cfg.baseUrl}/`,
      'Origin': cfg.baseUrl,
      'content-type': 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      'x-tt-passport-csrf-token': csrf,
      'Cookie': this.jar.getCookieHeader(`${cfg.baseUrl}/`),
    }
  }

  /** 手写重定向跟随：每一跳都吸收 Set-Cookie */
  private async request(
    url: string,
    init: { method?: string; headers?: Record<string, string> },
    maxHops = 10,
  ): Promise<Response> {
    let current = /^https?:\/\//i.test(url) ? url : new URL(url, `${cfg.baseUrl}/`).toString()
    for (let hop = 0; hop <= maxHops; hop++) {
      const headers: Record<string, string> = { ...(init.headers || {}) }
      const cookie = this.jar.getCookieHeader(current)
      if (cookie) headers.Cookie = cookie
      const res = await this.doFetch(current, {
        method: init.method || 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(cfg.loginRequestTimeoutMs),
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