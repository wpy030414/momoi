/**
 * 错误信封契约测试——wire 形状不变式：
 *   1. 所有错误响应体为 { code: string, params?: Record<string, string|number> }
 *   2. 无 message 字段（人类可读文案只存在于前端三语 locale）
 *   3. 未捕获异常不泄露 err.message / 堆栈
 */

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'

import { registerErrorHandlers } from '../src/lib/errorHandler.js'
import { ApiError } from '../src/lib/apiError.js'
import { ErrCode } from '@momoi/shared/errors'
import { promptsRoute } from '../src/routes/prompts.js'
import { checkIpBlocked, recordPinFailure } from '../src/lib/rateLimiter.js'

function testApp(): Hono {
  const app = new Hono()
  registerErrorHandlers(app)
  app.route('/api/admin/prompts', promptsRoute)
  return app
}

/** 信封不变式断言：code 为 string、无 message、params 值仅 string|number */
async function expectEnvelope(res: Response): Promise<{ code: string; params?: Record<string, unknown> }> {
  expect(res.headers.get('content-type') ?? '').toContain('application/json')
  const body = await res.json()
  expect(typeof body.code).toBe('string')
  expect(body).not.toHaveProperty('message')
  if (body.params !== undefined) {
    expect(typeof body.params).toBe('object')
    for (const v of Object.values(body.params)) {
      expect(['string', 'number']).toContain(typeof v)
    }
  }
  return body
}

describe('全局错误处理（onError / notFound）', () => {
  it('ApiError 序列化为 { code, params }，status 取注册表默认值', async () => {
    const app = testApp()
    app.get('/api/boom', (c) => {
      throw new ApiError(ErrCode.UPLOAD_FILE_TOO_LARGE, { limit: '20MB' })
    })
    const res = await app.request('/api/boom')
    expect(res.status).toBe(400)
    const body = await expectEnvelope(res)
    expect(body.code).toBe('UPLOAD_FILE_TOO_LARGE')
    expect(body.params).toEqual({ limit: '20MB' })
  })

  it('ApiError 无 params 时响应体不含 params 键', async () => {
    const app = testApp()
    app.get('/api/plain', (c) => {
      throw new ApiError(ErrCode.CONV_NOT_FOUND)
    })
    const res = await app.request('/api/plain')
    expect(res.status).toBe(404)
    const body = await expectEnvelope(res)
    expect(body.code).toBe('CONV_NOT_FOUND')
    expect(body).not.toHaveProperty('params')
  })

  it('未捕获异常收敛为 INTERNAL 500，不泄露 message', async () => {
    const app = testApp()
    app.get('/api/crash', () => {
      throw new Error('secret-internal-detail /var/db/password')
    })
    const res = await app.request('/api/crash')
    expect(res.status).toBe(500)
    const body = await expectEnvelope(res)
    expect(body.code).toBe('INTERNAL')
    expect(JSON.stringify(body)).not.toContain('secret-internal-detail')
  })

  it('/api/* 未匹配路由返回 { code: NOT_FOUND }', async () => {
    const app = testApp()
    const res = await app.request('/api/definitely-not-a-route')
    expect(res.status).toBe(404)
    const body = await expectEnvelope(res)
    expect(body.code).toBe('NOT_FOUND')
  })
})

describe('代表性端点的错误码断言', () => {
  it('GET /fragment 不存在 → PROMPT_FRAGMENT_NOT_FOUND 带 id 参数', async () => {
    const app = testApp()
    const res = await app.request('/api/admin/prompts/fragment?id=nope')
    expect(res.status).toBe(404)
    const body = await expectEnvelope(res)
    expect(body.code).toBe('PROMPT_FRAGMENT_NOT_FOUND')
    expect(body.params).toEqual({ id: 'nope' })
  })

  it('POST /preview 缺 target → PROMPT_TARGET_REQUIRED', async () => {
    const app = testApp()
    const res = await app.request('/api/admin/prompts/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'core/persona' }),
    })
    expect(res.status).toBe(400)
    const body = await expectEnvelope(res)
    expect(body.code).toBe('PROMPT_TARGET_REQUIRED')
  })
})

describe('rateLimiter 结构化封禁秒数', () => {
  it('连续 5 次失败后 checkIpBlocked 返回 { seconds > 0 }', () => {
    const ip = `192.0.2.${Math.floor(Math.random() * 250) + 1}`
    expect(checkIpBlocked(ip)).toBeNull()
    for (let i = 0; i < 5; i++) recordPinFailure(ip)
    const r = checkIpBlocked(ip)
    expect(r).not.toBeNull()
    expect(r!.seconds).toBeGreaterThan(0)
    expect(r!.seconds).toBeLessThanOrEqual(300)
  })

  it('未达阈值返回 null（不封禁）', () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`
    recordPinFailure(ip)
    expect(checkIpBlocked(ip)).toBeNull()
  })
})
