import { Hono } from 'hono'
import { db, conversations, qqBindings } from '../db.js'
import { eq, and, sql } from 'drizzle-orm'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { withNamedLock } from '../im/locks.js'
import { getAccessToken } from '../qq/api.js'
import { isBotReady, restartBotForUser, stopBotForUser } from '../qq/manager.js'

export const qqRoute = new Hono()

// GET /api/qq/bind — check current user's binding status
qqRoute.get('/bind', userAuthMiddleware, async (c) => {
  const userId = (c as any).get('userId') as string
  const binding = await db.select().from(qqBindings)
    .where(eq(qqBindings.user_id, userId)).get()

  if (!binding || !binding.app_id) {
    return c.json({ bound: false })
  }

  return c.json({
    bound: true,
    app_id: binding.app_id,
    bound_at: binding.created_at,
    conversation_id: binding.conversation_id || undefined,
    status: binding.status,
    error: binding.error || undefined,
    group_enabled: binding.group_enabled === true,
    // 运行时连接健康态（内存）；DB 是绑定的权威，服务重启后 WS 态自动重建
    ws_connected: isBotReady(userId),
  })
})

// POST /api/qq/bind — bind with credentials, or re-anchor the bound conversation
qqRoute.post('/bind', userAuthMiddleware, async (c) => {
  const userId = (c as any).get('userId') as string
  const body = await c.req.json().catch(() => ({})) as {
    conv_id?: string; app_id?: string; app_secret?: string
    group_enabled?: boolean
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

  // Serialize per-user — prevents concurrent binds from interleaving
  // DB writes and connection restarts.
  return withNamedLock(`qq-bind:${userId}`, async () => {
    const existing = await db.select().from(qqBindings)
      .where(eq(qqBindings.user_id, userId)).get()
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
        }).where(eq(qqBindings.user_id, userId)).run()
      } else {
        await db.insert(qqBindings).values({
          user_id: userId,
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
      await restartBotForUser(userId)
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
      }).where(eq(qqBindings.user_id, userId)).run()
      return c.json({ success: true })
    }
    await db.update(qqBindings).set({
      conversation_id: targetConvId,
      updated_at: now,
    }).where(eq(qqBindings.user_id, userId)).run()
    return c.json({ success: true })
  })
})

// DELETE /api/qq/bind — unbind and disconnect
qqRoute.delete('/bind', userAuthMiddleware, async (c) => {
  const userId = (c as any).get('userId') as string
  stopBotForUser(userId)
  await db.delete(qqBindings).where(eq(qqBindings.user_id, userId)).run()
  return c.json({ success: true })
})
