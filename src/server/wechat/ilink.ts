/**
 * 微信 iLink Bot 协议（纯函数版，从 my-vanilla 迁移）。
 * 无状态、无框架依赖，仅使用 Node 18+ 标准库。
 */
import { randomUUID, randomBytes } from 'crypto'

export interface WechatCredentials {
  baseUrl: string
  token: string
}

export interface WeixinMessage {
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  client_id?: string
  message_type?: number
  message_state?: number
  item_list?: Array<{ type: number; text_item?: { text?: string } }>
  context_token?: string
}

export interface WechatPollResult {
  errcode?: number
  ret?: number
  msgs: WeixinMessage[]
  updatesBuf?: string
}

export interface InboundMessage {
  senderId: string
  senderName?: string
  content: string
  conversationId?: string
  channel: 'wechat'
  contextToken?: string
}

export interface ParsedIncoming {
  inbound: InboundMessage
  contextToken?: string
  /** iLink message_id for dedup — same msg may be delivered multiple times */
  messageId?: number
}

export const WECHAT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const DEFAULT_POLL_TIMEOUT_MS = 35_000

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32)).toString('base64')
}

export function buildHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'iLink-App-ClientVersion': '0',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  }
  if (token?.trim()) h['Authorization'] = `Bearer ${token.trim()}`
  return h
}

/** 一次性 getupdates 轮询；不解释 errcode/ret，由调用方决策 */
export async function getUpdates(
  creds: WechatCredentials,
  updatesBuf: string,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
): Promise<WechatPollResult> {
  const res = await fetch(`${creds.baseUrl}/ilink/bot/getupdates`, {
    method: 'POST',
    headers: buildHeaders(creds.token),
    body: JSON.stringify({ get_updates_buf: updatesBuf }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) return { ret: res.status, msgs: [] }

  const data = (await res.json()) as {
    ret?: number
    errcode?: number
    msgs?: WeixinMessage[]
    get_updates_buf?: string
  }
  return {
    errcode: data.errcode,
    ret: data.ret,
    msgs: data.msgs ?? [],
    updatesBuf: data.get_updates_buf,
  }
}

/** 发送文本回复；失败 throw，由调用方决定重试/记录 */
export async function sendMessage(
  creds: WechatCredentials,
  toUserId: string,
  text: string,
  contextToken?: string,
): Promise<void> {
  const msg: WeixinMessage = {
    from_user_id: '', // 必须为空——bot 身份由 Authorization header 确定
    message_type: 2,
    message_state: 2, // FINISH — 缺失会导致服务端不投递
    to_user_id: toUserId,
    item_list: [{ type: 1, text_item: { text } }],
    context_token: contextToken,
    client_id: Array.from(
      Buffer.from(randomUUID().replace(/-/g, '').slice(0, 16), 'hex'),
      (b) => b.toString(16).padStart(2, '0'),
    ).join(''),
  }

  const res = await fetch(`${creds.baseUrl}/ilink/bot/sendmessage`, {
    method: 'POST',
    headers: buildHeaders(creds.token),
    body: JSON.stringify({ msg }), // 不使用 base_info 包裹——与 my-vanilla 参考实现一致
    signal: AbortSignal.timeout(15_000),
  })
  const raw = await res.text()
  const data = (() => { try { return JSON.parse(raw) } catch { return {} } })()

  if (!res.ok || data.ret !== undefined && data.ret !== 0 || data.errcode !== undefined && data.errcode !== 0) {
    throw new Error(
      `[wechat] sendmessage failed: HTTP ${res.status} ret=${data.ret ?? '?'} errcode=${data.errcode ?? '?'} body=${raw.slice(0, 300)}`,
    )
  }

  console.log(`[wechat] sendmessage OK HTTP ${res.status} ret=${data.ret}`)
}

/** 解析入站消息；非文本消息返回 null */
export function parseIncoming(msg: WeixinMessage): ParsedIncoming | null {
  if (msg.message_type !== 1) return null
  const fromUserId = msg.from_user_id || ''
  const text = msg.item_list?.find((i) => i.type === 1)?.text_item?.text || ''
  return {
    inbound: {
      senderId: fromUserId,
      senderName: fromUserId,
      content: text.trim(),
      channel: 'wechat',
    },
    contextToken: msg.context_token,
    messageId: msg.message_id,
  }
}