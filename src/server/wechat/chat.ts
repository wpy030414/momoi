/**
 * WeChat → Momoi 聊天桥接：接收微信文本，路由到 AI 并回复。
 * 不依赖 HTTP 层，直接调用 runPiAgentLoop；避免 cookie 认证问题。
 */
import { db, conversations, messages, wechatSessions, userWechatBindings } from '../db.js'
import { eq, and } from 'drizzle-orm'
import { runPiAgentLoop } from '../ai/pi-adapter.js'
import { listAgents } from '../config.js'
import { sendMessage, WECHAT_BASE_URL, type WechatCredentials } from './ilink.js'
import { randomUUID } from 'crypto'

export interface WechatChatOptions {
  userId: string
  senderId: string
  text: string
  botToken: string
  contextToken?: string
  language?: string
}

/** Per-user concurrency lock — 防止同一用户的多次 AI 调用交叉执行 */
const locks = new Map<string, Promise<void>>()

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
  await withLock(opts.userId, () => handleWechatMessageInner(opts))
}

async function handleWechatMessageInner(opts: WechatChatOptions): Promise<void> {
  const { userId, senderId, text, botToken, contextToken, language } = opts
  const creds: WechatCredentials = { baseUrl: WECHAT_BASE_URL, token: botToken }

  // Resolve bot's own WeChat user ID for from_user_id in outbound messages
  const binding = await db.select().from(userWechatBindings)
    .where(eq(userWechatBindings.user_id, userId)).get()
  const fromUserId = binding?.ilink_user_id || ''

  // ---- Built-in commands ----
  if (text === '/clear' || text === '/new' || text === '/reset' || text === '／clear') {
    await db.delete(wechatSessions).where(
      and(eq(wechatSessions.user_id, userId), eq(wechatSessions.wechat_sender_id, senderId)),
    ).run()
    await sendMessage(creds, senderId, '会话已重置。', fromUserId)
    return
  }

  // ---- Find or create session & conversation ----
  let convId = ''
  const session = await db.select().from(wechatSessions).where(
    and(eq(wechatSessions.user_id, userId), eq(wechatSessions.wechat_sender_id, senderId)),
  ).get()

  if (session) {
    convId = session.conversation_id
  } else {
    // Check if user had a pending conversation anchor (set when QR was scanned)
    const pendingConvId = binding?.pending_conv_id
    console.log('[wechat-chat] new sender', senderId, 'pending_conv_id:', pendingConvId || '(none)')

    if (pendingConvId) {
      const existingConv = await db.select().from(conversations)
        .where(eq(conversations.id, pendingConvId)).get()
      if (existingConv) {
        convId = pendingConvId
        console.log('[wechat-chat] anchored to existing conversation:', convId)
        await db.update(userWechatBindings)
          .set({ pending_conv_id: '' })
          .where(eq(userWechatBindings.user_id, userId)).run()
      }
    }

    if (!convId) {
      convId = randomUUID()
      const now = Math.floor(Date.now() / 1000)
      const agents = await listAgents()
      const agentId = agents.find((a) => a.role !== 'neutral')?.id || agents[0]?.id || ''
      const title = text.slice(0, 40) || 'New Chat'
      await db.insert(conversations).values({
        id: convId, user_id: userId, title,
        agent_id: agentId, type: 'direct',
        created_at: now, updated_at: now,
      }).run()
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
    thinkingMode: false,
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

  // ---- Send reply via iLink ----
  try {
    await sendMessage(creds, senderId, replyText, fromUserId, contextToken)
  } catch (e) {
    console.error(`[wechat-chat] Failed to send reply to ${senderId}:`, (e as Error).message)
  }
}