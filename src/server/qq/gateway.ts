/**
 * QQ 开放平台 WebSocket 网关连接（单连接协议状态机）。
 *
 * 职责：连接、心跳、IDENTIFY/RESUME、事件分发、按关闭码策略重连。
 * 不持有业务策略（路由/AI 桥接在 manager/chat 层）。
 * 会话状态（sessionId/lastSeq）仅内存 —— 进程重启后放弃 RESUME 直接 IDENTIFY，
 * 停机期间的消息会丢失（与微信轮询停机同级的语义，见 module-qq.md）。
 *
 * 协议事实逆向自 @tencent-connect/qqbot-nodejs@1.0.4 源码
 * （gateway-connection.js / reconnect.js / event-dispatcher.js / constants.js）。
 */
import WebSocket from 'ws'
import { getAccessToken, getGatewayUrl, clearQqTokenCache, type QqCredentials } from './api.js'

export interface QqInboundMessage {
  messageId: string
  openid: string
  content: string
  timestamp?: string
}

export interface QqGatewayOpts {
  userId: string
  creds: QqCredentials
  /** C2C_MESSAGE_CREATE 入站消息 */
  onMessage: (msg: QqInboundMessage) => void
  /** READY 或 RESUMED —— 连接可用 */
  onReady: () => void
  /** 凭证级错误（token 获取失败等）—— 连接仍会退避重试，由上层决定落库 */
  onError: (message: string) => void
  /** 致命错误（4914/4915 沙箱未上线或被封）—— 连接已停，不再重试 */
  onFatal: (reason: string) => void
}

// ---- 协议常量 ----

const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const

const GatewayCloseCode = {
  NORMAL: 1000,
  AUTH_FAILED: 4004,
  INVALID_SESSION: 4006,
  SEQ_OUT_OF_RANGE: 4007,
  RATE_LIMITED: 4008,
  SESSION_TIMEOUT: 4009,
  SERVER_ERROR_START: 4900,
  SERVER_ERROR_END: 4913,
  INSUFFICIENT_INTENTS: 4914,
  DISALLOWED_INTENTS: 4915,
} as const

/** 仅申请群+C2C 消息 intent（C2C_MESSAGE_CREATE 所在位） */
const INTENT_GROUP_AND_C2C = 1 << 25

const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]
const RATE_LIMIT_DELAY = 60_000
const MAX_RECONNECT_ATTEMPTS = 100
const MAX_QUICK_DISCONNECT_COUNT = 3
const QUICK_DISCONNECT_THRESHOLD = 5_000
const USER_AGENT = 'momoi/0.1'

interface CloseAction {
  shouldReconnect: boolean
  clearSession: boolean
  refreshToken: boolean
  fatal: boolean
  reason: string
  reconnectDelay?: number
}

export class QQGatewayConnection {
  readonly appId: string

  private opts: QqGatewayOpts
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private sessionId: string | null = null
  private lastSeq: number | null = null
  private stopped = false
  private connecting = false
  private ready = false
  private attempts = 0
  private lastConnectTime = 0
  private quickDisconnectCount = 0
  private shouldRefreshToken = false

  constructor(opts: QqGatewayOpts) {
    this.opts = opts
    this.appId = opts.creds.appId.trim()
  }

  isReady(): boolean {
    return this.ready
  }

  /** 启动连接循环（fire-and-forget；内部自动重连） */
  start(): void {
    void this.connect()
  }

  /** 停止连接并清理全部定时器（幂等） */
  stop(): void {
    this.stopped = true
    this.ready = false
    this.clearTimers()
    if (this.ws) {
      this.ws.removeAllListeners()
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(GatewayCloseCode.NORMAL)
      }
      this.ws = null
    }
  }

  // ---- 连接与协议处理 ----

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) return
    this.connecting = true
    try {
      if (this.shouldRefreshToken) {
        clearQqTokenCache(this.appId)
        this.shouldRefreshToken = false
      }
      const accessToken = await getAccessToken(this.opts.creds)
      const gatewayUrl = await getGatewayUrl(this.opts.creds)
      if (this.stopped) return

      const ws = new WebSocket(gatewayUrl, { headers: { 'User-Agent': USER_AGENT } })
      this.ws = ws
      ws.on('open', () => {
        this.connecting = false
        this.attempts = 0
        this.lastConnectTime = Date.now()
        console.log(`[qq:${this.opts.userId}] gateway connected`)
      })
      ws.on('message', (data) => { this.handleFrame(accessToken, data) })
      ws.on('close', (code) => {
        this.connecting = false
        this.ready = false
        this.handleClose(code)
      })
      ws.on('error', (err) => {
        console.error(`[qq:${this.opts.userId}] gateway error: ${err.message}`)
      })
    } catch (err) {
      this.connecting = false
      this.ready = false
      const message = err instanceof Error ? err.message : String(err)
      // 凭证级失败（token 获取不到）上报上层落库；连接循环继续退避重试
      this.opts.onError(message)
      this.scheduleReconnect(undefined)
    }
  }

  private handleFrame(accessToken: string, data: unknown): void {
    let payload: { op?: number; d?: any; s?: number; t?: string }
    try {
      const raw = typeof data === 'string' ? data : Buffer.from(data as ArrayBuffer).toString('utf8')
      payload = JSON.parse(raw)
    } catch {
      console.error(`[qq:${this.opts.userId}] gateway frame parse error`)
      return
    }
    if (payload.s) this.lastSeq = payload.s

    switch (payload.op) {
      case GatewayOp.HELLO: {
        this.handleHello(this.ws!, accessToken, payload.d)
        break
      }
      case GatewayOp.DISPATCH: {
        this.handleDispatch(payload.t ?? '', payload.d)
        break
      }
      case GatewayOp.HEARTBEAT_ACK:
        break
      case GatewayOp.RECONNECT: {
        console.log(`[qq:${this.opts.userId}] gateway requested reconnect (op 7)`)
        this.teardown()
        this.scheduleReconnect(undefined)
        break
      }
      case GatewayOp.INVALID_SESSION: {
        const resumable = payload.d === true
        console.log(`[qq:${this.opts.userId}] invalid session (resumable=${resumable})`)
        if (!resumable) {
          this.sessionId = null
          this.lastSeq = null
          this.shouldRefreshToken = true
        }
        this.teardown()
        this.scheduleReconnect(3_000)
        break
      }
    }
  }

  private handleHello(ws: WebSocket, accessToken: string, d: any): void {
    if (this.sessionId && this.lastSeq !== null) {
      ws.send(JSON.stringify({
        op: GatewayOp.RESUME,
        d: { token: `QQBot ${accessToken}`, session_id: this.sessionId, seq: this.lastSeq },
      }))
    } else {
      ws.send(JSON.stringify({
        op: GatewayOp.IDENTIFY,
        d: { token: `QQBot ${accessToken}`, intents: INTENT_GROUP_AND_C2C, shard: [0, 1] },
      }))
    }
    const interval = d?.heartbeat_interval
    if (typeof interval === 'number' && interval > 0) {
      this.heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ op: GatewayOp.HEARTBEAT, d: this.lastSeq }))
        }
      }, interval)
    }
  }

  private handleDispatch(t: string, d: any): void {
    if (t === 'READY') {
      this.sessionId = d?.session_id ?? null
      this.ready = true
      console.log(`[qq:${this.opts.userId}] gateway READY (session=${this.sessionId})`)
      this.opts.onReady()
      return
    }
    if (t === 'RESUMED') {
      this.ready = true
      console.log(`[qq:${this.opts.userId}] gateway RESUMED`)
      this.opts.onReady()
      return
    }
    if (t === 'C2C_MESSAGE_CREATE') {
      const content = typeof d?.content === 'string' ? d.content : ''
      this.opts.onMessage({
        messageId: String(d?.id ?? ''),
        openid: String(d?.author?.user_openid ?? ''),
        content: content.trim(),
        timestamp: d?.timestamp,
      })
    }
    // 群/频道/生命周期等事件静默忽略 —— 仅处理 C2C
  }

  // ---- 关闭码策略与重连 ----

  private handleClose(code: number): void {
    const action = this.closeAction(code)
    console.log(`[qq:${this.opts.userId}] gateway closed: ${code} (${action.reason})`)

    if (action.clearSession) {
      this.sessionId = null
      this.lastSeq = null
    }
    if (action.refreshToken) {
      this.shouldRefreshToken = true
    }
    this.teardown()
    if (action.fatal) {
      this.stopped = true
      this.opts.onFatal(action.reason)
      return
    }
    if (action.shouldReconnect) {
      this.scheduleReconnect(action.reconnectDelay)
    }
  }

  private closeAction(code: number): CloseAction {
    if (code === GatewayCloseCode.INSUFFICIENT_INTENTS || code === GatewayCloseCode.DISALLOWED_INTENTS) {
      const reason = code === GatewayCloseCode.INSUFFICIENT_INTENTS
        ? '机器人未上线或仅在沙箱可用（close 4914），请在 q.qq.com 检查机器人发布状态'
        : '机器人被平台封禁（close 4915）'
      return { shouldReconnect: false, clearSession: false, refreshToken: false, fatal: true, reason }
    }
    if (code === GatewayCloseCode.AUTH_FAILED) {
      return { shouldReconnect: !this.stopped, clearSession: false, refreshToken: true, fatal: false, reason: 'invalid token (4004)' }
    }
    if (code === GatewayCloseCode.RATE_LIMITED) {
      return { shouldReconnect: !this.stopped, reconnectDelay: RATE_LIMIT_DELAY, clearSession: false, refreshToken: false, fatal: false, reason: 'rate limited (4008)' }
    }
    if (code === GatewayCloseCode.INVALID_SESSION || code === GatewayCloseCode.SEQ_OUT_OF_RANGE || code === GatewayCloseCode.SESSION_TIMEOUT) {
      return { shouldReconnect: !this.stopped, clearSession: true, refreshToken: true, fatal: false, reason: `session invalid (${code})` }
    }
    if (code >= GatewayCloseCode.SERVER_ERROR_START && code <= GatewayCloseCode.SERVER_ERROR_END) {
      return { shouldReconnect: !this.stopped, clearSession: true, refreshToken: true, fatal: false, reason: `server error (${code})` }
    }
    // 快断保护：连续 3 次 <5s 断开 → 强制冷却 60s（可能是权限问题导致的抖动）
    const connectionDuration = Date.now() - this.lastConnectTime
    if (this.lastConnectTime > 0 && connectionDuration < QUICK_DISCONNECT_THRESHOLD) {
      this.quickDisconnectCount++
      if (this.quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
        this.quickDisconnectCount = 0
        return { shouldReconnect: !this.stopped, reconnectDelay: RATE_LIMIT_DELAY, clearSession: false, refreshToken: false, fatal: false, reason: 'too many quick disconnects' }
      }
    } else {
      this.quickDisconnectCount = 0
    }
    return { shouldReconnect: !this.stopped && code !== GatewayCloseCode.NORMAL, clearSession: false, refreshToken: false, fatal: false, reason: `close code ${code}` }
  }

  private scheduleReconnect(customDelay?: number): void {
    if (this.stopped) return
    if (this.attempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[qq:${this.opts.userId}] max reconnect attempts reached, giving up`)
      this.stopped = true
      this.opts.onFatal('重连次数超限（100 次），已停止重试')
      return
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    const delay = customDelay ?? RECONNECT_DELAYS[Math.min(this.attempts, RECONNECT_DELAYS.length - 1)]
    this.attempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) void this.connect()
    }, delay)
  }

  private teardown(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.ws) {
      this.ws.removeAllListeners()
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(GatewayCloseCode.NORMAL)
      }
      this.ws = null
    }
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }
}
