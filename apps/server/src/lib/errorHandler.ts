/**
 * 全局错误处理器注册——错误序列化的唯一收口。
 *
 * 从 index.ts 抽出以便测试直连（index.ts 有 serve/建库副作用不可 import）：
 * 注册 app.onError（ApiError → { code, params }；未捕获 → INTERNAL 不泄露）
 * 与 app.notFound（/api/* → JSON NOT_FOUND）。
 */

import type { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ErrCode } from '@momoi/shared/errors'

import { ApiError } from './apiError.js'

export function registerErrorHandlers(app: Hono): void {
  // 错误序列化收口——wire 上只有 { code, params }（不发 message，详见 docs/specs/module-errors.md）
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      if (err.status >= 500) {
        console.error(`[api] ${err.code}${err.log ? `: ${err.log}` : ''}`, err.cause ?? '')
      }
      return c.json({ code: err.code, ...(err.params ? { params: err.params } : {}) }, err.status as ContentfulStatusCode)
    }
    // 未捕获异常：完整堆栈只进日志，绝不透传给客户端
    console.error('[api] unhandled:', err)
    return c.json({ code: ErrCode.INTERNAL }, 500)
  })

  // API 路由未匹配 → JSON 错误体；非 API 路径维持默认纯文本（生产下由静态托管兜底 SPA）
  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ code: ErrCode.NOT_FOUND }, 404)
    }
    // 不能调 c.notFound()（会递归自身），等价于 Hono 默认 404
    return new Response('404 Not Found', { status: 404 })
  })
}
