/**
 * WeChat → Momoi 聊天桥接：接收微信文本，路由到 AI 并回复。
 * 不依赖 HTTP 层，直接调用 runPiAgentLoop；避免 cookie 认证问题。
 */
import { db, conversations, messages, wechatBindings } from '../../db/index.js'
import { eq, and, sql } from 'drizzle-orm'
import { runPiAgentLoop } from '../../ai/pi-adapter.js'
import { sendMessage, WECHAT_BASE_URL, type WechatCredentials } from './ilink.js'
import { broadcastStream, broadcastConversationChanged, broadcastConversationSync, broadcastUnreadUpdate } from '../../lib/realtime.js'
import { countUnread } from '../../lib/unread.js'
import { withUserImLock } from '../locks.js'

export interface WechatChatOptions {
  userId: string
  senderId: string
  text: string
  botToken: string
  contextToken?: string
  language?: string
  /** iLink message_id for dedup — same msg may be delivered multiple times */
  messageId?: number
}

/** Dedup cache: message_id → timestamp, evicted after 5 minutes */
const dedupCache = new Map<number, number>()
const DEDUP_WINDOW_MS = 5 * 60_000

function isDuplicate(messageId: number | undefined, now: number): boolean {
  if (messageId === undefined) return false // legacy or non-id messages pass through
  // Evict stale entries
  for (const [id, ts] of dedupCache) {
    if (now - ts > DEDUP_WINDOW_MS) dedupCache.delete(id)
  }
  if (dedupCache.has(messageId)) return true
  dedupCache.set(messageId, now)
  return false
}

export async function handleWechatMessage(opts: WechatChatOptions): Promise<void> {
  // Dedup before acquiring lock — avoid queuing behind a long AI call for a duplicate
  if (isDuplicate(opts.messageId, Date.now())) {
    console.log(`[wechat-chat] Duplicate message_id=${opts.messageId}, skipping`)
    return
  }
  await withUserImLock(opts.userId, () => handleWechatMessageInner(opts))
}

async function handleWechatMessageInner(opts: WechatChatOptions): Promise<void> {
  const { userId, senderId, text, botToken, contextToken, language } = opts
  const creds: WechatCredentials = { baseUrl: WECHAT_BASE_URL, token: botToken }

  const NOT_BOUND_HINT = '尚未绑定会话，请在网页端选择会话并绑定微信后重试。'

  // 绑定行即路由权威：sender 合法性与目标会话都在这一行里
  const binding = await db.select().from(wechatBindings)
    .where(eq(wechatBindings.user_id, userId)).get()
  if (!binding || !binding.conversation_id) {
    await sendMessage(creds, senderId, NOT_BOUND_HINT)
    return
  }

  // Sender 校验：扫码生成的 bot 通道是用户专属 1v1 通道，合法 sender 即扫码者本人
  if (binding.wechat_user_id && senderId !== binding.wechat_user_id) {
    console.log(`[wechat-chat] Ignoring unknown sender ${senderId} for user ${userId}`)
    return
  }

  // ---- Built-in commands ----
  if (text === '/clear' || text === '/new' || text === '/reset' || text === '／clear') {
    await sendMessage(creds, senderId, '会话已重置。')
    return
  }

  // ---- Route to the anchored conversation (must still be alive) ----
  const convId = binding.conversation_id
  const conv = await db.select().from(conversations)
    .where(and(eq(conversations.id, convId), sql`${conversations.deleted_at} IS NULL`)).get()
  if (!conv) {
    await sendMessage(creds, senderId, NOT_BOUND_HINT)
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
  // WeChat 来源无 device_id，跳过设备 ID 为空字符串 → 所有订阅设备均收到
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
    created_at: m.created_at,
  }))

  // 计算 Agent 上次发言时间
  const lastWechatMsg = historyMsgs.slice(0, -1)
    .filter((m: any) => m.role === 'assistant' && m.agent_id === agentId)
    .at(-1)
  const lastMessageAt = lastWechatMsg?.created_at

  // ---- Run AI (with realtime broadcast to other devices) ----
  // send 回调同时承担两个职责：
  //   1. 将流事件实时中继到同账号其他设备（网页端 SSE 通道）
  //   2. 收集完整回复用于后续落库（reply / thinking / suggestions 仍由
  //      runPiAgentLoop 返回，此处仅广播）
  const { reply, suggestions, thinking } = await runPiAgentLoop({
    userMessage: text,
    history,
    send: (msg) => {
      // 实时中继到网页端：每个 token / thinking / tool_call / done 事件都广播
      broadcastStream(userId, '', { conversation_id: convId, event: msg })
    },
    thinkingMode: true,
    conversationId: convId,
    userId,
    agentId,
    language,
    lastMessageAt,
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
    // 未读广播：web 端侧边栏红点实时点亮（与 web 聊天路径对齐）
    broadcastUnreadUpdate(userId, convId, await countUnread(convId))
  }

  // ---- Realtime: 会话内容落库完毕，通知其他设备对齐（兜底重拉）----
  broadcastConversationChanged(userId, convId)
  // 侧边栏最后一条消息预览 + 时间戳也需刷新
  broadcastConversationSync(userId)

  // ---- Send reply via iLink with retry ----
  console.log('[wechat-chat] Sending reply: toUserId=', senderId,
    'hasContextToken=', !!contextToken,
    'textLen=', replyText.length)

  let sendOk = false
  const MAX_RETRIES = 3
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await sendMessage(creds, senderId, replyText, contextToken)
      sendOk = true
      break
    } catch (e) {
      const err = e as Error
      const isSessionExpired = err.message.includes('errcode=-14') || err.message.includes('session timeout')
      const isTransient = err.message.includes('HTTP 5') ||
        err.message.includes('fetch failed') ||
        err.message.includes('timeout') ||
        err.message.includes('ETIMEDOUT') ||
        err.message.includes('ECONNRESET')

      // Session expired — mark in DB, don't retry
      if (isSessionExpired) {
        console.error(`[wechat-chat] Session expired for user ${userId}, marking session_expired`)
        try {
          await db.update(wechatBindings)
            .set({ session_expired: true })
            .where(eq(wechatBindings.user_id, userId)).run()
        } catch (_) { /* best-effort */ }
        break
      }

      if (attempt < MAX_RETRIES - 1 && isTransient) {
        const delay = Math.pow(2, attempt) * 1000 // 1s, 2s, 4s
        console.warn(`[wechat-chat] sendMessage attempt ${attempt + 1} failed, retrying in ${delay}ms:`, err.message)
        await new Promise(r => setTimeout(r, delay))
      } else {
        console.error(`[wechat-chat] sendMessage failed after ${attempt + 1} attempt(s):`, {
          message: err.message,
          toUserId: senderId,
          hasContextToken: !!contextToken,
          textPreview: replyText.slice(0, 100),
        })
        break
      }
    }
  }

  if (!sendOk) {
    // Insert a visible system message so the user knows WeChat delivery failed
    try {
      const failNow = Math.floor(Date.now() / 1000)
      await db.insert(messages).values({
        conversation_id: convId,
        role: 'system',
        content: `[WeChat推送失败] 回复已生成但未能发送到微信。请尝试重新绑定微信。`,
        agent_id: agentId || null,
        created_at: failNow,
      }).run()
    } catch (dbErr) {
      console.error('[wechat-chat] Failed to write delivery-failure marker:', (dbErr as Error).message)
    }
  }
}