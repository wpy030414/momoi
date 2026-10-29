/**
 * WorkBuddy 凭证编排：内存缓存 → 本地（加密）存储 → refresh 续期 → 网页登录。
 *
 * 后台自动轮换：只要本地有凭证，keeper 每分钟巡检一次，在 access token 到期前
 * refreshAheadMs（默认 5 分钟）用 refresh token 续期。
 * refresh token 每次续期都会轮换，续期结果立即加密写回，避免进程重启后
 * 拿着旧的（已失效的）refresh token。
 */

import { workbuddyConfig as cfg } from './config.js'
import {
  clearCredential,
  readCredential,
  writeCredential,
  type WorkBuddyCredential,
} from './credentials.js'
import { fetchAccount, pollOnce, requestHandshake, uidFromToken } from './web-login.js'
import { openWechatQrLogin, type WechatQrSession } from './wechat-qr.js'
import type { WorkBuddyLoginStatus, WorkBuddyStatus } from '@momoi/shared/types'

let cached: WorkBuddyCredential | null = null
let refreshing: Promise<WorkBuddyCredential> | null = null

interface LoginSession {
  state: string
  authUrl: string
  status: 'pending' | 'scanned' | 'success' | 'failed'
  startedAt: number
  message?: string
  /** 登录页的微信二维码（浏览器不可用时缺省，面板回退为打开登录页） */
  qrDataUrl?: string
  /** 二维码捕获阶段：loading → ready / unavailable（面板据此决定按钮与回退链接） */
  qrState: 'loading' | 'ready' | 'unavailable'
  wechat?: WechatQrSession | null
}

let session: LoginSession | null = null

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

/** 用 refresh token 续期（refresh token 会轮换，结果必须写回） */
async function refreshCredential(base: WorkBuddyCredential): Promise<WorkBuddyCredential> {
  if (!base.refreshToken) throw new Error('没有 refresh token，需要重新登录')

  const res = await fetch(`${cfg.baseUrl}${cfg.refreshPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Refresh-Token': base.refreshToken,
      'X-Auth-Refresh-Source': 'plugin',
      'X-Domain': base.domain || cfg.domain,
      'X-Product': cfg.product,
      'X-IDE-Type': 'WorkBuddy',
      'X-IDE-Name': 'WorkBuddy',
      'X-IDE-Version': cfg.ideVersion,
      'X-Private-Data': 'true',
      'User-Agent': `WorkBuddy/${cfg.ideVersion}`,
      'x-requested-with': 'XMLHttpRequest',
      ...(base.uid ? { 'X-User-Id': base.uid } : {}),
    },
    body: '{}',
    signal: AbortSignal.timeout(30_000),
  })

  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`续期失败：HTTP ${res.status} 非 JSON 响应`)
  }
  if (!res.ok || (typeof json.code === 'number' && json.code !== 0)) {
    throw new Error(`续期失败：HTTP ${res.status} code=${json.code ?? '?'} ${json.msg ?? ''}`.trim())
  }

  const data = json.data?.data ?? json.data
  const accessToken = data?.accessToken ?? data?.access_token
  if (typeof accessToken !== 'string' || !accessToken) throw new Error('续期响应缺少 accessToken')

  const now = Date.now()
  const expiresIn = num(data.expiresIn)
  const refreshExpiresIn = num(data.refreshExpiresIn)
  const next: WorkBuddyCredential = {
    accessToken,
    refreshToken: (data.refreshToken ?? data.refresh_token) || base.refreshToken,
    uid: base.uid || uidFromToken(accessToken),
    domain: (typeof data.domain === 'string' ? data.domain : '') || base.domain || cfg.domain,
    nickname: base.nickname,
    expiresAt: num(data.expiresAt) ?? (expiresIn ? now + expiresIn * 1000 : now + 3600_000),
    refreshExpiresAt: num(data.refreshExpiresAt) ?? (refreshExpiresIn ? now + refreshExpiresIn * 1000 : base.refreshExpiresAt),
    savedAt: now,
  }

  await writeCredential(next)
  cached = next
  return next
}

/**
 * 取一个可用凭证：缓存 → 存储 → 续期。
 * 无凭证或续期失败时抛错（由调用方转成面向管理员的提示）。
 */
export async function getAccessToken(): Promise<WorkBuddyCredential> {
  const now = Date.now()
  if (cached && now < cached.expiresAt - cfg.refreshAheadMs) return cached
  if (refreshing) return refreshing

  refreshing = (async () => {
    const stored = cached ?? (await readCredential())
    if (!stored) throw new Error('WorkBuddy 未登录，请在后台「设置 → 网关」中登录')
    cached = stored
    if (Date.now() < stored.expiresAt - cfg.refreshAheadMs) return stored
    if (!stored.refreshToken) throw new Error('WorkBuddy 凭证已过期，请重新登录')
    return refreshCredential(stored)
  })().finally(() => {
    refreshing = null
  })

  return refreshing
}

/** 上游 401 后的强制续期（忽略提前窗口，无条件换新） */
export async function forceRefresh(): Promise<WorkBuddyCredential> {
  if (refreshing) return refreshing
  const base = cached ?? (await readCredential())
  if (!base?.refreshToken) throw new Error('WorkBuddy 没有可用的 refresh token，请重新登录')

  refreshing = refreshCredential(base).finally(() => {
    refreshing = null
  })
  return refreshing
}

/** 供后台巡检使用：只有真的临近过期才续期，返回是否发生了轮换 */
async function rotateIfNeeded(): Promise<boolean> {
  const cred = cached ?? (await readCredential())
  if (!cred) return false
  cached = cred
  if (Date.now() < cred.expiresAt - cfg.refreshAheadMs) return false
  if (!cred.refreshToken) return false
  await forceRefresh()
  return true
}

let keeperTimer: ReturnType<typeof setInterval> | null = null

/**
 * 启动后台自动轮换（幂等）。
 *
 * 只要本地存在凭证就巡检——不以「网关当前是否选中 WorkBuddy」为前提：
 * 管理员选中上游类型后可能还没点保存，而登录已经完成；此时若按已保存的
 * 配置跳过轮换，凭证会在无人察觉中过期。没有凭证时本函数每分钟只做一次
 * 空查询，代价可忽略。
 */
export function startWorkBuddyKeeper(): void {
  if (keeperTimer) return
  void tick()
  keeperTimer = setInterval(() => void tick(), cfg.keepAliveMs)
  keeperTimer.unref?.()
}

async function tick(): Promise<void> {
  try {
    if (await rotateIfNeeded()) {
      console.log('[workbuddy] access token 已自动轮换')
    }
  } catch (err) {
    console.warn(`[workbuddy] 自动轮换失败：${errMessage(err)}`)
  }
}

/** 当前凭证的对外状态（不含任何 token 明文） */
export async function getStatus(): Promise<WorkBuddyStatus> {
  const cred = cached ?? (await readCredential())
  if (!cred) return { logged_in: false, auto_refresh: true }
  cached = cred
  return {
    logged_in: true,
    expired: Date.now() >= cred.expiresAt,
    uid: cred.uid,
    nickname: cred.nickname,
    domain: cred.domain,
    expires_at: new Date(cred.expiresAt).toISOString(),
    refresh_expires_at: cred.refreshExpiresAt ? new Date(cred.refreshExpiresAt).toISOString() : undefined,
    has_refresh_token: Boolean(cred.refreshToken),
    auto_refresh: true,
  }
}

/** 异步申请登录页的微信二维码（纯 HTTP）；失败时标记 unavailable，交给面板提供复制链接回退 */
async function attachWechatQr(current: LoginSession): Promise<void> {
  try {
    const wechat = await openWechatQrLogin(current.authUrl)
    if (session !== current || current.status !== 'pending') {
      await wechat.close().catch(() => {})
      return
    }
    const qr = wechat.getQr()
    if (!qr) {
      current.qrState = 'unavailable'
      console.warn('[workbuddy] 未取得登录页微信二维码，回退为复制登录页链接')
      return
    }
    current.wechat = wechat
    current.qrDataUrl = qr
    current.qrState = 'ready'
  } catch (err) {
    if (session === current) current.qrState = 'unavailable'
    console.warn(`[workbuddy] 微信二维码获取失败：${errMessage(err)}`)
  }
}

async function closeWechat(current: LoginSession): Promise<void> {
  const wechat = current.wechat
  current.wechat = null
  if (wechat) await wechat.close().catch(() => {})
}

/** 发起网页登录：返回登录页地址（并附微信二维码），启动后台换票循环 */
export async function beginLogin(): Promise<{ auth_url: string; state: string }> {
  // 同一时间只保留一个登录会话；旧的登录浏览器先关掉
  const previous = session
  session = null
  if (previous?.wechat) await previous.wechat.close().catch(() => {})

  const handshake = await requestHandshake()
  const next: LoginSession = {
    state: handshake.state,
    authUrl: handshake.authUrl,
    status: 'pending',
    startedAt: Date.now(),
    qrState: 'loading',
  }
  session = next
  void attachWechatQr(next)
  void runLogin(next)
  return { auth_url: handshake.authUrl, state: handshake.state }
}

/** 后台换票：轮询到 token 即取账号、落盘，并让后续请求立即用上新凭证 */
async function runLogin(current: LoginSession): Promise<void> {
  const deadline = current.startedAt + cfg.loginTimeoutMs
  const waitingStatus = () => current.status === 'pending' || current.status === 'scanned'
  let failures = 0

  while (session === current && waitingStatus()) {
    if (Date.now() > deadline) {
      current.status = 'failed'
      current.message = '登录超时，请重新发起登录'
      void closeWechat(current)
      return
    }
    try {
      // 先推进微信扫码状态：长轮询比平台换票更早感知「已扫 / 已确认」
      const wechat = current.wechat
      if (wechat) {
        const scan = await wechat.pollScan()
        if (scan !== 'new') current.status = 'scanned'
        // 二维码失效：清掉旧图，让面板提示刷新（重新发起登录即可换新码）
        if (wechat.isExpired()) {
          current.wechat = null
          current.qrDataUrl = undefined
          current.qrState = 'unavailable'
          current.message = '二维码已过期，请重新点击「扫码登录」'
        }
      }

      const tokens = await pollOnce(current.state)
      if (tokens !== 'pending') {
        const account = await fetchAccount(tokens.accessToken, tokens.domain || cfg.domain)
        const credential: WorkBuddyCredential = {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          uid: account?.uid || uidFromToken(tokens.accessToken),
          domain: account?.domain || tokens.domain || cfg.domain,
          nickname: account?.nickname,
          expiresAt: tokens.expiresAt,
          refreshExpiresAt: tokens.refreshExpiresAt,
          savedAt: Date.now(),
        }
        await writeCredential(credential)
        cached = credential
        current.status = 'success'
        void closeWechat(current)
        console.log(`[workbuddy] 登录成功：uid=${credential.uid || '<空>'}`)
        return
      }
      failures = 0
    } catch (err) {
      // 网络抖动重试；连续多次失败（state 失效等）直接判定失败
      failures += 1
      current.message = errMessage(err)
      if (failures >= 5) {
        current.status = 'failed'
        void closeWechat(current)
        return
      }
    }
    await sleep(cfg.loginPollMs)
  }
}

/** 当前（或最近一次）登录会话状态；等待期间附带微信二维码，成功时附凭证状态 */
export async function getLoginStatus(): Promise<WorkBuddyLoginStatus> {
  if (!session) return { status: 'idle' }
  // 微信长轮询可能先于 token 轮询感知到「已扫码」，这里即时反映到 UI
  if (session.status === 'pending' && session.wechat?.getStatus() === 'scanned') {
    session.status = 'scanned'
  }
  const base: WorkBuddyLoginStatus = { status: session.status, message: session.message }
  if ((session.status === 'pending' || session.status === 'scanned')) {
    base.qr_state = session.qrState
    if (session.qrDataUrl) base.qr_data_url = session.qrDataUrl
    // 只有确认二维码拿不到时才下发登录页地址：正常流程不展示任何外链
    if (session.qrState === 'unavailable') base.auth_url = session.authUrl
  }
  if (session.status !== 'success') return base
  return { ...base, credential: await getStatus() }
}

/** 退出登录：关闭登录浏览器、清凭证与缓存（下次使用时需要重新登录） */
export async function logout(): Promise<void> {
  const current = session
  session = null
  if (current?.wechat) await current.wechat.close().catch(() => {})
  cached = null
  await clearCredential()
}
