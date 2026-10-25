/**
 * 用已有 Cookie 查豆包账号信息（尽力而为：失败返回 null，不阻断登录）。
 *
 * 两条登录链路共用：抖音 OAuth（浏览器提取 Cookie 后）与豆包自助扫码。
 * 后台巡检复用同一端点：它是最轻量的「会话是否还有效」探针，且上游可能
 * 在响应里轮换 Cookie（Set-Cookie），探针会顺手吸收进传入的 Cookie 罐。
 */

import { doubaoConfig as cfg } from './config.js'
import type { CookieJar } from './cookie-jar.js'
import { AUTH_CODES } from './error-codes.js'
import { accountParams, toQuery } from './security-params.js'

export interface DoubaoAccountInfo {
  uid: string
  nickname: string
}

/**
 * 巡检结果：
 *   ok    = 会话有效（账号信息缺失也算有效，账号只用于展示）
 *   auth  = 上游判定登录失效（HTTP 401/403 或 710012xxx）
 *   error = 网络 / 其它业务错误（不代表凭证失效）
 */
export type DoubaoProbeResult =
  | { status: 'ok'; account: DoubaoAccountInfo | null }
  | { status: 'auth'; message: string }
  | { status: 'error'; message: string }

function pickString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return String(v)
  }
  return ''
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 探针一次账号端点；会吸收响应里的 Set-Cookie（上游轮换） */
export async function probeDoubaoSession(
  jar: CookieJar,
  opts: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<DoubaoProbeResult> {
  const base = (opts.baseUrl || cfg.baseUrl).replace(/\/+$/, '')
  const url = `${base}${cfg.accountPath}?${toQuery(accountParams())}`
  const cookie = jar.getCookieHeader(`${base}/`)

  let res: Response
  try {
    res = await fetch(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': cfg.userAgent,
        'Referer': `${base}/chat/`,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    })
  } catch (err) {
    return { status: 'error', message: `网络错误：${errMessage(err)}` }
  }

  // 无论结果如何，先把上游轮换的 Cookie 收进来（调用方决定是否写回）
  jar.absorb(res.headers, url)

  const json = (await res.json().catch(() => null)) as Record<string, any> | null
  const data = json?.data?.data ?? json?.data
  const code = Number(data?.error_code ?? json?.error_code ?? 0)
  const desc = pickString(data?.description, data?.desc, json?.message)

  if (res.status === 401 || res.status === 403) {
    return { status: 'auth', message: `HTTP ${res.status}${desc ? `：${desc}` : ''}` }
  }
  if (!res.ok) {
    return { status: 'error', message: `HTTP ${res.status}${desc ? `：${desc}` : ''}` }
  }
  if (code !== 0) {
    const message = `error_code ${code}${desc ? `：${desc}` : ''}`
    return AUTH_CODES.has(code) ? { status: 'auth', message } : { status: 'error', message }
  }

  const uid = pickString(data?.user_id, data?.uid, data?.sec_user_id, data?.userId)
  const nickname = pickString(data?.user_name, data?.nickname, data?.name, data?.unique_id)
  return { status: 'ok', account: uid || nickname ? { uid, nickname } : null }
}

export async function queryDoubaoAccount(
  jar: CookieJar,
  opts: { baseUrl?: string; timeoutMs?: number } = {},
): Promise<DoubaoAccountInfo | null> {
  const result = await probeDoubaoSession(jar, opts)
  return result.status === 'ok' ? result.account : null
}
