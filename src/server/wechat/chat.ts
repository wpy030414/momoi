/**
 * WeChat → Momoi 聊天桥接：接收微信文本，路由到 AI 并回复。
 * 不依赖 HTTP 层，直接调用 runPiAgentLoop；避免 cookie 认证问题。
 */
import { db, conversations, messages, wechatSessions, userWechatBindings } from '../db.js'
import { eq, and, sql } from 'drizzle-orm'
import { runPiAgentLoop } from '../ai/pi-adapter.js'
import { sendMessage, WECHAT_BASE_URL, type WechatCredentials } from './ilink.js'
import { randomUUID } from 'crypto'

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

/** Per-user concurrency lock — 防止同一用户的多次 AI 调用交叉执行 */
const locks = new Map<string, Promise<void>>()

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

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  while (locks.has(key)) {
    await locks.get(key)
  }
  const promise = fn()
  locks.set(key, promise.then(
    () => { locks.delete(key) },
    () => { locks.delete(key) },
  ) as unknown as Promise<void>)
  return promise
}

export async function handleWechatMessage(opts: WechatChatOptions): Promise<void> {
  // Dedup before acquiring lock — avoid queuing behind a long AI call for a duplicate
  if (isDuplicate(opts.messageId, Date.now())) {
    console.log(`[wechat-chat] Duplicate message_id=${opts.messageId}, skipping`)
    return
  }
  await withLock(opts.userId, () => handleWechatMessageInner(opts))
}

async function handleWechatMessageInner(opts: WechatChatOptions): Promise<void> {
  const { userId, senderId, text, botToken, contextToken, language } = opts
  const creds: WechatCredentials = { baseUrl: WECHAT_BASE_URL, token: botToken }

  // Resolve bot's own binding record for conversation anchoring and diagnostics
  const binding = await db.select().from(userWechatBindings)
    .where(eq(userWechatBindings.user_id, userId)).get()

  // ---- Built-in commands ----
  if (text === '/clear' || text === '/new' || text === '/reset' || text === '／clear') {
    await db.delete(wechatSessions).where(
      and(eq(wechatSessions.user_id, userId), eq(wechatSessions.wechat_sender_id, senderId)),
    ).run()
    await sendMessage(creds, senderId, '会话已重置。')
    return
  }

  // ---- Find or create session & conversation ----
  let convId = ''
  const session = await db.select().from(wechatSessions).where(
    and(eq(wechatSessions.user_id, userId), eq(wechatSessions.wechat_sender_id, senderId)),
  ).get()

  if (session) {
    convId = session.conversation_id
    // 权威路由目标必须是绑定会话（需求1/3）：若映射指向的会话已被删除，
    // 或该 sender 的映射落在非绑定会话上（迁移残留 / 历史多 sender 映射），
    // 则删除映射并重新锚定到绑定会话。
    const boundConvId = binding?.conversation_id || ''
    const convStillValid = convId && (await db.select().from(conversations)
      .where(and(eq(conversations.id, convId), sql`${conversations.deleted_at} IS NULL`)).get())
    if (!convStillValid || (boundConvId && convId !== boundConvId)) {
      await db.delete(wechatSessions).where(eq(wechatSessions.id, session.id)).run()
      convId = ''
    }
  }

  if (!convId) {
    // ---- 微信 sender 自动转移（需求3） ----
    // 若该 sender 已在其他会话有 wechat_sessions 映射（会话被删后残留，或
    // 重新绑定产生的新映射），先删除旧映射，再建立新绑定。
    // 权威路由目标：user_wechat_bindings.conversation_id（绑定微信的会话）。
    const boundConvId = binding?.conversation_id || ''
    console.log('[wechat-chat] new sender', senderId, 'bound_conv_id:', boundConvId || '(none)')

    if (boundConvId) {
      // 校验绑定会话仍然存在且未被删除
      const existingConv = await db.select().from(conversations)
        .where(and(eq(conversations.id, boundConvId), sql`${conversations.deleted_at} IS NULL`)).get()
      if (existingConv) {
        convId = boundConvId
        // 若该 sender 旧映射指向别处（残留），清除它 —— 确保「一会话一微信」
        await db.delete(wechatSessions).where(
          and(
            eq(wechatSessions.user_id, userId),
            eq(wechatSessions.wechat_sender_id, senderId),
          ),
        ).run()
        console.log('[wechat-chat] anchored to bound conversation:', convId)
      }
    }

    if (!convId) {
      // 无有效绑定 → 提示用户先绑定，不回退到新建会话
      await sendMessage(creds, senderId, '尚未绑定会话，请在网页端选择会话并绑定微信后重试。')
      return
    }

    const now = Math.floor(Date.now() / 1000)
    await db.insert(wechatSessions).values({
      id: randomUUID(), user_id: userId,
      wechat_sender_id: senderId, conversation_id: convId,
      created_at: now,
    }).run()
  }

  // ---- Save user message ----
  const now = Math.floor(Date.now() / 1000)
  await db.insert(messages).values({
    conversation_id: convId, role: 'user',
    content: text, created_at: now,
  }).run()
  await db.update(conversations).set({ updated_at: now }).where(eq(conversations.id, convId)).run()

  // ---- Load conversation for agent anchor ----
  const conv = await db.select().from(conversations).where(eq(conversations.id, convId)).get()
  const agentId = conv?.agent_id || ''

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

  // ---- Run AI ----
  const { reply, suggestions, thinking } = await runPiAgentLoop({
    userMessage: text,
    history,
    send: () => {}, // no-op — 无 SSE 客户端
    thinkingMode: true,
    conversationId: convId,
    userId,
    agentId,
    language,
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
        console.error(`[wechat-chat] Session expired for user ${userId}, marking SESSION_EXPIRED`)
        try {
          await db.update(userWechatBindings)
            .set({ updates_buf: 'SESSION_EXPIRED' })
            .where(eq(userWechatBindings.user_id, userId)).run()
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