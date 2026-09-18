import { Hono } from 'hono'
import { db, conversations, messages, groupConversationAgents, agents, wechatBindings, qqBindings, qqGroupConversations } from '../db.js'
import { eq, and, desc, gte, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { NEUTRAL_AGENT_ID } from '@momoi/shared/constants'
import { broadcastConversationSync, broadcastConversationChanged } from '../realtime.js'
import { stopBotForUser } from '../qq/manager.js'
import { trackUserActivity } from './user.js'

function getUserId(c: any): string {
  return c.get('userId') || ''
}

/**
 * 解除某个会话的微信绑定（软删会话 / 硬删会话共用）。
 * - 路由权威就是 wechat_bindings.conversation_id：
 *   若绑定指向该会话，则删除绑定行（bot_token 一并清除，重新绑定需重新扫码）
 */
export async function unbindConversationWechat(userId: string, conversationId: string): Promise<void> {
  const binding = await db.select().from(wechatBindings)
    .where(eq(wechatBindings.user_id, userId)).get()
  if (binding && binding.conversation_id === conversationId) {
    await db.delete(wechatBindings).where(eq(wechatBindings.user_id, userId)).run()
  }
}

/**
 * 解除某个会话的 QQ 绑定路由（软删会话 / 硬删会话共用）。
 * - 删除绑定会话 → 绑定关系拆除；从群聊 Agent 成员中移除该 Agent。
 *   群聊会话其他 Agent 不受影响。
 */
export async function unbindConversationQq(userId: string, conversationId: string): Promise<void> {
  const binding = await db.select().from(qqBindings)
    .where(and(
      eq(qqBindings.user_id, userId),
      eq(qqBindings.conversation_id, conversationId),
    )).get()
  if (binding) {
    stopBotForUser(userId, binding.agent_id)
    // 清理该 app_id 下的群聊映射
    if (binding.app_id) {
      await db.delete(qqGroupConversations)
        .where(eq(qqGroupConversations.app_id, binding.app_id)).run()
    }
    await db.delete(qqBindings)
      .where(and(
        eq(qqBindings.user_id, userId),
        eq(qqBindings.agent_id, binding.agent_id),
      )).run()
  }
}

export const conversationsRoute = new Hono()

// Apply user auth to all routes
conversationsRoute.use('*', userAuthMiddleware)

// List user's conversations
conversationsRoute.get('/', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const list = await db.select({
    id: conversations.id,
    user_id: conversations.user_id,
    title: conversations.title,
    agent_id: conversations.agent_id,
    type: conversations.type,
    created_at: conversations.created_at,
    updated_at: conversations.updated_at,
    deleted_at: conversations.deleted_at,
    agent_count: sql<number>`COALESCE((SELECT COUNT(*) FROM group_conversation_agents WHERE group_conversation_agents.conversation_id = ${conversations.id}), 0)`,
    wechat_bound: sql<number>`EXISTS (SELECT 1 FROM wechat_bindings WHERE wechat_bindings.user_id = ${conversations.user_id} AND wechat_bindings.conversation_id = ${conversations.id})`,
    qq_bound: sql<number>`EXISTS (SELECT 1 FROM qq_bindings WHERE qq_bindings.user_id = ${conversations.user_id} AND qq_bindings.conversation_id = ${conversations.id}) OR EXISTS (SELECT 1 FROM qq_group_conversations WHERE qq_group_conversations.conversation_id = ${conversations.id})`,
  }).from(conversations).where(and(eq(conversations.user_id, userId), sql`${conversations.deleted_at} IS NULL`)).orderBy(desc(conversations.updated_at)).all()
  return c.json({ conversations: list })
})

// Get one conversation with messages
conversationsRoute.get('/:id', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const id = c.req.param('id')
  const conv = await db.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.user_id, userId), sql`${conversations.deleted_at} IS NULL`)).get()
  if (!conv) return c.json({ error: 'Not found' }, 404)

  const msgs = await db.select().from(messages).where(eq(messages.conversation_id, id)).orderBy(messages.created_at).all()

  // For group conversations, also return the agent list
  let groupAgents: Array<{ id: string; name: string; avatar: string }> | undefined
  if ((conv as any).type === 'group') {
    const rows = await db.select({
      agent_id: groupConversationAgents.agent_id,
      name: agents.name,
      avatar: agents.avatar,
    })
      .from(groupConversationAgents)
      .innerJoin(agents, eq(groupConversationAgents.agent_id, agents.id))
      .where(eq(groupConversationAgents.conversation_id, id))
      .orderBy(groupConversationAgents.sort_order)
      .all()
    groupAgents = rows.map((r: { agent_id: string; name: string; avatar: string }) => ({ id: r.agent_id, name: r.name, avatar: r.avatar }))
  }

  // 判定该群聊会话是否属于 QQ 群（多 Bot 共享同一群聊时 agent 数 > 1，不能再靠 client 猜测）
  let isQqGroup = false
  if ((conv as any).type === 'group') {
    const qqRow = await db.select().from(qqGroupConversations)
      .where(eq(qqGroupConversations.conversation_id, id)).get()
    isQqGroup = !!qqRow
  }

  return c.json({
    conversation: conv,
    messages: msgs.map((m: typeof messages.$inferSelect) => ({
      ...m,
      tool_calls: m.tool_calls ? JSON.parse(m.tool_calls) : null,
      suggestions: m.suggestions ? JSON.parse(m.suggestions) : null,
      attachments: m.attachments ? JSON.parse(m.attachments) : null,
      trace: m.trace ? JSON.parse(m.trace) : null,
    })),
    agents: groupAgents,
    is_qq_group: isQqGroup,
  })
})

// Create a new conversation
conversationsRoute.post('/', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<{ title?: string; agent_id?: string; type?: 'direct' | 'group'; agent_ids?: string[] }>()
  const id = randomUUID()
  const now = Math.floor(Date.now() / 1000)

  await db.insert(conversations).values({
    id, user_id: userId,
    title: body.title || (body.type === 'group' ? '群组对话' : 'New Chat'),
    agent_id: body.agent_id || '',
    type: body.type || 'direct',
    created_at: now, updated_at: now,
  }).run()

  // Insert group agent associations
  if (body.type === 'group' && body.agent_ids && body.agent_ids.length > 0) {
    for (let i = 0; i < body.agent_ids.length; i++) {
      if (body.agent_ids[i] === NEUTRAL_AGENT_ID) continue // skip neutral agent
      await db.insert(groupConversationAgents).values({
        conversation_id: id,
        agent_id: body.agent_ids[i],
        sort_order: i,
      }).run()
    }
  }

  const conv = await db.select().from(conversations).where(eq(conversations.id, id)).get()

  // 侧边栏新会话记录实时同步到同账号其他设备
  broadcastConversationSync(userId)

  trackUserActivity(userId).catch(() => {})
  return c.json({ conversation: conv }, 201)
})

// Delete a conversation (soft delete — mark deleted_at, preserve workspace)
conversationsRoute.delete('/:id', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const id = c.req.param('id')
  const now = Math.floor(Date.now() / 1000)
  await db.update(conversations)
    .set({ deleted_at: now, updated_at: now })
    .where(and(eq(conversations.id, id), eq(conversations.user_id, userId)))
    .run()

  // 软删会话 → 自动解除微信绑定（删除 wechat_bindings 绑定行）
  await unbindConversationWechat(userId, id)
  // 软删会话 → 解除 QQ 绑定路由（保留凭证与连接，仅清 conversation_id）
  await unbindConversationQq(userId, id)

  // 侧边栏删除记录实时同步到同账号其他设备
  broadcastConversationSync(userId)

  trackUserActivity(userId).catch(() => {})
  return c.json({ success: true })
})

// Rename a conversation
conversationsRoute.patch('/:id', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const id = c.req.param('id')
  const body = await c.req.json<{ title: string }>()
  const now = Math.floor(Date.now() / 1000)

  await db.update(conversations).set({ title: body.title, updated_at: now }).where(and(eq(conversations.id, id), eq(conversations.user_id, userId), sql`${conversations.deleted_at} IS NULL`)).run()

  const conv = await db.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.user_id, userId), sql`${conversations.deleted_at} IS NULL`)).get()
  if (!conv) return c.json({ error: 'Not found' }, 404)

  broadcastConversationSync(userId)

  trackUserActivity(userId).catch(() => {})
  return c.json({ conversation: conv })
})

// Merge group conversations — create a new conversation, copy all messages
// (preserving created_at for chronological order), merge agent members, soft-delete sources.
conversationsRoute.post('/merge', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<{ source_ids: string[] }>()
  const sourceIds = body.source_ids
  if (!sourceIds || sourceIds.length < 2) {
    return c.json({ error: '至少需要 2 个会话才能合并' }, 400)
  }

  // 1. Verify all source conversations exist, belong to user, are group type, not deleted
  const sources: typeof conversations.$inferSelect[] = []
  const isQqSource = new Map<string, boolean>()
  for (const sid of sourceIds) {
    const s = await db.select().from(conversations)
      .where(and(eq(conversations.id, sid), eq(conversations.user_id, userId), sql`${conversations.deleted_at} IS NULL`))
      .get()
    if (!s) return c.json({ error: `会话 ${sid} 不存在` }, 404)
    if ((s as any).type !== 'group') return c.json({ error: `会话 ${sid} 不是群聊` }, 400)
    sources.push(s)
    const qqRow = await db.select().from(qqGroupConversations)
      .where(eq(qqGroupConversations.conversation_id, sid)).get()
    isQqSource.set(sid, !!qqRow)
  }

  // 同质性检查：不能混合 QQ 群聊和普通群聊
  const hasQq = [...isQqSource.values()].some(v => v)
  const hasNonQq = [...isQqSource.values()].some(v => !v)
  if (hasQq && hasNonQq) {
    return c.json({ error: '不能混合 QQ 群聊和普通群聊' }, 400)
  }

  // 2. Create new conversation C
  const newId = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const defaultAgentId = sources[0].agent_id
  await db.insert(conversations).values({
    id: newId,
    user_id: userId,
    title: '合并群聊',
    agent_id: defaultAgentId,
    type: 'group',
    created_at: now,
    updated_at: now,
  }).run()

  // 3. For each source: copy messages, merge agents, repoint mappings, soft-delete
  const seenAgentIds = new Set<string>()
  for (const source of sources) {
    // 3a. Copy messages (preserve created_at for chronological ordering)
    const sourceMsgs = await db.select().from(messages)
      .where(eq(messages.conversation_id, source.id))
      .orderBy(messages.created_at)
      .all()
    for (const msg of sourceMsgs) {
      await db.insert(messages).values({
        conversation_id: newId,
        role: msg.role,
        content: msg.content,
        thinking: msg.thinking,
        tool_calls: msg.tool_calls,
        trace: msg.trace,
        tool_call_id: msg.tool_call_id,
        suggestions: msg.suggestions,
        attachments: msg.attachments,
        agent_id: msg.agent_id,
        created_at: msg.created_at,
      }).run()
    }

    // 3b. Merge groupConversationAgents (dedup)
    const sourceAgents = await db.select().from(groupConversationAgents)
      .where(eq(groupConversationAgents.conversation_id, source.id))
      .all()
    for (const sa of sourceAgents) {
      if (seenAgentIds.has(sa.agent_id)) continue
      seenAgentIds.add(sa.agent_id)
      try {
        await db.insert(groupConversationAgents).values({
          conversation_id: newId,
          agent_id: sa.agent_id,
          sort_order: 0,
        }).run()
      } catch { /* already exists */ }
    }

    // 3c. Redirect qq_group_conversations mappings
    await db.update(qqGroupConversations)
      .set({ conversation_id: newId })
      .where(eq(qqGroupConversations.conversation_id, source.id))
      .run()

    // 3d. Soft-delete source
    await db.update(conversations)
      .set({ deleted_at: now, updated_at: now })
      .where(and(eq(conversations.id, source.id), eq(conversations.user_id, userId)))
      .run()
  }

  // 4. Read back new conversation
  const mergedConv = await db.select().from(conversations).where(eq(conversations.id, newId)).get()
  broadcastConversationSync(userId)
  broadcastConversationChanged(userId, newId)

  trackUserActivity(userId).catch(() => {})
  return c.json({ conversation: mergedConv })
})

// Revert from a specific message — delete this message and all subsequent ones
conversationsRoute.delete('/:id/messages/:messageId', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const convId = c.req.param('id')
  const messageId = Number(c.req.param('messageId'))

  // Verify conversation ownership
  const conv = await db.select().from(conversations).where(and(eq(conversations.id, convId), eq(conversations.user_id, userId), sql`${conversations.deleted_at} IS NULL`)).get()
  if (!conv) return c.json({ error: 'Not found' }, 404)

  // Verify message belongs to this conversation
  const msg = await db.select().from(messages).where(and(eq(messages.id, messageId), eq(messages.conversation_id, convId))).get()
  if (!msg) return c.json({ error: 'Message not found' }, 404)

  // Delete this message and all messages created after it (same or later timestamp)
  await db.delete(messages)
    .where(and(
      eq(messages.conversation_id, convId),
      gte(messages.id, messageId),
    ))
    .run()

  // Update conversation timestamp
  const now = Math.floor(Date.now() / 1000)
  await db.update(conversations).set({ updated_at: now }).where(eq(conversations.id, convId)).run()

  // 回退消息后，同账号其他设备若正在查看该会话需实时刷新消息列表
  broadcastConversationChanged(userId, convId)
  broadcastConversationSync(userId)

  return c.json({ success: true })
})
