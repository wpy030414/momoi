/**
 * QQ → Momoi 聊天桥接：接收 QQ C2C / 群聊文本，路由到 AI 并以单次发送回复。
 * 不依赖 HTTP 层，直接调用 runPiAgentLoop；与 wechat/chat.ts 同构。
 * 回发：C2C 与群聊均一次性发送（sendTextWithRetry，3 次重试 + 超长分片）。
 */
import { db, conversations, messages, qqBindings } from '../db.js'
import { eq, and, sql } from 'drizzle-orm'
import { runPiAgentLoop } from '../ai/pi-adapter.js'
import { broadcastStream, broadcastConversationChanged, broadcastConversationSync } from '../realtime.js'
import { withUserImLock } from '../im/locks.js'
import { sendC2CText, type QqCredentials } from './api.js'

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

  // ---- Run AI (broadcast to web clients; no QQ streaming — send full text on completion) ----
  // send 回调仅承担实时中继到同账号其他设备（网页端 SSE 通道）
  const { reply, suggestions, thinking } = await runPiAgentLoop({
    userMessage: text,
    history,
    send: (msg) => {
      broadcastStream(userId, '', { conversation_id: convId, event: msg })
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

  // ---- Deliver reply to QQ: single-shot send (no streaming for C2C or groups) ----
  console.log('[qq-chat] Delivering reply: openid=', openid,
    'msgId=', msgId, 'textLen=', replyText.length)

  let sendOk = false
  if (replyText.trim()) {
    sendOk = await sendTextWithRetry(creds, openid, msgId, replyText)
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

