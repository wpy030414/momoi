import { Hono } from 'hono'
import { db, conversations, qqBindings, qqGroupConversations } from '../db/index.js'
import { eq, and, sql } from 'drizzle-orm'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { withNamedLock } from '../im/locks.js'
import { getAccessToken } from '../im/qq/api.js'
import { isBotReady, restartBotForUser, stopBotForUser } from '../im/qq/manager.js'
import { broadcastConversationSync } from '../lib/realtime.js'

export const qqRoute = new Hono()

// GET /api/qq/bind — check current user's binding status for a specific agent,
// or list all bindings if no agent_id is provided.
qqRoute.get('/bind', userAuthMiddleware, async (c) => {
  const userId = (c as any).get('userId') as string
  const agentId = c.req.query('agent_id') || ''

  if (agentId) {
    const binding = await db.select().from(qqBindings)
      .where(and(
        eq(qqBindings.user_id, userId),
        eq(qqBindings.agent_id, agentId),
      )).get()

    if (!binding || !binding.app_id) {
      return c.json({ bound: false, agent_id: agentId })
    }

    return c.json({
      bound: true,
      agent_id: binding.agent_id,
      app_id: binding.app_id,
      bound_at: binding.created_at,
      conversation_id: binding.conversation_id || undefined,
      status: binding.status,
      error: binding.error || undefined,
      group_enabled: binding.group_enabled === true,
      ws_connected: isBotReady(userId, agentId),
    })
  }

  // No agent_id: return all bindings for this user
  const bindings = await db.select().from(qqBindings)
    .where(eq(qqBindings.user_id, userId)).all()
  return c.json({
    bindings: bindings.map((b: typeof qqBindings.$inferSelect) => ({
      agent_id: b.agent_id,
      app_id: b.app_id,
      bound_at: b.created_at,
      conversation_id: b.conversation_id || undefined,
      status: b.status,
      error: b.error || undefined,
      group_enabled: b.group_enabled === true,
      ws_connected: isBotReady(userId, b.agent_id),
    })),
  })
})

// POST /api/qq/bind — bind with credentials, or re-anchor the bound conversation
qqRoute.post('/bind', userAuthMiddleware, async (c) => {
  const userId = (c as any).get('userId') as string
  const body = await c.req.json().catch(() => ({})) as {
    conv_id?: string; agent_id?: string; app_id?: string; app_secret?: string
    group_enabled?: boolean
  }

  const agentId = (body.agent_id || '').trim()
  if (!agentId) {
    return c.json({ error: 'agent_id is required' }, 400)
  }

  // If a target conversation is specified, verify it belongs to this user
  // and is not soft-deleted.
  let targetConvId = (body.conv_id || '').trim()
  if (targetConvId) {
    const conv = await db.select().from(conversations)
      .where(and(
        eq(conversations.id, targetConvId),
        eq(conversations.user_id, userId),
        sql`${conversations.deleted_at} IS NULL`,
      )).get()
    if (!conv) {
      return c.json({ error: 'Conversation not found' }, 404)
    }
  }

  const appId = (body.app_id || '').trim()
  const appSecret = (body.app_secret || '').trim()
  const hasCredentials = appId || appSecret

  // Serialize per-user-per-agent — prevents concurrent binds from interleaving
  // DB writes and connection restarts.
  return withNamedLock(`qq-bind:${userId}:${agentId}`, async () => {
    const existing = await db.select().from(qqBindings)
      .where(and(
        eq(qqBindings.user_id, userId),
        eq(qqBindings.agent_id, agentId),
      )).get()
    const now = Math.floor(Date.now() / 1000)

    if (hasCredentials) {
      // 凭证必须成对提供
      if (!appId || !appSecret) {
        return c.json({ error: 'AppID 与 AppSecret 必须成对提供' }, 400)
      }
      // 凭证校验（不起 WS）：失败 fail-fast，用户在表单内联看到原因
      try {
        await getAccessToken({ appId, appSecret })
      } catch (err) {
        return c.json({
          error: `AppID 或 AppSecret 无效：${(err as Error).message}`,
        }, 400)
      }

      if (existing) {
        await db.update(qqBindings).set({
          app_id: appId,
          app_secret: appSecret,
          conversation_id: targetConvId || existing.conversation_id || '',
          group_enabled: typeof body.group_enabled === 'boolean' ? (body.group_enabled ? 1 : 0) : (existing.group_enabled ? 1 : 0),
          status: 'connected',
          error: '',
          created_at: now,
          updated_at: now,
        }).where(and(
          eq(qqBindings.user_id, userId),
          eq(qqBindings.agent_id, agentId),
        )).run()
      } else {
        await db.insert(qqBindings).values({
          user_id: userId,
          agent_id: agentId,
          app_id: appId,
          app_secret: appSecret,
          conversation_id: targetConvId,
          group_enabled: body.group_enabled === true ? 1 : 0,
          status: 'connected',
          error: '',
          created_at: now,
          updated_at: now,
        }).run()
      }

      // 换凭证即换连接（凭证变更后 open_id 空间随之改变，旧连接立即失效）
      await restartBotForUser(userId, agentId)
      broadcastConversationSync(userId)
      return c.json({ success: true })
    }

    // 无凭证：已有绑定时仅更新路由目标或 group_enabled toggle
    if (!existing) {
      return c.json({ error: '缺少 AppID/AppSecret 且不存在已有绑定' }, 400)
    }
    // 仅 toggle group_enabled（无 conv_id 也无凭证）—— 即时生效无需重启连接
    if (!targetConvId) {
      if (typeof body.group_enabled !== 'boolean') {
        return c.json({ error: '缺少 conv_id' }, 400)
      }
      await db.update(qqBindings).set({
        group_enabled: body.group_enabled ? 1 : 0,
        updated_at: now,
      }).where(and(
        eq(qqBindings.user_id, userId),
        eq(qqBindings.agent_id, agentId),
      )).run()
      broadcastConversationSync(userId)
      return c.json({ success: true })
    }
    await db.update(qqBindings).set({
      conversation_id: targetConvId,
      updated_at: now,
    }).where(and(
      eq(qqBindings.user_id, userId),
      eq(qqBindings.agent_id, agentId),
    )).run()
    broadcastConversationSync(userId)
    return c.json({ success: true })
  })
})

// DELETE /api/qq/bind — unbind a specific agent's bot and disconnect.
// 清理该 app_id 下的群聊映射。
qqRoute.delete('/bind', userAuthMiddleware, async (c) => {
  const userId = (c as any).get('userId') as string
  const body = await c.req.json().catch(() => ({})) as { agent_id?: string }
  const agentId = (body.agent_id || '').trim()
  if (!agentId) {
    return c.json({ error: 'agent_id is required' }, 400)
  }
  stopBotForUser(userId, agentId)
  // Clean up group conversation mappings tied to this agent's app_id
  const binding = await db.select().from(qqBindings)
    .where(and(
      eq(qqBindings.user_id, userId),
      eq(qqBindings.agent_id, agentId),
    )).get()
  if (binding?.app_id) {
    await db.delete(qqGroupConversations)
      .where(eq(qqGroupConversations.app_id, binding.app_id)).run()
  }
  await db.delete(qqBindings)
    .where(and(
      eq(qqBindings.user_id, userId),
      eq(qqBindings.agent_id, agentId),
    )).run()
  broadcastConversationSync(userId)
  return c.json({ success: true })
})