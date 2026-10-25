/**
 * Doubao（豆包网页）上游管理端点（挂在 /api/admin/doubao 下，由 admin.ts 统一鉴权）。
 *
 * 凭证是全局的（与 api_key 同级）——网关只有一份豆包账号，管理员扫码登录后
 * 全站请求共用；Cookie 由服务端加密持有，永不下发前端。
 */

import { Hono } from 'hono'
import { ErrCode } from '@momoi/shared/errors'
import { ApiError } from '../lib/apiError.js'
import { beginLogin, getLoginStatus, getStatus, logout, resetCaptcha } from '../ai/doubao/session.js'

export const doubaoRoute = new Hono()

// 当前凭证状态（是否登录、账号、保存时间、Cookie 条数；不含 Cookie 明文）
doubaoRoute.get('/status', async (c) => c.json(await getStatus()))

// 发起扫码登录：返回二维码 data URL，后台开始轮询换票
doubaoRoute.post('/login', async (c) => {
  try {
    return c.json(await beginLogin())
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new ApiError(ErrCode.AI_UPSTREAM_ERROR, { detail }, { log: `豆包登录初始化失败：${detail}` })
  }
})

// 登录进度（前端轮询）：pending / scanned / success / failed / expired
doubaoRoute.get('/login/status', async (c) => c.json(await getLoginStatus()))

// 退出登录：清除本地凭证
doubaoRoute.post('/logout', async (c) => {
  await logout()
  return c.json({ success: true })
})

// 管理员在浏览器完成人机验证后清除风控标记
doubaoRoute.post('/reset-captcha', (c) => {
  resetCaptcha()
  return c.json({ success: true })
})
