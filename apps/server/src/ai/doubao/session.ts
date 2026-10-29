/**
 * Doubao 凭证编排：内存缓存 → 本地（加密）存储 → DOUBAO_COOKIES 灾备 → 登录。
 *
 * 登录链路由 DOUBAO_LOGIN_FLOW 决定：
 *   douyin（默认）= 抖音官方授权页，二维码是抖音授权码；
 *   doubao        = 纯 HTTP 豆包自助扫码（豆包 App 码，应急旁路）。
 * 豆包登录没有 refresh token；sessionid 等 Cookie 即会话本身，失效只能重新登录。
 *
 * 后台巡检（keeper）：每 DOUBAO_KEEPALIVE_MS 用账号端点探测一次会话是否有效，
 * 并把上游响应里 Set-Cookie 的轮换结果写回加密存储——它不能续期，只能提前
 * 发现失效、尽量延长可用期。登录与对话成功都会清除「已失效」标记。
 */

import type { DoubaoLoginStatus, DoubaoStatus } from '@momoi/shared/types'
import { doubaoConfig as cfg } from './config.js'
import { CookieJar, type CookieRecord } from './cookie-jar.js'
import { clearSession, readSession, writeSession, type DoubaoSession } from './credentials.js'
import { getCleanupStats } from './conversation-cleanup.js'
import { probeDoubaoSession } from './account.js'
import { normalizeDeviceIdentity } from './device.js'
import { getNeedsCaptcha, resetNeedsCaptcha } from './risk.js'
import { DoubaoWebLogin } from './web-login.js'
import { DouyinQrLogin } from './douyin-login.js'
import type { LoginFlowDriver, LoginFlowKind } from './login-flow.js'

let cached: DoubaoSession | null = null
let cachedSource: 'store' | 'env' | null = null

/** 凭证被判定失效（巡检或对话鉴权失败）；重新扫码成功后清除 */
let invalid = false

interface KeepaliveState {
  at: number
  result: 'ok' | 'auth' | 'error'
  message?: string
}

let keepalive: KeepaliveState | null = null

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** DOUBAO_COOKIES 灾备：无本地凭证时用一段 Cookie 头直接工作 */
function envSession(): DoubaoSession | null {
  if (!cfg.cookiesEnv) return null
  const jar = new CookieJar()
  jar.seedCookieHeader(cfg.cookiesEnv, `${cfg.baseUrl}/`)
  if (jar.size() === 0) return null
  return {
    cookies: jar.toJSON(),
    device: normalizeDeviceIdentity({
      deviceId: cfg.deviceIdEnv || undefined,
      webId: cfg.webIdEnv || undefined,
      fp: cfg.fpEnv || undefined,
    }),
    uid: cfg.uidEnv,
    nickname: '',
    savedAt: Date.now(),
  }
}

/** 加载会话（不抛错）：缓存 → 加密存储 → 灾备 Cookie */
async function loadSession(): Promise<DoubaoSession | null> {
  if (cached) return cached
  const stored = await readSession()
  if (stored) {
    cached = stored
    cachedSource = 'store'
    return cached
  }
  const fromEnv = envSession()
  if (fromEnv) {
    cached = fromEnv
    cachedSource = 'env'
    return cached
  }
  return null
}

/**
 * 取一个可用会话：缓存 → 加密存储 → 灾备 Cookie。
 * 无凭证时抛错（由调用方转成面向管理员的可读提示）。
 */
export async function getSession(): Promise<DoubaoSession> {
  const session = await loadSession()
  if (!session) throw new Error('豆包未登录，请在后台「设置 → 网关」中扫码登录')
  return session
}

/** 上游判定登录态失效时调用：清缓存，下次请求会重新读取存储 */
export function markAuthError(): void {
  cached = null
  cachedSource = null
  invalid = true
  keepalive = { at: Date.now(), result: 'auth' }
}

/** 对话成功（含后台巡检成功）时调用：撤销「凭证已失效」标记 */
export function noteSessionOk(): void {
  invalid = false
  keepalive = { at: Date.now(), result: 'ok' }
}

function sameCookies(a: CookieRecord[], b: CookieRecord[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 把上游轮换后的 Cookie 合并回当前会话。
 * 只有内容真的变化时才加密写回；DOUBAO_COOKIES 灾备来源不落库。
 * `expected` 用于并发保护：请求期间若已完成新一轮登录，旧会话的轮换结果作废。
 *
 * 原地更新 `cached.cookies` 而不是替换会话对象：同一轮对话可能连续吸收多次
 * Set-Cookie（主端点失败后回退 /samantha），对象身份必须保持稳定。
 */
export async function absorbRotatedCookies(cookies: CookieRecord[], expected?: DoubaoSession): Promise<void> {
  const current = cached
  if (!current) return
  if (expected && current !== expected) return
  if (sameCookies(current.cookies, cookies)) return
  current.cookies = cookies
  if (cachedSource === 'store') {
    try {
      await writeSession(current)
    } catch (err) {
      console.warn(`[doubao] 回写轮换 Cookie 失败：${errMessage(err)}`)
    }
  }
}

/**
 * 巡检一次：探测会话是否有效，并吸收上游轮换的 Cookie。
 *
 * 已判定失效时跳过——凭证没有 refresh token，重复探测只会在上游留下
 * 无意义的鉴权失败；重新扫码 / 对话成功会清除失效标记。
 */
export async function runKeepaliveCheck(): Promise<void> {
  if (invalid) return
  const session = await loadSession()
  if (!session) return

  const jar = CookieJar.fromJSON(session.cookies)
  const probe = await probeDoubaoSession(jar, { timeoutMs: cfg.keepaliveTimeoutMs })
  // 先吸收轮换（含失败的响应），再处理状态；期间完成新登录则丢弃旧结果
  await absorbRotatedCookies(jar.toJSON(), session)

  if (probe.status === 'ok') {
    invalid = false
    keepalive = { at: Date.now(), result: 'ok' }
    return
  }
  if (probe.status === 'auth') {
    invalid = true
    cached = null
    cachedSource = null
    keepalive = { at: Date.now(), result: 'auth', message: probe.message }
    console.warn(`[doubao] 凭证巡检判定登录失效：${probe.message}`)
    return
  }
  keepalive = { at: Date.now(), result: 'error', message: probe.message }
}

let keeperTimer: ReturnType<typeof setInterval> | null = null

/** 启动后台凭证巡检（幂等；随服务启动，不以「当前是否选中豆包」为前提） */
export function startDoubaoKeeper(): void {
  if (keeperTimer) return
  void tick()
  keeperTimer = setInterval(() => void tick(), cfg.keepaliveMs)
  keeperTimer.unref?.()
}

async function tick(): Promise<void> {
  try {
    await runKeepaliveCheck()
  } catch (err) {
    keepalive = { at: Date.now(), result: 'error', message: errMessage(err) }
    console.warn(`[doubao] 凭证巡检失败：${errMessage(err)}`)
  }
}

/** 当前凭证的对外状态（不含任何 Cookie 明文） */
export async function getStatus(): Promise<DoubaoStatus> {
  await loadSession()
  const keepaliveStatus = {
    enabled: true,
    last_checked_at: keepalive ? new Date(keepalive.at).toISOString() : undefined,
    last_result: keepalive?.result,
    last_message: keepalive?.message,
  }
  if (!cached) {
    return {
      logged_in: false,
      needs_captcha: getNeedsCaptcha(),
      conversation_cleanup: getCleanupStats(),
      keepalive: keepaliveStatus,
    }
  }
  const jar = CookieJar.fromJSON(cached.cookies)
  return {
    logged_in: jar.size() > 0,
    invalid: invalid || undefined,
    source: cachedSource ?? undefined,
    uid: cached.uid || undefined,
    nickname: cached.nickname || undefined,
    saved_at: new Date(cached.savedAt).toISOString(),
    cookie_count: jar.size(),
    needs_captcha: getNeedsCaptcha(),
    conversation_cleanup: getCleanupStats(),
    keepalive: keepaliveStatus,
  }
}

// ---- 扫码登录会话状态机 ----

interface LoginSession {
  driver: LoginFlowDriver
  flow: LoginFlowKind
  status: DoubaoLoginStatus['status']
  message: string
  qrDataUrl?: string
  expireAt?: number
  startedAt: number
}

let login: LoginSession | null = null
/** 正在拉起登录浏览器；并发点击「登录」时复用同一次启动，避免开出多个浏览器 */
let starting: Promise<DoubaoLoginStatus> | null = null
/** 登录代数：退出登录 / 新一轮登录会让仍在启动中的旧链路自行作废 */
let generation = 0

/** 按 DOUBAO_LOGIN_FLOW 选择登录链路：默认 douyin = 抖音官方授权页；doubao = 纯 HTTP 自助扫码 */
function createLoginFlow(): LoginFlowDriver {
  return cfg.loginFlow === 'doubao' ? new DoubaoWebLogin() : new DouyinQrLogin()
}

/** 发起登录：返回二维码与进度快照，后台开始轮询 */
export async function beginLogin(): Promise<DoubaoLoginStatus> {
  if (starting) return starting
  starting = startLogin().finally(() => {
    starting = null
  })
  return starting
}

async function startLogin(): Promise<DoubaoLoginStatus> {
  const gen = ++generation
  // 同一时间只保留一个登录会话；旧的浏览器若还开着先关掉
  const previous = login
  login = null
  if (previous) await previous.driver.close().catch(() => {})

  const driver = createLoginFlow()
  const qr = await driver.begin()
  if (gen !== generation) {
    // 启动期间管理员点了退出 / 发起了新一轮登录
    await driver.close().catch(() => {})
    throw new Error('登录已取消')
  }
  const session: LoginSession = {
    driver,
    flow: driver.kind,
    status: 'pending',
    message: '等待扫码',
    qrDataUrl: qr.qrDataUrl,
    expireAt: qr.expireAt,
    startedAt: Date.now(),
  }
  login = session
  void runLogin(session)
  return snapshot(session)
}

/** 后台轮询：扫码确认后落盘凭证，并让后续请求立即用上新会话 */
async function runLogin(current: LoginSession): Promise<void> {
  const deadline = current.startedAt + cfg.loginTimeoutMs
  const waitingStatus = () => current.status === 'pending' || current.status === 'scanned'

  while (login === current && waitingStatus()) {
    if (Date.now() > deadline) {
      current.status = 'failed'
      current.message = '登录超时，请刷新二维码重试'
      void current.driver.close()
      return
    }
    await sleep(cfg.loginPollMs)
    if (login !== current || !waitingStatus()) return

    try {
      const result = await current.driver.poll()
      // 抖音授权页可能自行刷新二维码；拿到新图就替换，管理端轮询时一并取走
      if (result.qr) {
        current.qrDataUrl = result.qr.qrDataUrl
        current.expireAt = result.qr.expireAt
      }
      if (result.status === 'confirmed' && result.session) {
        await writeSession(result.session)
        cached = result.session
        cachedSource = 'store'
        invalid = false
        keepalive = null
        resetNeedsCaptcha()
        current.status = 'success'
        current.message = '登录成功'
        void current.driver.close()
        console.log(`[doubao] 登录成功：uid=${result.session.uid || '<空>'}`)
        return
      }
      if (result.status === 'expired') {
        current.status = 'expired'
        current.message = result.message
        void current.driver.close()
        return
      }
      if (result.status === 'refused' || result.status === 'error') {
        current.status = 'failed'
        current.message = result.message
        void current.driver.close()
        return
      }
      if (result.status === 'scanned') current.status = 'scanned'
      current.message = result.message
    } catch (err) {
      // 网络抖动继续轮询；连续异常由登录链路在内部计数并返回 error
      current.message = errMessage(err)
    }
  }
}

function snapshot(session: LoginSession): DoubaoLoginStatus {
  const base: DoubaoLoginStatus = {
    status: session.status,
    message: session.message,
    flow: session.flow,
  }
  // 二维码等同临时登录凭据：只在等待扫码/确认期间下发
  if (session.status === 'pending' || session.status === 'scanned') {
    if (session.qrDataUrl) base.qr_data_url = session.qrDataUrl
    if (session.expireAt) base.expire_at = new Date(session.expireAt).toISOString()
  }
  return base
}

/** 当前（或最近一次）登录会话状态；成功时附带最新凭证状态 */
export async function getLoginStatus(): Promise<DoubaoLoginStatus> {
  if (!login) return { status: 'idle' }
  const base = snapshot(login)
  if (login.status !== 'success') return base
  return { ...base, credential: await getStatus() }
}

/** 退出登录：关闭登录浏览器、清凭证与缓存（下次使用时需要重新登录） */
export async function logout(): Promise<void> {
  generation += 1
  const current = login
  login = null
  if (current) await current.driver.close().catch(() => {})
  cached = null
  cachedSource = null
  invalid = false
  keepalive = null
  await clearSession()
}

/** 管理员在浏览器完成人机验证后清除风控标记 */
export function resetCaptcha(): void {
  resetNeedsCaptcha()
}
