// ============================================================
// Request Gate Middleware — 把 lib/requestGate 接到 Hono 上
// ============================================================
//
// 分工（纯逻辑见 lib/requestGate.ts）：
//   generateGateMiddleware  生成桶 —— 在 routes/chat.ts 挂（那里才有 userAuthMiddleware）
//   restGateMiddleware      普通桶 —— 在 index.ts 全局挂载，覆盖其余 /api/*
//   排除                    /api/events 长连接（一次连接挂一分钟，计入等于每分钟扣一次
//                           额度，重连风暴下会误伤正常用户）；OPTIONS 预检不计数
//
// 维度：IP 在入口即得；userId 要等下游路由的 userAuthMiddleware 执行完才能读到。
// 为了不重复验签 / 查封禁，普通桶**入口记 IP、出口补记 userId**：Hono 的中间件是
// 洋葱模型，`await next()` 返回时整条下游已执行完毕。补记只记账、不再判拒绝——
// 请求已经跑完，此时拒绝没有意义。
//
// 生成桶挂在 chat 路由内部，此时 userId 已就绪，一次算清、超限即拒。
// ============================================================

import type { Context, Next } from 'hono'
import { checkAndRecord } from '../lib/requestGate.js'
import { getConfig } from '../lib/config.js'
import { ApiError } from '../lib/apiError.js'
import { ErrCode } from '@momoi/shared/errors'
import { getClientIp } from '../lib/rateLimiter.js'

/** 不参与限流的路径（长连接） */
function isExcluded(path: string): boolean {
  return path === '/api/events' || path.startsWith('/api/events/')
}

/** 生成桶：挂在 POST /api/chat* 上（routes/chat.ts，位于 userAuthMiddleware 之后） */
export function generateGateMiddleware() {
  return async (c: Context, next: Next) => {
    if (c.req.method !== 'POST') return next()

    let config
    try {
      config = await getConfig()
    } catch {
      return next()
    }
    if (!config.rate_limit_enabled) return next()
    const limit = config.rate_limit_generate_per_min
    if (limit <= 0) return next()

    const identities: string[] = []
    const userId = c.get('userId' as never) as string | undefined
    if (userId) identities.push(`u:${userId}`)
    identities.push(`ip:${getClientIp(c)}`)

    const gate = checkAndRecord('generate', identities, limit)
    if (!gate.allowed) {
      throw new ApiError(ErrCode.RATE_LIMIT_EXCEEDED, { retry_after: gate.retryAfterSec })
    }
    return next()
  }
}

/** 普通桶：index.ts 全局挂载（/api/*，跳过聊天入口与事件流） */
export function restGateMiddleware() {
  return async (c: Context, next: Next) => {
    if (c.req.method === 'OPTIONS') return next()

    const path = c.req.path
    if (!path.startsWith('/api/') || isExcluded(path)) return next()
    // 生成桶自己记：这里跳过，避免同一请求被两个桶各记一次
    if (path === '/api/chat' || path.startsWith('/api/chat/')) return next()

    let config
    try {
      config = await getConfig()
    } catch {
      // 配置读取失败不应让全站 500——限流是附加保护，放行
      return next()
    }
    if (!config.rate_limit_enabled) return next()
    const limit = config.rate_limit_rest_per_min
    if (limit <= 0) return next()

    // 入口记账：IP 维度（此时还拿不到 userId）。超限直接拒绝。
    const gate = checkAndRecord('rest', [`ip:${getClientIp(c)}`], limit)
    if (!gate.allowed) {
      throw new ApiError(ErrCode.RATE_LIMIT_EXCEEDED, { retry_after: gate.retryAfterSec })
    }

    try {
      await next()
    } finally {
      // 出口补记 userId 维度（认证失败则没有 userId，跳过）。
      // 只记账、不判拒绝——请求已执行完。
      try {
        const userId = c.get('userId' as never) as string | undefined
        if (userId) checkAndRecord('rest', [`u:${userId}`], limit)
      } catch {
        // 上下文读取异常不影响已完成的响应
      }
    }
  }
}
