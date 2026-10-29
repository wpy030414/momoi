// ============================================================
// 静态托管 /api/* 不在 SPA fallback 内 → 统一返回 JSON 404
// ============================================================
//
// 修复背景：`serveClient` 原先对所有未命中的 GET 请求都返回 index.html（SPA
// fallback），包括 /api/* 路径。这导致不存在的 API 返回 200 + HTML，
// 前端拿 HTML 做 JSON.parse 会抛解析异常，掩盖真正的 404。
//
// 修复：serveClient 在 /api 或 /api/* 路径上直接 next()，交给
// registerErrorHandlers 的 app.notFound 返回 { code: NOT_FOUND }。

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { serveClient } from '../src/lib/static.js'

describe('serveClient /api guard', () => {
  const app = new Hono()
  // 注册 serveClient 后，Hono 的默认 404 与 notFound handler 仍会按需触发
  app.use('*', serveClient)

  it('/ 落到 Hono 默认 404（client 目录不存在时是开发环境）', async () => {
    // 测试环境下 apps/server/dist/client/ 不存在 → serveClient next()
    const res = await app.request('/')
    // Hono 默认 404 是纯文本
    expect(res.status).toBe(404)
  })

  it('/api/foo 不被 SPA fallback 接管，走到 Hono 默认 404', async () => {
    const res = await app.request('/api/foo')
    // 不会得到 200 + HTML
    expect(res.status).toBe(404)
    const ct = res.headers.get('content-type') ?? ''
    expect(ct).not.toContain('text/html')
  })

  it('/api 同样不被接管', async () => {
    const res = await app.request('/api')
    expect(res.status).toBe(404)
    const ct = res.headers.get('content-type') ?? ''
    expect(ct).not.toContain('text/html')
  })

  it('POST /api/foo 不走 serveClient（仅拦截 GET/HEAD）', async () => {
    const res = await app.request('/api/foo', { method: 'POST' })
    expect(res.status).toBe(404)
  })
})
