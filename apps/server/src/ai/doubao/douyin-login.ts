/**
 * 抖音 OAuth 授权页登录（默认链路）。
 *
 * 用 Playwright 无头浏览器复刻豆包官方登录链路（移植自 xrp-doubao 的
 * `DouyinOAuthLogin.captureViaLoginModal`，该链路已在参考实现中完成真实账号验证）：
 *
 *   1) 打开 www.doubao.com/chat/ → 点开登录弹窗
 *   2) 点击「抖音一键登录」→ 同意协议 → 浏览器进入 open.douyin.com 官方授权页
 *   3) 授权页自己请求 /oauth/get_qrcode/ —— 拦截该响应，把**抖音授权二维码**
 *      原样下发给管理端展示（二维码解码为 aweme://authorizedy?...，只能由抖音 App 扫）
 *   4) 用户扫码 / 验证码授权后，抖音回跳豆包官方 callback
 *   5) 豆包官方页面自行完成 code 换票并写入 sessionid 等 Cookie
 *   6) 从浏览器上下文提取 Cookie，关闭浏览器
 *
 * 不在 Node 端重放 code：参考实现实测会被豆包判为「非法应用」。
 */

import type { Browser, BrowserContext, Page, Response as PlaywrightResponse } from 'playwright-core'
import { doubaoConfig as cfg } from './config.js'
import { CookieJar } from './cookie-jar.js'
import { queryDoubaoAccount } from './account.js'
import { generateDeviceIdentity, type DeviceIdentity } from './device.js'
import { launchSystemBrowser } from '../../lib/headless-browser.js'
import type { DoubaoSession } from './credentials.js'
import type { LoginFlowDriver, QrCodePayload, QrPollResult } from './login-flow.js'

/** 登录成功后必然出现的豆包会话 Cookie（出现任意一个即认为登录完成） */
const SESSION_COOKIE_NAMES = new Set(['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt', 'uid_tt_ss', 'sid_guard'])

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toDataUrl(raw: string): string {
  return raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`
}

interface PlaywrightCookie {
  name: string
  value: string
  domain: string
  path: string
  expires?: number
  secure?: boolean
  httpOnly?: boolean
  sameSite?: string
}

export interface DouyinQrLoginOptions {
  /** 测试注入：替换 Playwright 浏览器启动器 */
  launchBrowser?: () => Promise<Browser>
  device?: DeviceIdentity
}

/**
 * 启动登录用浏览器。playwright-core 不自带浏览器，这里优先用系统 Edge / Chrome；
 * 可用 DOUBAO_BROWSER_CHANNEL / DOUBAO_BROWSER_EXECUTABLE_PATH 指定。
 */
async function launchLoginBrowser(): Promise<Browser> {
  return launchSystemBrowser({
    channel: cfg.browserChannel,
    executablePath: cfg.browserExecutablePath,
    headless: cfg.loginHeadless,
    args: cfg.browserArgs ? cfg.browserArgs.split(/\s+/).filter(Boolean) : [],
    failureHint:
      '请安装 Microsoft Edge / Google Chrome，或设置 DOUBAO_BROWSER_CHANNEL / DOUBAO_BROWSER_EXECUTABLE_PATH；' +
      '也可以设置 DOUBAO_LOGIN_FLOW=doubao 使用豆包自助扫码链路',
  })
}

export class DouyinQrLogin implements LoginFlowDriver {
  readonly kind = 'douyin' as const

  private readonly launchBrowser: () => Promise<Browser>
  private readonly device: DeviceIdentity
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private page: Page | null = null
  private qr: QrCodePayload | null = null
  private status: 'new' | 'scanned' = 'new'
  private qrExpired = false
  private session: DoubaoSession | null = null

  constructor(opts: DouyinQrLoginOptions = {}) {
    this.launchBrowser = opts.launchBrowser ?? launchLoginBrowser
    this.device = opts.device ?? generateDeviceIdentity()
  }

  getQr(): QrCodePayload | null {
    return this.qr ? { ...this.qr } : null
  }

  /** 拉起浏览器走完豆包登录弹窗 → 抖音授权页，等待并返回抖音授权二维码 */
  async begin(): Promise<QrCodePayload> {
    const browser = await this.launchBrowser()
    this.browser = browser
    try {
      const context = await browser.newContext({
        userAgent: cfg.userAgent,
        locale: 'zh-CN',
        viewport: { width: 1280, height: 900 },
      })
      this.context = context
      context.on('response', (res) => this.onResponse(res))

      const page = await context.newPage()
      this.page = page
      await this.openDoubaoLogin(page)
      return await this.waitForQr()
    } catch (err) {
      await this.close()
      throw err
    }
  }

  /** 轮询一次：拦截到的扫码状态 + 浏览器 Cookie 双通道判定 */
  async poll(): Promise<QrPollResult> {
    if (this.session) {
      return { status: 'confirmed', message: '登录成功', session: this.session }
    }
    if (!this.context) {
      return { status: 'error', message: '登录浏览器尚未就绪，请刷新二维码重试' }
    }

    try {
      const cookies = await this.context.cookies()
      const doubaoCookies = cookies.filter((c) => c.value && this.isDoubaoDomain(c.domain))
      if (doubaoCookies.some((c) => SESSION_COOKIE_NAMES.has(c.name))) {
        // 回跳后 Cookie 可能分几跳写入，稍等再取一次
        await sleep(800)
        const settled = await this.context.cookies()
        const jar = this.buildJar(settled)
        if (jar.size() > 0) {
          const account = await queryDoubaoAccount(jar, { baseUrl: cfg.baseUrl })
          this.session = {
            cookies: jar.toJSON(),
            device: { ...this.device },
            uid: account?.uid || jar.get('uid_tt') || jar.get('uid_tt_ss') || '',
            nickname: account?.nickname || '',
            savedAt: Date.now(),
          }
          await this.close()
          return { status: 'confirmed', message: '登录成功', session: this.session }
        }
      }

      if (this.qrExpired && this.status === 'new') {
        return {
          status: 'new',
          message: '二维码可能已过期；若页面未自动刷新，请点击「刷新二维码」',
          qr: this.qr ?? undefined,
        }
      }
      return {
        status: this.status,
        message: this.status === 'scanned' ? '已扫码，请在手机上确认登录' : '等待扫码',
        qr: this.qr ?? undefined,
      }
    } catch (err) {
      return { status: 'error', message: `登录状态检查失败：${errMessage(err)}` }
    }
  }

  /** 关闭浏览器（幂等）；成功后也调用，凭证已在 session 中 */
  async close(): Promise<void> {
    const browser = this.browser
    this.browser = null
    this.context = null
    this.page = null
    await browser?.close().catch(() => {})
  }

  // ---- 浏览器交互 ----

  private async openDoubaoLogin(page: Page): Promise<void> {
    await page.goto(`${cfg.baseUrl}/chat/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(2500)

    // 关掉「下载电脑版」弹窗（页面结构变化时失败不阻断）
    for (const sel of ['div[role="dialog"] button[aria-label="关闭"]', 'button:has-text("关闭")']) {
      const loc = page.locator(sel).first()
      if (await loc.count().catch(() => 0)) {
        await loc.click({ timeout: 1500 }).catch(() => {})
        await page.waitForTimeout(600)
        break
      }
    }

    // 打开登录弹窗
    const login = page.getByText('登录', { exact: true }).first()
    await login.waitFor({ state: 'visible', timeout: 20_000 })
    await login.click({ timeout: 5_000 })
    await page.waitForTimeout(1500)

    // 抖音一键登录
    const douyin = page.getByText('抖音一键登录', { exact: true }).first()
    await douyin.waitFor({ state: 'visible', timeout: 15_000 })
    await douyin.click({ timeout: 5_000 })
    await page.waitForTimeout(1200)

    // 隐私 / 授权协议
    const agree = page.getByText('同意', { exact: true }).first()
    if (await agree.count().catch(() => 0)) {
      await agree.click({ timeout: 5_000 }).catch(() => {})
    }
  }

  private async waitForQr(): Promise<QrCodePayload> {
    const deadline = Date.now() + cfg.qrWaitMs
    while (Date.now() < deadline) {
      if (this.qr) return this.qr
      if (!this.context) throw new Error('登录浏览器已关闭')
      await sleep(200)
    }
    throw new Error('等待抖音授权二维码超时；请确认服务器可访问 www.doubao.com 与 open.douyin.com')
  }

  /**
   * 拦截授权页发出的二维码 / 轮询请求。
   * 这里拿到的就是抖音官方授权二维码，而不是豆包 App 的扫码登录码。
   */
  private async onResponse(res: PlaywrightResponse): Promise<void> {
    const url = res.url()
    try {
      if (url.includes('/oauth/get_qrcode/')) {
        const json = (await res.json().catch(() => null)) as { data?: Record<string, unknown> } | null
        const data = json?.data
        const raw = typeof data?.qrcode === 'string' ? data.qrcode : ''
        if (!raw) return
        this.qr = {
          token: typeof data?.token === 'string' ? data.token : '',
          qrDataUrl: toDataUrl(raw),
        }
        this.qrExpired = false
        this.status = 'new'
        return
      }
      if (url.includes('/oauth/check_qrcode/')) {
        const json = (await res.json().catch(() => null)) as { data?: Record<string, unknown> } | null
        const status = String(json?.data?.status || '').toLowerCase()
        if (status === 'scanned' || status === 'confirmed') this.status = 'scanned'
        else if (status === 'new') this.status = 'new'
        else if (status === 'expired') this.qrExpired = true
      }
    } catch {
      /* 响应体读取失败不影响登录 */
    }
  }

  // ---- Cookie ----

  private isDoubaoDomain(domain: string): boolean {
    const host = new URL(cfg.baseUrl).hostname.toLowerCase()
    const d = (domain || '').toLowerCase().replace(/^\./, '')
    if (!d) return false
    return d === host || d.endsWith(`.${host}`) || host.endsWith(`.${d}`)
  }

  private buildJar(cookies: PlaywrightCookie[]): CookieJar {
    const jar = new CookieJar()
    for (const c of cookies) {
      const domain = (c.domain || '').toLowerCase()
      if (!c.value || !this.isDoubaoDomain(domain)) continue
      jar.set({
        name: c.name,
        value: c.value,
        domain: domain.replace(/^\./, ''),
        path: c.path || '/',
        expiresAt: typeof c.expires === 'number' && c.expires > 0 ? c.expires * 1000 : undefined,
        secure: c.secure === true,
        httpOnly: c.httpOnly === true,
        hostOnly: !domain.startsWith('.'),
        sameSite: typeof c.sameSite === 'string' ? c.sameSite : undefined,
      })
    }
    return jar
  }
}
