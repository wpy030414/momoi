import { Hono } from 'hono'
import { db, conversations, messages, groupConversationAgents, agents, wechatBindings, qqBindings, qqGroupConversations } from '../db.js'
import { eq, and, desc, gte, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { NEUTRAL_AGENT_ID } from '../../shared/constants.js'
import { broadcastConversationSync, broadcastConversationChanged } from '../realtime.js'
import { stopBotForUser } from '../qq/manager.js'

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
 * - 删除绑定会话 → 绑定关系 + 群聊映射全部删除，彻底断联。
 *   群聊会话下次收到消息时会自愈重建（resolveGroupConversation 检测到
 *   映射存在但会话已软删 → 清理旧映射 → 创建新群聊会话）。
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

  // Scope the read-back by user_id too — otherwise a caller who renames someone
  // else's conversation (the UPDATE above no-ops) still gets that conversation echoed.
  const conv = await db.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.user_id, userId), sql`${conversations.deleted_at} IS NULL`)).get()
  if (!conv) return c.json({ error: 'Not found' }, 404)

  // 重命名记录实时同步到同账号其他设备侧边栏
  broadcastConversationSync(userId)

  return c.json({ conversation: conv })
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
