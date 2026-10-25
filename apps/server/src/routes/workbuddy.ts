/**
 * WorkBuddy 上游管理端点（挂在 /api/admin/workbuddy 下，由 admin.ts 统一鉴权）。
 *
 * 凭证是全局的（与 api_key 同级）——网关只有一份工作账号，管理员登录后
 * 全站请求共用；服务端持票并在后台自动轮换，token 从不上前端。
 */

import { Hono } from 'hono'
import { ErrCode } from '@momoi/shared/errors'
import { ApiError } from '../lib/apiError.js'
import { beginLogin, getLoginStatus, getStatus, logout } from '../ai/workbuddy/token-manager.js'

export const workbuddyRoute = new Hono()

// 当前凭证状态（是否登录、账号、有效期；不含 token）
workbuddyRoute.get('/status', async (c) => c.json(await getStatus()))

// 发起网页登录：返回浏览器登录地址，后台开始轮询换票
workbuddyRoute.post('/login', async (c) => {
  try {
    return c.json(await beginLogin())
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new ApiError(ErrCode.AI_UPSTREAM_ERROR, { detail }, { log: `WorkBuddy 登录握手失败：${detail}` })
  }
})

// 登录进度（前端轮询）：idle / pending / success / failed
workbuddyRoute.get('/login/status', async (c) => c.json(await getLoginStatus()))

// 退出登录：清除本地凭证
workbuddyRoute.post('/logout', async (c) => {
  await logout()
  return c.json({ success: true })
})
