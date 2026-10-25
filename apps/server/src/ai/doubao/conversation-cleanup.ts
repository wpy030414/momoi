/**
 * 每轮对话结束后删除本轮在豆包侧创建的会话。
 *
 * 逆向实测（2026-10-25）：
 *   POST /im/conversation/batch_del_user_conv?<web params>
 *   Content-Type: application/json; encoding=utf-8
 *   {
 *     "cmd": 4171,
 *     "uplink_body": {
 *       "batch_delete_user_conversation_uplink_body": {
 *         "conversation_id": ["<id>"],
 *         "delete_all": false,
 *         "conversation_type": 3
 *       }
 *     },
 *     "sequence_id": "<uuid>",
 *     "channel": 2,
 *     "version": "1"
 *   }
 *
 * 上游要求每轮创建会话；删除在对话响应结束后异步执行，不阻塞客户端。
 * 失败只记录统计与警告（getCleanupStats 暴露到管理端状态接口）。
 */

import crypto from 'node:crypto'
import { doubaoConfig as cfg } from './config.js'
import type { CookieJar } from './cookie-jar.js'
import type { DeviceIdentity } from './device.js'
import { chatHeaders, toQuery, webParams } from './security-params.js'

const DELETE_CMD = 4171
const ONE_TO_BOT_CHAT = 3
const DOWNSTREAM_FAILED = 712010703

export interface CleanupStats {
  enabled: boolean
  attempted: number
  deleted: number
  failed: number
  lastResult?: 'deleted' | 'failed'
  lastCode?: number
  lastAt?: string
}

const stats: CleanupStats = {
  enabled: cfg.autoDeleteConversation,
  attempted: 0,
  deleted: 0,
  failed: 0,
}

export function getCleanupStats(): CleanupStats {
  return { ...stats }
}

export interface DeleteConversationOptions {
  baseUrl: string
  jar: CookieJar
  device: DeviceIdentity
  conversationId: string
}

export interface DeleteConversationResult {
  ok: boolean
  status?: number
  code?: number
  message?: string
  skipped?: 'disabled' | 'no-id'
}

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function deleteOnce(opts: DeleteConversationOptions): Promise<DeleteConversationResult> {
  const url = `${opts.baseUrl}/im/conversation/batch_del_user_conv?${toQuery(
    webParams(opts.device, opts.jar),
  )}`
  const body = JSON.stringify({
    cmd: DELETE_CMD,
    uplink_body: {
      batch_delete_user_conversation_uplink_body: {
        conversation_id: [opts.conversationId],
        delete_all: false,
        conversation_type: ONE_TO_BOT_CHAT,
      },
    },
    sequence_id: uuid(),
    channel: 2,
    version: '1',
  })
  const headers = {
    ...chatHeaders(opts.jar, { stream: false }),
    'Content-Type': 'application/json; encoding=utf-8',
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(cfg.cleanupTimeoutMs),
    })
  } catch (e) {
    return { ok: false, message: `网络错误：${(e as Error).message}` }
  }

  const text = await res.text().catch(() => '')
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* 非 JSON */
  }
  const code = Number(json?.status_code ?? json?.code ?? NaN)
  const message = String(json?.status_desc ?? json?.msg ?? text.slice(0, 200) ?? '')
  if (!res.ok) {
    return { ok: false, status: res.status, code: Number.isFinite(code) ? code : undefined, message }
  }
  if (json && Number.isFinite(code) && code === 0) {
    return { ok: true, status: res.status, code: 0 }
  }
  return {
    ok: false,
    status: res.status,
    code: Number.isFinite(code) ? code : undefined,
    message: message || '删除会话未返回成功状态',
  }
}

/**
 * 删除一轮对话产生的会话。永不抛出；失败返回 ok=false。
 * 「下游服务器失败」与网络错误会重试一次。
 */
export async function deleteConversation(opts: DeleteConversationOptions): Promise<DeleteConversationResult> {
  if (!cfg.autoDeleteConversation) return { ok: false, skipped: 'disabled' }
  if (!opts.conversationId) return { ok: false, skipped: 'no-id' }

  stats.attempted += 1
  try {
    let result = await deleteOnce(opts)
    if (!result.ok && (result.code === DOWNSTREAM_FAILED || result.status === undefined)) {
      await sleep(400)
      result = await deleteOnce(opts)
    }
    if (result.ok) stats.deleted += 1
    else stats.failed += 1
    stats.lastResult = result.ok ? 'deleted' : 'failed'
    stats.lastCode = result.code
    stats.lastAt = new Date().toISOString()
    if (!result.ok) {
      console.warn(
        `[doubao] 会话清理失败: code=${result.code ?? '-'} status=${result.status ?? '-'} ${result.message || ''}`.trim(),
      )
    }
    return result
  } catch (e) {
    stats.failed += 1
    stats.lastResult = 'failed'
    stats.lastAt = new Date().toISOString()
    console.warn(`[doubao] 会话清理异常: ${(e as Error).message}`)
    return { ok: false, message: (e as Error).message }
  }
}
