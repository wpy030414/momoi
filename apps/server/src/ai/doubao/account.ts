/**
 * 用已有 Cookie 查豆包账号信息（尽力而为：失败返回 null，不阻断登录）。
 *
 * 两条登录链路共用：抖音 OAuth（浏览器提取 Cookie 后）与豆包自助扫码。
 */

import { doubaoConfig as cfg } from './config.js'
import type { CookieJar } from './cookie-jar.js'
import { accountParams, toQuery } from './security-params.js'

export interface DoubaoAccountInfo {
  uid: string
  nickname: string
}

function pickString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return String(v)
  }
  return ''
}

export async function queryDoubaoAccount(
  jar: CookieJar,
  opts: { baseUrl?: string } = {},
): Promise<DoubaoAccountInfo | null> {
  const base = (opts.baseUrl || cfg.baseUrl).replace(/\/+$/, '')
  try {
    const url = `${base}${cfg.accountPath}?${toQuery(accountParams())}`
    const cookie = jar.getCookieHeader(`${base}/`)
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': cfg.userAgent,
        'Referer': `${base}/chat/`,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    })
    const json = (await res.json().catch(() => null)) as Record<string, any> | null
    const data = json?.data?.data ?? json?.data
    if (!res.ok || !data) return null
    const code = Number(data.error_code ?? json?.error_code ?? 0)
    if (code !== 0) return null
    const uid = pickString(data.user_id, data.uid, data.sec_user_id, data.userId)
    const nickname = pickString(data.user_name, data.nickname, data.name, data.unique_id)
    if (!uid && !nickname) return null
    return { uid, nickname }
  } catch {
    return null
  }
}
