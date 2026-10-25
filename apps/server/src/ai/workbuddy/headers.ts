/**
 * WorkBuddy 网关要求的客户端身份头。
 *
 * 对话转发与模型目录拉取共用同一组身份头：对话额外带流式 Accept 与会话链路头，
 * 目录请求只需要身份头 + JSON Accept。
 */

import crypto from 'node:crypto'
import { workbuddyConfig as cfg } from './config.js'
import type { WorkBuddyCredential } from './credentials.js'

function traceHeaders(): Record<string, string> {
  const traceId = crypto.randomBytes(16).toString('hex')
  const spanId = crypto.randomBytes(8).toString('hex')
  return {
    'traceparent': `00-${traceId}-${spanId}-01`,
    'b3': `${traceId}-${spanId}-1-${crypto.randomBytes(8).toString('hex')}`,
    'X-B3-TraceId': traceId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',
  }
}

export interface GatewayHeaderOptions {
  /** 期望的响应类型（对话为 text/event-stream，目录为 application/json） */
  accept?: string
  /** 携带对话会话链路头（X-Conversation-* / X-Agent-*） */
  conversation?: boolean
}

/** 网关要求的客户端身份头 + 链路头 */
export function gatewayHeaders(
  credential: WorkBuddyCredential,
  opts: GatewayHeaderOptions = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Content-Type': 'application/json',
    'Accept': opts.accept ?? 'application/json',
    'Accept-Encoding': 'identity',
    'X-Product': cfg.product,
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': cfg.ideVersion,
    'X-Private-Data': 'true',
    'User-Agent': `WorkBuddy/${cfg.ideVersion}`,
    'X-Domain': credential.domain || cfg.domain,
    'x-requested-with': 'XMLHttpRequest',
    ...traceHeaders(),
  }
  if (credential.uid) headers['X-User-Id'] = credential.uid
  if (opts.conversation) {
    headers['X-Conversation-ID'] = crypto.randomUUID()
    headers['X-Conversation-Request-ID'] = crypto.randomUUID()
    headers['X-Conversation-Message-ID'] = crypto.randomUUID()
    headers['X-Request-ID'] = crypto.randomUUID()
    headers['acp-connection-id'] = crypto.randomUUID()
    headers['X-Agent-Intent'] = 'craft'
    headers['X-Agent-Purpose'] = 'conversation'
    headers['x-codebuddy-request'] = '1'
  }
  return headers
}
