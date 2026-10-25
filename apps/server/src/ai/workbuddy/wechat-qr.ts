/**
 * WorkBuddy 登录页的微信二维码捕获。
 *
 * WorkBuddy 登录页（`authUrl`）默认展示「微信扫码登录」：
 *   GET https://www.workbuddy.cn/auth/realms/copilot/console/auth/wechat-url?...
 *     → { url: "https://open.weixin.qq.com/connect/qrconnect?..." }
 *   微信 JS SDK 随后从 `https://open.weixin.qq.com/connect/qrcode/<uuid>` 拉取二维码图片。
 *
 * 这里用无头系统浏览器打开登录页，拦截二维码图片响应并转成 data URL 回传管理端；
 * 浏览器保持打开，让微信 OAuth 回跳完成登录，之后由 token-manager 继续轮询换票。
 * 浏览器不可用 / 超时时返回 null，调用方回退为「打开登录页」链接。
 */

import type { Browser } from 'playwright-core'
import { workbuddyConfig as cfg } from './config.js'
import { launchSystemBrowser } from '../../lib/headless-browser.js'

const QR_URL_MARKER = '/connect/qrcode/'

export interface WechatQrSession {
  /** 当前二维码 data URL（微信页面刷新二维码后会更新） */
  getQr(): string | null
  /** 扫码状态：new = 等待扫码；scanned = 已扫码待确认 */
  getStatus(): 'new' | 'scanned'
  /** 关闭浏览器 */
  close(): Promise<void>
}

export interface WechatQrOptions {
  /** 测试注入：替换 Playwright 浏览器启动器 */
  launchBrowser?: () => Promise<Browser>
  /** 等待二维码的上限（默认 WORKBUDDY_QR_WAIT_MS） */
  timeoutMs?: number
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toDataUrl(contentType: string, body: Uint8Array): string {
  const mime = contentType.split(';')[0].trim() || 'image/png'
  return `data:${mime};base64,${Buffer.from(body).toString('base64')}`
}

export async function openWechatQrLogin(authUrl: string, opts: WechatQrOptions = {}): Promise<WechatQrSession | null> {
  let browser: Browser | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  try {
    browser = opts.launchBrowser
      ? await opts.launchBrowser()
      : await launchSystemBrowser({
          channel: cfg.browserChannel,
          executablePath: cfg.browserExecutablePath,
          headless: cfg.loginHeadless,
          args: cfg.browserArgs ? cfg.browserArgs.split(/\s+/).filter(Boolean) : [],
          failureHint:
            '请安装 Microsoft Edge / Google Chrome，或设置 WORKBUDDY_BROWSER_CHANNEL / WORKBUDDY_BROWSER_EXECUTABLE_PATH；' +
            '二维码不可用时仍可在面板点「打开登录页」',
        })

    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1200, height: 900 } })
    let latest = ''
    let scanStatus: 'new' | 'scanned' = 'new'
    let resolveFirst: ((value: string) => void) | null = null
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve
    })

    context.on('response', (res) => {
      void (async () => {
        try {
          const url = res.url()
          // 微信扫码长轮询：wx_errcode=408 未扫码 / 404 已扫码待确认 / 405 已确认
          if (url.includes('/connect/l/qrconnect')) {
            const text = await res.text().catch(() => '')
            const match = /wx_errcode\s*=\s*(\d+)/.exec(text)
            if (match) {
              const code = Number(match[1])
              if (code === 404) scanStatus = 'scanned'
              else if (code === 408) scanStatus = 'new'
            }
            return
          }
          if (!url.includes(QR_URL_MARKER)) return
          const contentType = (res.headers()['content-type'] || '').toLowerCase()
          if (!contentType.startsWith('image/')) return
          const body = await res.body()
          if (!body || body.length === 0) return
          latest = toDataUrl(contentType, body)
          resolveFirst?.(latest)
          resolveFirst = null
        } catch {
          /* 响应体读取失败忽略，等待下一次二维码请求 */
        }
      })()
    })

    const page = await context.newPage()
    // 不阻塞等待整页加载：二维码请求可能先于 domcontentloaded 之后的其它资源
    void page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})

    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), opts.timeoutMs ?? cfg.qrWaitMs)
    })
    const got = await Promise.race([first, timeout])
    if (!got) {
      await browser.close().catch(() => {})
      browser = null
      return null
    }

    const owned = browser
    return {
      getQr: () => latest || null,
      getStatus: () => scanStatus,
      close: async () => {
        await owned.close().catch(() => {})
      },
    }
  } catch (err) {
    console.warn(`[workbuddy] 微信二维码捕获失败，回退为打开登录页：${errMessage(err)}`)
    await browser?.close().catch(() => {})
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}
