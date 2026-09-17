/**
 * QQ → Momoi 聊天桥接：接收 QQ C2C 文本，路由到 AI 并以 C2C 流式（打字机）回复。
 * 不依赖 HTTP 层，直接调用 runPiAgentLoop；与 wechat/chat.ts 同构，
 * 差异在回发链路（流式帧 + sendText 降级）与新鲜度守卫（app_id 比对）。
 */
import { db, conversations, messages, qqBindings } from '../db.js'
import { eq, and, sql } from 'drizzle-orm'
import { runPiAgentLoop } from '../ai/pi-adapter.js'
import { broadcastStream, broadcastConversationChanged, broadcastConversationSync } from '../realtime.js'
import { withUserImLock } from '../im/locks.js'
import { SUGGESTIONS_FENCE } from '../../shared/constants.js'
import {
  sendC2CText, sendStreamFrame, getNextMsgSeq, isQqRateLimitError,
  type QqCredentials, type QqStreamFrameRequest,
} from './api.js'

export interface QqChatOptions {
  userId: string
  /** 接收到该消息的连接的 appId —— 换凭证后在飞消息的新鲜度守卫 */
  appId: string
  openid: string
  /** 入站消息 id —— 被动回复 msg_id / 流式 event_id */
  msgId: string
  text: string
  /** QQ message id for dedup —— RESUME 边界可能重复投递 */
  messageId: string
}

/** Dedup cache: message_id → timestamp, evicted after 5 minutes */
const dedupCache = new Map<string, number>()
const DEDUP_WINDOW_MS = 5 * 60_000

function isDuplicate(messageId: string, now: number): boolean {
  if (!messageId) return false
  // Evict stale entries
  for (const [id, ts] of dedupCache) {
    if (now - ts > DEDUP_WINDOW_MS) dedupCache.delete(id)
  }
  if (dedupCache.has(messageId)) return true
  dedupCache.set(messageId, now)
  return false
}

export async function handleQqMessage(opts: QqChatOptions): Promise<void> {
  // Dedup before acquiring lock — avoid queuing behind a long AI call for a duplicate
  if (isDuplicate(opts.messageId, Date.now())) {
    console.log(`[qq-chat] Duplicate message_id=${opts.messageId}, skipping`)
    return
  }
  await withUserImLock(opts.userId, () => handleQqMessageInner(opts))
}

/** QQ 单条消息文本上限约 5000 字符，超长分片发送（保守取 4000） */
const TEXT_CHUNK_LIMIT = 4000

function chunkText(text: string, limit = TEXT_CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit))
  return chunks
}

/** 全文一次性回复（流式降级 / 提示文案共用）；瞬时错误退避重试 */
async function sendTextWithRetry(
  creds: QqCredentials, openid: string, msgId: string, text: string,
): Promise<boolean> {
  const chunks = chunkText(text)
  for (const chunk of chunks) {
    let sent = false
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await sendC2CText(creds, openid, { msgId, content: chunk })
        sent = true
        break
      } catch (e) {
        const err = e as Error
        const isTransient = err.message.includes('HTTP 5') ||
          err.message.includes('fetch failed') ||
          err.message.includes('timeout') ||
          err.message.includes('ETIMEDOUT') ||
          err.message.includes('ECONNRESET')
        if (attempt < 2 && isTransient) {
          await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
        } else {
          console.error(`[qq-chat] sendText failed after ${attempt + 1} attempt(s):`, err.message)
          break
        }
      }
    }
    if (!sent) return false
  }
  return true
}

async function handleQqMessageInner(opts: QqChatOptions): Promise<void> {
  const { userId, appId, openid, msgId, text } = opts

  const NOT_BOUND_HINT = '尚未绑定会话，请在网页端选择会话并绑定 QQ 后重试。'

  // 绑定行即路由权威。新鲜度守卫：行不存在或凭证已换（app_id 不符），
  // 说明这是旧连接的在飞消息 —— 静默丢弃，不得污染新绑定。
  const binding = await db.select().from(qqBindings)
    .where(eq(qqBindings.user_id, userId)).get()
  if (!binding || binding.app_id.trim() !== appId) {
    console.log(`[qq-chat] Stale message for user ${userId} (appId mismatch), dropping`)
    return
  }
  const creds: QqCredentials = { appId: binding.app_id.trim(), appSecret: binding.app_secret }

  if (!binding.conversation_id) {
    await sendC2CText(creds, openid, { msgId, content: NOT_BOUND_HINT }).catch(() => {})
    return
  }

  // ---- Built-in commands ----
  if (text === '/clear' || text === '/new' || text === '/reset' || text === '／clear') {
    await sendC2CText(creds, openid, { msgId, content: '会话已重置。' }).catch(() => {})
    return
  }

  // ---- Route to the anchored conversation (must still be alive) ----
  const convId = binding.conversation_id
  const conv = await db.select().from(conversations)
    .where(and(eq(conversations.id, convId), sql`${conversations.deleted_at} IS NULL`)).get()
  if (!conv) {
    await sendC2CText(creds, openid, { msgId, content: NOT_BOUND_HINT }).catch(() => {})
    return
  }

  // ---- Save user message ----
  const now = Math.floor(Date.now() / 1000)
  const userMsgResult = await db.insert(messages).values({
    conversation_id: convId, role: 'user',
    content: text, created_at: now,
  }).returning({ id: messages.id })
  const userMsgId = Number(userMsgResult[0]?.id ?? 0)
  await db.update(conversations).set({ updated_at: now }).where(eq(conversations.id, convId)).run()

  // ---- Realtime: 通知同账号其他设备（网页端等）有新用户消息 ----
  broadcastStream(userId, '', {
    conversation_id: convId,
    event: { type: 'user_message', id: userMsgId, content: text },
  })

  // Agent anchor: derived from the conversation loaded during route validation
  const agentId = conv.agent_id || ''

  // ---- Load history ----
  const historyMsgs = await db.select().from(messages)
    .where(eq(messages.conversation_id, convId))
    .orderBy(messages.created_at).all()
  const history = historyMsgs.slice(0, -1).map((m: any) => ({
    role: m.role as any,
    content: m.content,
    tool_calls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
    tool_call_id: m.tool_call_id || undefined,
    agent_id: m.agent_id || null,
  }))

  // ---- Run AI (stream to QQ + realtime broadcast to other devices) ----
  // send 回调承担两个职责：
  //   1. 将流事件实时中继到同账号其他设备（网页端 SSE 通道）
  //   2. text token 喂给 QqStreamSender —— QQ 端打字机流式呈现
  const streamer = new QqStreamSender(creds, openid, msgId)
  const { reply, suggestions, thinking } = await runPiAgentLoop({
    userMessage: text,
    history,
    send: (msg) => {
      broadcastStream(userId, '', { conversation_id: convId, event: msg })
      if ((msg as any).type === 'token' && (msg as any).text) {
        streamer.onToken((msg as any).text as string)
      }
    },
    thinkingMode: true,
    conversationId: convId,
    userId,
    agentId,
  })

  // ---- Save assistant message ----
  const replyText = reply || '（未生成回复）'
  if (replyText.trim()) {
    const replyNow = Math.floor(Date.now() / 1000)
    await db.insert(messages).values({
      conversation_id: convId,
      role: 'assistant',
      content: replyText,
      thinking: thinking || null,
      suggestions: suggestions.length > 0 ? JSON.stringify(suggestions) : null,
      agent_id: agentId || null,
      created_at: replyNow,
    }).run()
  }

  // ---- Realtime: 会话内容落库完毕，通知其他设备对齐（兜底重拉）----
  broadcastConversationChanged(userId, convId)
  // 侧边栏最后一条消息预览 + 时间戳也需刷新
  broadcastConversationSync(userId)

  // ---- Deliver reply to QQ: 流式收口，失败降级一次性发送 ----
  console.log('[qq-chat] Delivering reply: openid=', openid,
    'msgId=', msgId, 'textLen=', replyText.length)

  let sendOk = false
  if (replyText.trim()) {
    sendOk = await streamer.complete(replyText)
    if (!sendOk) {
      sendOk = await sendTextWithRetry(creds, openid, msgId, replyText)
    }
  }

  if (!sendOk) {
    // Insert a visible system message so the user knows QQ delivery failed
    try {
      const failNow = Math.floor(Date.now() / 1000)
      await db.insert(messages).values({
        conversation_id: convId,
        role: 'system',
        content: `[QQ推送失败] 回复已生成但未能发送到 QQ。请检查机器人状态或重新绑定。`,
        agent_id: agentId || null,
        created_at: failNow,
      }).run()
    } catch (dbErr) {
      console.error('[qq-chat] Failed to write delivery-failure marker:', (dbErr as Error).message)
    }
  }
}

// ---- QqStreamSender：runPiAgentLoop 流事件 → QQ stream_messages 帧序列 ----

const STREAM_THROTTLE_MS = 800
const STREAM_MAX_RETRIES = 3

/**
 * QQ C2C 流式发送器（协议要点）：
 * - replace 语义：每帧携带全量文本；同一流共用同一 msg_seq，仅 index 递增
 * - input_state: 1=GENERATING（中间帧）、10=DONE（终帧）
 * - 懒开启：首个 token 才发首帧；频控（HTTP 429 / err_code 50002）退避重试
 * - suggestions 围栏截断：累积文本出现围栏即停止追加（终态 reply 已剥离围栏）
 * - 任何失败（重试耗尽/非频控错误）置 broken —— 后续仅累积，complete 返回
 *   false 由调用方降级 sendText 全文
 */
class QqStreamSender {
  private creds: QqCredentials
  private openid: string
  private msgId: string
  private throttleMs: number

  private streamMsgId?: string
  private index = 0
  private msgSeq: number | null = null
  private lastFlushAt = 0
  private lastSentText = ''
  private pendingText = ''
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private flushInProgress = false
  private flushPromise: Promise<void> | null = null
  private isCompleted = false
  private broken = false
  private fenced = false

  constructor(creds: QqCredentials, openid: string, msgId: string, throttleMs = STREAM_THROTTLE_MS) {
    this.creds = creds
    this.openid = openid
    this.msgId = msgId
    this.throttleMs = throttleMs
  }

  /** 喂入 text token 增量；同步非阻塞（帧发送在节流定时器里异步进行） */
  onToken(delta: string): void {
    if (this.isCompleted || this.fenced) return
    const next = this.pendingText + delta
    const fenceIdx = next.indexOf(SUGGESTIONS_FENCE)
    if (fenceIdx >= 0) {
      this.pendingText = next.slice(0, fenceIdx)
      this.fenced = true
    } else {
      this.pendingText = next
    }
    if (this.broken) return
    this.scheduleFlush()
  }

  /**
   * 收口：发送 DONE 终帧。返回 true = 已通过流式送达；
   * false = 流式链路已坏，调用方应降级 sendText 全文。
   */
  async complete(finalText: string): Promise<boolean> {
    if (this.isCompleted) return !this.broken && this.lastSentText !== ''
    this.isCompleted = true
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
    // 等待在飞帧结束（含其退避重试），避免 DONE 帧与其交错
    if (this.flushPromise) {
      await this.flushPromise.catch(() => {})
    }
    if (this.broken) return false
    try {
      await this.doFlush(10, finalText)
      return true
    } catch (err) {
      console.error('[qq-stream] DONE frame failed:', (err as Error).message)
      return false
    }
  }

  // ---- Internal ----

  private scheduleFlush(): void {
    if (this.isCompleted || this.broken || this.flushInProgress || this.pendingTimer) return
    if (this.pendingText === this.lastSentText) return
    const wait = Math.max(0, this.throttleMs - (Date.now() - this.lastFlushAt))
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      this.flushNow(1)
    }, wait)
  }

  private flushNow(state: 1 | 10): void {
    if (this.isCompleted || this.broken || this.flushInProgress) return
    if (state === 1 && this.pendingText === this.lastSentText) return
    this.flushInProgress = true
    const promise = this.doFlush(state, this.pendingText)
      .catch((err) => {
        this.broken = true
        console.error('[qq-stream] flush failed, falling back to sendText:', (err as Error).message)
      })
      .finally(() => {
        this.flushInProgress = false
        // Trailing flush: 文本在在飞帧期间又增长了 —— 补一帧
        if (!this.isCompleted && !this.broken && !this.pendingTimer &&
            this.pendingText !== this.lastSentText) {
          this.scheduleFlush()
        }
      })
    this.flushPromise = promise
  }

  private async doFlush(state: 1 | 10, text: string): Promise<void> {
    if (this.msgSeq === null) this.msgSeq = getNextMsgSeq()
    const req: QqStreamFrameRequest = {
      input_mode: 'replace',
      input_state: state,
      content_type: 'markdown',
      content_raw: text,
      event_id: this.msgId,
      msg_id: this.msgId,
      msg_seq: this.msgSeq,
      index: this.index,
    }
    if (this.streamMsgId) req.stream_msg_id = this.streamMsgId

    for (let attempt = 0; ; attempt++) {
      try {
        const resp = await sendStreamFrame(this.creds, this.openid, req)
        if (resp?.id && !this.streamMsgId) this.streamMsgId = resp.id
        this.lastSentText = text
        this.lastFlushAt = Date.now()
        return
      } catch (err) {
        // 频控错误：指数退避重试且 index 前进，避免陈旧 index 冲突
        if (attempt >= STREAM_MAX_RETRIES || !isQqRateLimitError(err)) throw err
        console.warn(`[qq-stream] rate limited, retry ${attempt + 1}/${STREAM_MAX_RETRIES}`)
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000))
        req.index = ++this.index
      }
    }
  }
}
