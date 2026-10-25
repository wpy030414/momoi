/**
 * WorkBuddy 对话转发：把 OpenAI Chat Completions 请求体原样交给官方网关。
 *
 * 与通用 OpenAI 兼容端点的差异全部收在这一层：
 * - 认证是 WorkBuddy 的 access token + 一组客户端身份头（X-IDE-* / X-Domain），
 *   不是普通 Bearer api_key；
 * - token 由 token-manager 自行轮换，401 时强制续期并重试一次；
 * - 上游只接受流式（非流式请求返回 400 / code 11101），调用方恒传 stream:true。
 *
 * 响应仍是标准 OpenAI SSE chunk，解析与工具调用聚合沿用 provider.ts 的既有逻辑。
 */

import { ErrCode } from '@momoi/shared/errors'
import { ApiError } from '../../lib/apiError.js'
import { workbuddyConfig as cfg } from './config.js'
import { forceRefresh, getAccessToken } from './token-manager.js'
import { gatewayHeaders } from './headers.js'
import type { WorkBuddyCredential } from './credentials.js'

function send(credential: WorkBuddyCredential, body: string, signal: AbortSignal): Promise<Response> {
  return fetch(`${cfg.baseUrl}${cfg.chatPath}`, {
    method: 'POST',
    headers: gatewayHeaders(credential, { accept: 'text/event-stream', conversation: true }),
    body,
    signal,
  })
}

/**
 * 发送一次对话请求。凭证缺失/续期失败时抛 ApiError（面向管理员的可读提示）；
 * 上游 401/403 时强制续期并重试一次，仍失败则把上游响应原样交回由调用方渲染。
 */
export async function postWorkBuddyChat(body: string, signal: AbortSignal): Promise<Response> {
  let credential: WorkBuddyCredential
  try {
    credential = await getAccessToken()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new ApiError(ErrCode.AI_UPSTREAM_ERROR, { detail }, { log: `[workbuddy] 取凭证失败：${detail}` })
  }

  let response = await send(credential, body, signal)
  if (response.status === 401 || response.status === 403) {
    try {
      credential = await forceRefresh()
      response = await send(credential, body, signal)
    } catch (err) {
      console.warn(`[workbuddy] 401 后强制续期失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return response
}
