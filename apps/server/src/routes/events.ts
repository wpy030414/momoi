// ============================================================
// Events Route — 同账号多设备实时事件通道（SSE 长连接）
// ============================================================
// GET /api/events?device_id=xxx — 登录用户保持一条 SSE 长连接，
// 实时接收聊天流中继 / 会话列表变更 / 群成员变更等事件。
// 认证经 HttpOnly Cookie 自动携带（userAuthMiddleware）。
// 采用 SSE 而非 WebSocket（与 D1 架构决策一致：标准 HTTP、兼容代理）。

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'crypto'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { subscribeRealtime } from '../lib/realtime.js'

export const eventsRoute = new Hono()

// 认证：仅限已登录用户
eventsRoute.use('*', userAuthMiddleware)

eventsRoute.get('/', async (c) => {
  const userId = (c as any).get('userId') as string
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const deviceId = c.req.query('device_id') || randomUUID()

  // SSE 防缓冲响应头：阻止 Nginx/CDN 对长连接做缓冲/聚合（否则事件被攒到
  // 缓冲区满才一次性下发，表现为「没有立刻出现」）。
  c.header('Cache-Control', 'no-cache')
  c.header('X-Accel-Buffering', 'no')
  c.header('Connection', 'keep-alive')

  return streamSSE(c, async (stream) => {
    let closed = false
    let timer: ReturnType<typeof setInterval> | null = null
    // 挂起状态：onAbort（客户端断开）时 resolve，回调随即返回、流被收尾
    let hangResolve: (() => void) | null = null

    const hang = new Promise<void>((resolve) => {
      hangResolve = resolve
    })

    const unsubscribe = subscribeRealtime(userId, deviceId, (dataString) => {
      // 只发 data 字段，不依赖自定义 event 名（`event: xxx`）。
      // 老内核 WebView（钉钉内置等）的 EventSource 对自定义事件名支持不可靠，
      // 可能只触发默认 onmessage；data 已是完整 JSON（含 type），客户端统一
      // 从 onmessage 解析，新旧内核 100% 兼容。
      stream.writeSSE({ data: dataString })
    })

    const cleanup = () => {
      if (closed) return
      closed = true
      if (timer) clearInterval(timer)
      unsubscribe()
      hangResolve?.()
      hangResolve = null
    }

    // Keepalive：SSE 长连接需周期性心跳，防止代理 / 浏览器关闭空闲连接
    timer = setInterval(() => {
      if (closed) return
      try {
        stream.write(':keepalive\n\n')
      } catch {
        cleanup()
      }
    }, 15_000)

    // 客户端断开 / 流关闭时清理订阅并结束挂起
    stream.onAbort(cleanup)

    // 挂起保持连接，直到客户端关闭
    await hang
  })
})
