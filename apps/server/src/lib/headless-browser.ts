/**
 * 系统浏览器启动器（内置上游的网页登录共用）。
 *
 * playwright-core 不自带浏览器：优先使用系统 Microsoft Edge / Google Chrome；
 * 容器 / 自定义部署可通过 executablePath 指定 Chromium。启动失败时把
 * 上游专属的回退指引附在错误信息里。
 */

import type { Browser } from 'playwright-core'

export interface SystemBrowserOptions {
  /** Playwright 通道：msedge / chrome / chromium；空 = 按平台自动尝试 */
  channel?: string
  /** 直接指定浏览器可执行文件 */
  executablePath?: string
  /** 默认无头（二维码回传到管理端展示） */
  headless?: boolean
  /** 追加启动参数（容器内常需 --no-sandbox） */
  args?: string[]
  /** 启动失败时追加的指引（环境变量名 / 回退方案） */
  failureHint?: string
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function launchSystemBrowser(opts: SystemBrowserOptions = {}): Promise<Browser> {
  const { chromium } = await import('playwright-core')
  const base = {
    headless: opts.headless !== false,
    args: ['--no-first-run', '--no-default-browser-check', ...(opts.args ?? [])],
  }
  const hint = opts.failureHint ? `；${opts.failureHint}` : ''

  if (opts.executablePath) {
    try {
      return await chromium.launch({ ...base, executablePath: opts.executablePath } as never)
    } catch (err) {
      throw new Error(`无法启动登录浏览器：${errMessage(err)}${hint}`)
    }
  }

  const candidates = opts.channel
    ? [opts.channel]
    : process.platform === 'win32'
      ? ['msedge', 'chrome']
      : ['chrome', 'chromium', 'msedge']
  let lastError: unknown = null
  for (const channel of candidates) {
    try {
      return await chromium.launch({ ...base, channel } as never)
    } catch (err) {
      lastError = err
    }
  }
  // 最后尝试 Playwright 自带 Chromium（若用户已安装 browser）
  try {
    return await chromium.launch(base as never)
  } catch (err) {
    lastError = err
  }
  throw new Error(`无法启动登录浏览器${lastError ? `（${errMessage(lastError)}）` : ''}${hint}`)
}
