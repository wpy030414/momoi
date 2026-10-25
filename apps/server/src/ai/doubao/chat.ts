/**
 * Doubao → Momoi 的流式适配层。
 *
 * provider.ts 在 `gateway_source === 'doubao'` 时整段委托这里，因此不需要把
 * 豆包的私有 SSE 伪装成 OpenAI chunk：直接把上游增量翻译成 StreamEvent。
 * 工具调用：豆包网页端没有稳定的原生 tool_call 协议，这里不伪造该语义——
 * 工具定义被忽略，Agent 只拿文本回复（详见 docs/specs/module-doubao.md）。
 */

import { ErrCode } from '@momoi/shared/errors'
import { ApiError } from '../../lib/apiError.js'
import type { ChatMessage, StreamEvent } from '../provider.js'
import { DoubaoClient, DoubaoUpstreamError } from './client.js'
import type { DoubaoSession } from './credentials.js'
import { UnsupportedMessageError } from './messages.js'
import { getSession, markAuthError } from './session.js'

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

function normalizeUsage(raw: unknown): StreamEvent['usage'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  const prompt = num(u.prompt_tokens ?? u.input_tokens)
  const completion = num(u.completion_tokens ?? u.output_tokens)
  if (prompt === undefined && completion === undefined) return undefined
  return { promptTokens: prompt ?? 0, completionTokens: completion ?? 0 }
}

/** 把上游/本地错误统一映射为面向用户的 ApiError（detail 会随 wire 展示） */
function mapError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  if (err instanceof UnsupportedMessageError) {
    return new ApiError(
      ErrCode.AI_UPSTREAM_ERROR,
      { detail: err.message },
      { log: `[doubao] 不支持的输入：${err.message}` },
    )
  }
  if (err instanceof DoubaoUpstreamError) {
    if (err.kind === 'auth') markAuthError()
    const detail = err.kind === 'auth'
      ? `${err.message}；请在后台「设置 → 网关 → 上游类型」中重新扫码登录`
      : err.kind === 'risk'
        ? `${err.message}；请先在浏览器打开 https://www.doubao.com 完成人机验证后重试`
        : err.message
    return new ApiError(
      ErrCode.AI_UPSTREAM_ERROR,
      { detail },
      { log: `[doubao] ${err.message}`, cause: err },
    )
  }
  if ((err as Error)?.name === 'AbortError') {
    return new ApiError(ErrCode.AI_UPSTREAM_TIMEOUT, undefined, { log: '[doubao] 上游请求超时' })
  }
  return new ApiError(
    ErrCode.AI_UPSTREAM_ERROR,
    { detail: errMessage(err) },
    { log: `[doubao] ${errMessage(err)}`, cause: err },
  )
}

/**
 * 发起一次豆包对话并产出 Momoi 的流式事件。
 *
 * @param thinkingMode 关闭时不向上游申请深度思考，并丢弃思考增量
 * @param opts.onConnected 上游 SSE 建立成功时回调（外层据此清掉连接超时）
 */
export async function* streamDoubaoChat(
  model: string,
  messages: ChatMessage[],
  thinkingMode: boolean,
  signal: AbortSignal,
  opts: { onConnected?: () => void } = {},
): AsyncGenerator<StreamEvent> {
  let session: DoubaoSession
  try {
    session = await getSession()
  } catch (err) {
    throw mapError(err)
  }

  const client = new DoubaoClient(session)
  let usage: StreamEvent['usage']

  try {
    for await (const delta of client.chat({
      model,
      messages,
      signal,
      // 关闭思考：不启用深度思考，思考强度收到最低档
      deepThink: thinkingMode ? undefined : false,
      reasoningEffort: thinkingMode ? undefined : 3,
      onConnected: opts.onConnected,
    })) {
      if (delta.usage) usage = normalizeUsage(delta.usage) ?? usage
      if (thinkingMode && delta.reasoning) yield { type: 'thinking', text: delta.reasoning }
      if (delta.text) yield { type: 'token', text: delta.text }
      if (delta.done) break
    }
  } catch (err) {
    throw mapError(err)
  }

  yield { type: 'finish', finishReason: 'stop', usage }
}
