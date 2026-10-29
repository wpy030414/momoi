/**
 * 抖音扫码登录（默认链路）—— 纯 HTTP，不依赖服务器浏览器。
 *
 * 二维码必须是**抖音开放平台授权码**，由抖音 App 扫描。走的是豆包网页端
 * 「抖音一键登录」真正使用的 OAuth 通路（open.douyin.com）：
 *
 *   1) GET open.douyin.com/oauth/get_qrcode/
 *        ?passport_jssdk_version&passport_jssdk_type=pro&aid=1128
 *        &client_key=<抖音应用>&scope=user_info&next=<回调>&state=<base64 JSON>
 *      → { error_code:0, qrcode: "<base64 PNG>", token, qrcode_index_url }
 *      二维码解码为 https://open.douyin.com/platform/oauth/qr_auth/?client_key=…
 *   2) GET open.douyin.com/oauth/check_qrcode/?…&token=<token>
 *      → status: new / scanned / confirmed
 *   3) 确认后抖音回跳 `next`（www.doubao.com/auth/callback?code=…），
 *      服务端跟随该回跳收集豆包会话 Cookie。
 *
 * 注意：不要用 accounts.doubao.com 的 get_qrcode——那是**豆包 App** 的扫码码，
 * 虽然它的 copywriting 文案写着「请使用抖音 APP 扫码验证」，但二维码实际解码
 * 指向 www.doubao.com/flow-account/scan-login，并不是抖音授权码。
 */

import { doubaoConfig as cfg } from './config.js'
import { CookieJar } from './cookie-jar.js'
import { generateDeviceIdentity, type DeviceIdentity } from './device.js'
import { queryDoubaoAccount } from './account.js'
import type { DoubaoSession } from './credentials.js'
import type { LoginFlowDriver, QrCodePayload, QrPollResult } from './login-flow.js'

/** 抖音开放平台授权网关 */
const DOUYIN_OPEN_ORIGIN = 'https://open.douyin.com'

interface ApiEnvelope {
  message?: string
  data?: Record<string, unknown>
}

export interface DouyinLoginOptions {
  device?: DeviceIdentity
  /** 测试注入：替换 fetch */
  fetchImpl?: typeof fetch
  /** 抖音开放平台 client_key / OAuth 回调地址（默认取配置） */
  clientKey?: string
  callbackUrl?: string
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
  private readonly clientKey: string
  private readonly callbackUrl: string
  private readonly state: string
  private jar = new CookieJar()
  private qr: QrCodePayload | null = null
  private session: DoubaoSession | null = null
  private consecutiveErrors = 0

  constructor(opts: DouyinLoginOptions = {}) {
    this.device = opts.device || generateDeviceIdentity()
    this.doFetch = opts.fetchImpl || fetch
    this.clientKey = opts.clientKey || cfg.douyinClientKey
    this.callbackUrl = opts.callbackUrl || cfg.douyinCallbackUrl
    // 抖音要求 state 是 base64(JSON)，含 csrfToken；确认后原样回传
    this.state = Buffer.from(JSON.stringify({
      entry: '',
      trackMeta: {
        login_entrance: 'sign_in',
        is_from_ug: '0',
        is_from_share: '0',
        trigger_platform: 'web',
        trigger_app: 'doubao',
      },
      autoClose: false,
      platform: 'aweme_v2',
      navigatePath: '/chat/?from_login=1',
      type: 'login',
      timestamp: Date.now(),
      csrfToken: globalThis.crypto?.randomUUID?.() ?? String(Date.now()),
    })).toString('base64')
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

  /** 申请抖音授权二维码 */
  async begin(): Promise<QrCodePayload> {
    this.jar = new CookieJar()
    this.qr = null
    this.session = null
    this.consecutiveErrors = 0

    const res = await this.doFetch(`${DOUYIN_OPEN_ORIGIN}/oauth/get_qrcode/?${this.query()}`, {
      method: 'GET',
      headers: this.headers(),
      signal: AbortSignal.timeout(cfg.loginRequestTimeoutMs),
    })
    const json = parseJson(await res.text())
    const data = json?.data ?? {}
    const code = Number(data.error_code ?? -1)
    if (!res.ok || !json || code !== 0) {
      const desc = pickString(data.description, json?.message) || `HTTP ${res.status}`
      throw new Error(`获取抖音授权二维码失败：${desc}`)
    }
    const token = pickString(data.token)
    const raw = pickString(data.qrcode)
    if (!token) throw new Error('获取抖音授权二维码失败：响应缺少 token')
    if (!raw) throw new Error('获取抖音授权二维码失败：响应缺少二维码图片')

    this.qr = {
      token,
      qrDataUrl: raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`,
    }
    return { ...this.qr }
  }

  /** 轮询一次扫码状态 */
  async poll(): Promise<QrPollResult> {
    if (!this.qr) return { status: 'error', message: '二维码尚未获取，请刷新二维码重试' }

    try {
      const query = new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(this.query())), token: this.qr.token })
      const res = await this.doFetch(`${DOUYIN_OPEN_ORIGIN}/oauth/check_qrcode/?${query}`, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(cfg.loginRequestTimeoutMs),
      })
      const json = parseJson(await res.text())
      const data = json?.data ?? {}
      const code = Number(data.error_code ?? -1)

      if (!res.ok || !json || code !== 0) {
        const desc = pickString(data.description, json?.message, `HTTP ${res.status}`)
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
        const session = await this.completeLogin(pickString(data.code))
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

  /**
   * 确认后用抖音 code 换取豆包会话。
   *
   * 关键：抖音只负责授权，豆包还必须用 code 调一次
   *   POST accounts.doubao.com/passport/web/auth/bind_with_mobile_login/
   * 才会下发 sessionid / uid_tt 等会话 Cookie。只跟随 redirect_url（HTML 页面）
   * 拿不到任何会话，表现为「扫码成功但一发消息就 710012001 登录已过期」。
   *
   * 该接口经实测不需要 a_bogus / sign 签名。
   */
  private async completeLogin(code: string): Promise<DoubaoSession> {
    if (!code) throw new Error('抖音授权未返回 code')

    // 确保有 csrf token（bind 接口要求 x-tt-passport-csrf-token 与 Cookie 一致）
    if (!this.jar.get('passport_csrf_token')) {
      const csrfUrl = `${cfg.baseUrl}/passport/safe/csrf_token/?aid=${encodeURIComponent(cfg.aid)}`
      const csrfRes = await this.doFetch(csrfUrl, {
        method: 'GET',
        headers: {
          'User-Agent': cfg.userAgent,
          'Accept': 'application/json, text/plain, */*',
          'x-requested-with': 'XMLHttpRequest',
        },
        signal: AbortSignal.timeout(cfg.loginRequestTimeoutMs),
      })
      this.jar.absorb(csrfRes.headers, csrfUrl)
      await csrfRes.text().catch(() => '')
    }

    const bindUrl =
      `${cfg.authBaseUrl}/passport/web/auth/bind_with_mobile_login/?` +
      new URLSearchParams({
        passport_jssdk_version: '4.4.6',
        passport_jssdk_type: 'normal',
        is_from_ttaccountsdk: '1',
        aid: cfg.aid,
        language: 'zh',
        account_app_language: 'zh-CN',
        ts: String(Math.floor(Date.now() / 1000)),
        multi_login: '1',
        account_sdk_source: 'web',
        device_platform: 'web',
        device_id: '',
        os_type: '1',
        terminal_type: '2',
      }).toString()
    const body = new URLSearchParams({
      code,
      platformAppId: String(cfg.douyinPlatformAppId),
      platform: cfg.douyinPlatform,
      platform_app_id: String(cfg.douyinPlatformAppId),
    }).toString()

    const csrf = this.jar.get('passport_csrf_token') || this.jar.get('passport_csrf_token_default') || ''
    const cookie = this.jar.getCookieHeader(bindUrl)
    const res = await this.doFetch(bindUrl, {
      method: 'POST',
      headers: {
        'User-Agent': cfg.userAgent,
        'Accept': 'application/json, text/plain, */*',
        'Origin': cfg.baseUrl,
        'Referer': `${cfg.baseUrl}/`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-tt-passport-csrf-token': csrf,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body,
      signal: AbortSignal.timeout(cfg.loginRequestTimeoutMs),
    })
    this.jar.absorb(res.headers, bindUrl)
    const json = parseJson(await res.text())
    const data = json?.data ?? {}
    const errorCode = Number(data.error_code ?? 0)
    if (!res.ok || errorCode !== 0) {
      const desc = pickString(data.description, json?.message) || `HTTP ${res.status}`
      throw new Error(`用抖音授权换取豆包会话失败：${desc}`)
    }
    if (!this.jar.get('sessionid')) {
      throw new Error('换取豆包会话后仍未获得 sessionid')
    }

    const account = await queryDoubaoAccount(this.jar, { baseUrl: cfg.baseUrl })
    const uid =
      pickString(data.user_id_str, data.user_id) ||
      account?.uid ||
      this.jar.get('uid_tt') ||
      this.jar.get('uid_tt_ss') ||
      ''
    const nickname = pickString(data.screen_name, data.name) || account?.nickname || ''
    const cookies = this.jar.toJSON()
    if (cookies.length === 0) throw new Error('登录成功但未获得任何 Cookie')

    this.session = { cookies, device: this.getDevice(), uid, nickname, savedAt: Date.now() }
    return this.getSession()!
  }

  /** 纯 HTTP 链路没有浏览器资源需要释放 */
  async close(): Promise<void> {
    /* noop */
  }

  // ---- 请求 ----

  private query(): string {
    return new URLSearchParams({
      passport_jssdk_version: cfg.douyinSdkVersion,
      passport_jssdk_type: 'pro',
      aid: cfg.douyinAid,
      language: 'zh',
      client_key: this.clientKey,
      scope: 'user_info',
      next: this.callbackUrl,
      state: this.state,
    }).toString()
  }

  private headers(): Record<string, string> {
    return {
      'User-Agent': cfg.userAgent,
      'Accept': 'application/json',
      'Referer': `${DOUYIN_OPEN_ORIGIN}/`,
    }
  }

  /** 手写重定向跟随：每一跳都吸收 Set-Cookie */
  private async follow(url: string, maxHops = 10): Promise<Response> {
    let current = url
    for (let hop = 0; hop <= maxHops; hop++) {
      const headers: Record<string, string> = { 'User-Agent': cfg.userAgent }
      const cookie = this.jar.getCookieHeader(current)
      if (cookie) headers.Cookie = cookie
      const res = await this.doFetch(current, {
        method: 'GET',
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