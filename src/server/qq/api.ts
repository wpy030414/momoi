/**
 * QQ 开放平台机器人 REST 协议（纯函数版，对齐 wechat/ilink.ts 风格）。
 * 无状态业务逻辑、无框架依赖，仅使用 Node 18+ 标准库（fetch）。
 *
 * 协议事实逆向自 @tencent-connect/qqbot-nodejs@1.0.4 源码（token.js /
 * api-client.js / messages.js / routes.js），仅择取 Momoi 所需子集：
 * 取 token、发 C2C 文本、发群文本、网关地址。
 */

export interface QqCredentials {
  appId: string
  appSecret: string
}

export const QQ_API_BASE = 'https://api.sgroup.qq.com'
export const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const TOKEN_TIMEOUT_MS = 10_000
const API_TIMEOUT_MS = 30_000
const FIVE_MINUTES_MS = 5 * 60_000

const USER_AGENT = 'momoi/0.1'

// ---- Token 缓存（per appId：单飞 + 提前刷新） ----

interface TokenCacheEntry { token: string; expiresAt: number }

const tokenCache = new Map<string, TokenCacheEntry>()
const tokenFetches = new Map<string, Promise<string>>()

/** 清除 token 缓存（网关 4004 等场景强制刷新用） */
export function clearQqTokenCache(appId?: string): void {
  if (appId) tokenCache.delete(appId.trim())
  else tokenCache.clear()
}

/**
 * 获取 access_token；带 per-appId 内存缓存、单飞与提前刷新。
 * 凭证无效时 throw（绑定流程用它做凭证校验）。
 */
export async function getAccessToken(creds: QqCredentials): Promise<string> {
  const appId = creds.appId.trim()
  const cached = tokenCache.get(appId)
  const refreshAheadMs = cached
    ? Math.min(FIVE_MINUTES_MS, (cached.expiresAt - Date.now()) / 3)
    : 0
  if (cached && Date.now() < cached.expiresAt - refreshAheadMs) {
    return cached.token
  }

  let pending = tokenFetches.get(appId)
  if (pending) return pending
  pending = (async () => {
    try {
      return await fetchToken(creds)
    } finally {
      tokenFetches.delete(appId)
    }
  })()
  tokenFetches.set(appId, pending)
  return pending
}

async function fetchToken(creds: QqCredentials): Promise<string> {
  const res = await fetch(QQ_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ appId: creds.appId.trim(), clientSecret: creds.appSecret }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  })
  const raw = await res.text()
  let data: { access_token?: string; expires_in?: number }
  try {
    data = JSON.parse(raw)
  } catch {
    data = {}
  }
  if (!res.ok || !data.access_token) {
    throw new Error(`获取 access_token 失败: HTTP ${res.status} body=${raw.slice(0, 200)}`)
  }
  const expiresAt = Date.now() + (data.expires_in ?? 7200) * 1000
  tokenCache.set(creds.appId.trim(), { token: data.access_token, expiresAt })
  return data.access_token
}

// ---- REST 请求 ----

/**
 * QQ 开放平台 REST 请求。Authorization: `QQBot <token>`。
 * 失败 throw（错误消息含 HTTP 状态、err_code 与 body 摘要，供上层分类决策）。
 */
async function qqApiFetch(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const res = await fetch(`${QQ_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `QQBot ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
  const raw = await res.text()
  if (!res.ok) {
    let errCode: string | undefined
    try {
      const parsed = JSON.parse(raw) as { code?: number | string; err_code?: number | string; message?: string }
      errCode = String(parsed.code ?? parsed.err_code ?? '')
    } catch { /* HTML 错误页等非 JSON 响应 */ }
    throw new Error(
      `QQ API ${path} failed: HTTP ${res.status}${errCode ? ` err_code=${errCode}` : ''} body=${raw.slice(0, 200)}`,
    )
  }
  try {
    return JSON.parse(raw)
  } catch {
    // 空响应体（204 等）按成功无数据处理
    return undefined
  }
}

/** 生成 0..65535 的 msg_seq —— 同一 msg_id 发多条消息需不同 msg_seq */
export function getNextMsgSeq(): number {
  const timePart = Date.now() % 100_000_000
  const random = Math.floor(Math.random() * 65536)
  return (timePart ^ random) % 65536
}

/** 发送 C2C 文本（被动回复：带 msgId 配额高）；失败 throw，由调用方决定重试 */
export async function sendC2CText(
  creds: QqCredentials,
  openid: string,
  opts: { msgId?: string; msgSeq?: number; content: string },
): Promise<void> {
  const token = await getAccessToken(creds)
  await qqApiFetch(token, 'POST', `/v2/users/${openid}/messages`, {
    content: opts.content,
    msg_type: 0,
    msg_seq: opts.msgSeq ?? getNextMsgSeq(),
    ...(opts.msgId ? { msg_id: opts.msgId } : {}),
  })
}

/** 获取 WebSocket 网关地址（wss://） */
export async function getGatewayUrl(creds: QqCredentials): Promise<string> {
  const token = await getAccessToken(creds)
  const data = await qqApiFetch(token, 'GET', '/gateway') as { url?: string }
  if (!data?.url) throw new Error('QQ gateway 响应缺少 url 字段')
  return data.url
}
