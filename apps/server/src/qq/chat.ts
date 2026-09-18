/**
 * QQ → Momoi 聊天桥接：接收 QQ C2C / 群聊文本，路由到 AI 并以单次发送回复。
 * 不依赖 HTTP 层，直接调用 runPiAgentLoop；与 wechat/chat.ts 同构。
 * 回发：C2C 与群聊均一次性发送（sendTextWithRetry，3 次重试 + 超长分片）。
 */
import { db, conversations, messages, qqBindings, qqGroupConversations, groupConversationAgents } from '../db.js'
import { eq, and, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { runPiAgentLoop } from '../ai/pi-adapter.js'
import { broadcastStream, broadcastConversationChanged, broadcastConversationSync } from '../realtime.js'
import { withUserImLock } from '../im/locks.js'
import { sendC2CText, sendGroupText, type QqCredentials } from './api.js'
import { listAgents } from '../config.js'
import { NEUTRAL_AGENT_ID } from '@momoi/shared/constants'

export interface QqChatOptions {
  userId: string
  /** 该连接所属的 Agent ID —— per-agent 绑定路由权威 */
  agentId: string
  /** 接收到该消息的连接的 appId —— 换凭证后在飞消息的新鲜度守卫 */
  appId: string
  openid: string
  /** 入站消息 id —— 被动回复 msg_id */
  msgId: string
  text: string
  /** QQ message id for dedup —— RESUME 边界可能重复投递 */
  messageId: string
}

export interface QqGroupChatOptions {
  userId: string
  /** 该连接所属的 Agent ID —— per-agent 绑定路由权威 */
  agentId: string
  appId: string
  groupOpenid: string
  authorOpenid: string
  authorUsername: string
  text: string
  messageId: string
  /** 入站群消息 id —— 被动回复 msg_id（窗口 5 分钟） */
  msgId: string
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
  await withUserImLock(`${opts.userId}:${opts.agentId}`, () => handleQqMessageInner(opts))
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
  const { userId, agentId, appId, openid, msgId, text } = opts

  const NOT_BOUND_HINT = '尚未绑定会话，请在网页端选择会话并绑定 QQ 后重试。'

  // 绑定行即路由权威。新鲜度守卫：行不存在或凭证已换（app_id 不符），
  // 说明这是旧连接的在飞消息 —— 静默丢弃，不得污染新绑定。
  const binding = await db.select().from(qqBindings)
    .where(and(
      eq(qqBindings.user_id, userId),
      eq(qqBindings.agent_id, agentId),
    )).get()
  if (!binding || binding.app_id.trim() !== appId) {
    console.log(`[qq-chat] Stale message for user ${userId} agent ${agentId} (appId mismatch), dropping`)
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

  // Agent anchor: from the binding's agent (already destructured from opts)

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

// ---- QQ 群聊消息处理 ----

/** 封装 sendGroupText 的带退避群发（群消息无流式，全程单次发送） */
async function sendGroupTextWithRetry(
  creds: QqCredentials, groupOpenid: string, msgId: string, text: string,
): Promise<boolean> {
  const chunks = chunkText(text)
  for (const chunk of chunks) {
    let sent = false
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await sendGroupText(creds, groupOpenid, { msgId, content: chunk })
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
        } else if (attempt === 2 || !isTransient) {
          // 最后一搏：不带 msgId 重试（被动回复窗口可能已过期）
          try {
            await sendGroupText(creds, groupOpenid, { content: chunk })
            sent = true
          } catch { /* 彻底失败 */ }
        } else {
          console.error(`[qq-group-chat] sendGroupText failed after ${attempt + 1} attempt(s):`, err.message)
          break
        }
      }
    }
    if (!sent) return false
  }
  return true
}

/** 为 QQ 群自动查找或创建群组会话（lazy init）。
 *  每个 Bot 独立会话，按 (app_id, group_openid) 归并。 */
async function resolveGroupConversation(
  userId: string, appId: string, groupOpenid: string, agentId: string,
): Promise<string | null> {
  // 1. 已有映射且会话未软删 → 直接复用
  const existing = await db.select().from(qqGroupConversations)
    .where(and(
      eq(qqGroupConversations.app_id, appId),
      eq(qqGroupConversations.group_openid, groupOpenid),
    )).get()
  if (existing) {
    const conv = await db.select().from(conversations)
      .where(and(eq(conversations.id, existing.conversation_id), sql`${conversations.deleted_at} IS NULL`))
      .get()
    if (conv) {
      // 确保该 Agent 在成员列表中（补漏：首次创建时可能未添加）
      try {
        await db.insert(groupConversationAgents).values({
          conversation_id: conv.id, agent_id: agentId, sort_order: 0,
        }).run()
      } catch { /* already exists */ }
      return conv.id
    }
    // 会话已软删 → 清理旧映射，重新创建
    await db.delete(qqGroupConversations)
      .where(and(
        eq(qqGroupConversations.app_id, appId),
        eq(qqGroupConversations.group_openid, groupOpenid),
      )).run()
  }

  // 2. Agent 由 binding 直接提供
  if (!agentId) {
    const agents = await listAgents()
    const defaultAgent = agents.find((a) => a.id !== NEUTRAL_AGENT_ID)
    if (!defaultAgent) {
      console.error('[qq-group-chat] No non-neutral agent found, cannot create group conversation')
      return null
    }
    agentId = defaultAgent.id
  }

  // 3. 创建群组会话（只添加当前收消息的 Agent）
  const convId = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  await db.insert(conversations).values({
    id: convId,
    user_id: userId,
    title: 'QQ群聊',
    agent_id: agentId,
    type: 'group',
    created_at: now,
    updated_at: now,
  }).run()
  await db.insert(groupConversationAgents).values({
    conversation_id: convId, agent_id: agentId, sort_order: 0,
  }).run()
  await db.insert(qqGroupConversations).values({
    app_id: appId,
    group_openid: groupOpenid,
    conversation_id: convId,
    created_at: now,
  }).run()

  broadcastConversationSync(userId)
  console.log(`[qq-group-chat] Created group conversation ${convId} for app=${appId} group=${groupOpenid}`)
  return convId
}

export async function handleQqGroupMessage(opts: QqGroupChatOptions): Promise<void> {
  if (isDuplicate(opts.messageId, Date.now())) {
    console.log(`[qq-group-chat] Duplicate message_id=${opts.messageId}, skipping`)
    return
  }
  await withUserImLock(`${opts.userId}:${opts.groupOpenid}`, () => handleQqGroupMessageInner(opts))
}

async function handleQqGroupMessageInner(opts: QqGroupChatOptions): Promise<void> {
  const { userId, agentId, appId, groupOpenid, authorOpenid, authorUsername, text, msgId } = opts

  // 新鲜度守卫：绑定行必须存在、凭证未换、且 group_enabled 已开
  const binding = await db.select().from(qqBindings)
    .where(and(
      eq(qqBindings.user_id, userId),
      eq(qqBindings.agent_id, agentId),
    )).get()
  if (!binding || binding.app_id.trim() !== appId || !binding.group_enabled) {
    console.log(`[qq-group-chat] Group message dropped: binding stale or group disabled for user ${userId} agent ${agentId}`)
    return
  }
  const creds: QqCredentials = { appId: binding.app_id.trim(), appSecret: binding.app_secret }

  // 内置命令
  if (text === '/clear' || text === '/new' || text === '/reset' || text === '／clear') {
    await sendGroupText(creds, groupOpenid, { msgId, content: '会话已重置。' }).catch(() => {})
    return
  }

  // 查找或创建群组会话（Agent 由 binding 直接提供）
  const convId = await resolveGroupConversation(userId, appId, groupOpenid, agentId)
  if (!convId) {
    await sendGroupText(creds, groupOpenid, { msgId, content: '创建群聊会话失败，请联系管理员。' }).catch(() => {})
    return
  }

  const conv = await db.select().from(conversations)
    .where(and(eq(conversations.id, convId), sql`${conversations.deleted_at} IS NULL`)).get()
  if (!conv) {
    await sendGroupText(creds, groupOpenid, { msgId, content: '群聊会话已不存在。' }).catch(() => {})
    return
  }

  // 写用户消息（[昵称]: 内容 格式）
  const now = Math.floor(Date.now() / 1000)
  const displayContent = `[${authorUsername}]: ${text}`
  const userMsgResult = await db.insert(messages).values({
    conversation_id: convId, role: 'user',
    content: displayContent, created_at: now,
  }).returning({ id: messages.id })
  const userMsgId = Number(userMsgResult[0]?.id ?? 0)
  await db.update(conversations).set({ updated_at: now }).where(eq(conversations.id, convId)).run()

  broadcastStream(userId, '', {
    conversation_id: convId,
    event: { type: 'user_message', id: userMsgId, content: displayContent },
  })

  // Agent anchor: from opts (already destructured above)

  // 加载历史
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

  // 跑 AI（send 回调仅 broadcastStream，QQ 群不支持流式回发）
  const { reply, suggestions, thinking } = await runPiAgentLoop({
    userMessage: displayContent,
    history,
    send: (msg) => {
      broadcastStream(userId, '', { conversation_id: convId, event: msg })
    },
    thinkingMode: true,
    conversationId: convId,
    userId,
    agentId,
    isGroup: true,
    isQqGroup: true,
  })

  // 写 assistant 消息
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

  broadcastConversationChanged(userId, convId)
  broadcastConversationSync(userId)

  // 回发群消息
  console.log('[qq-group-chat] Delivering group reply: groupOpenid=', groupOpenid,
    'msgId=', msgId, 'textLen=', replyText.length)

  let sendOk = false
  if (replyText.trim()) {
    sendOk = await sendGroupTextWithRetry(creds, groupOpenid, msgId, replyText)
  }

  if (!sendOk) {
    try {
      const failNow = Math.floor(Date.now() / 1000)
      await db.insert(messages).values({
        conversation_id: convId,
        role: 'system',
        content: `[QQ群推送失败] 回复已生成但未能发送到 QQ 群。`,
        agent_id: agentId || null,
        created_at: failNow,
      }).run()
    } catch (dbErr) {
      console.error('[qq-group-chat] Failed to write delivery-failure marker:', (dbErr as Error).message)
    }
  }
}

