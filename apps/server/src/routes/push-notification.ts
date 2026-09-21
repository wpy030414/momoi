// ============================================================
// Push Notification Routes — Web Push 订阅管理 + VAPID 公钥
// ============================================================

import { Hono } from 'hono'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { db, pushSubscriptions } from '../db/index.js'
import { getVapidKeys } from '../lib/config.js'
import { and, eq } from 'drizzle-orm'

export const pushNotificationRoute = new Hono()

// All routes require auth
pushNotificationRoute.use('*', userAuthMiddleware)

// GET /api/push-notification/vapid-public-key — 客户端获取 VAPID 公钥
pushNotificationRoute.get('/vapid-public-key', async (c) => {
  const { publicKey } = await getVapidKeys()
  return c.json({ publicKey })
})

// POST /api/push-notification/subscribe — 客户端上报 Web Push subscription
pushNotificationRoute.post('/subscribe', async (c) => {
  const userId = (c as any).get('userId') as string
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const { deviceId, endpoint, keys } = await c.req.json<{
    deviceId: string
    endpoint: string
    keys: { p256dh: string; auth: string }
  }>()

  if (!deviceId || !endpoint || !keys?.p256dh || !keys?.auth) {
    return c.json({ error: 'Missing required fields' }, 400)
  }

  const now = Math.floor(Date.now() / 1000)

  // Upsert: remove old subscription for same user+device then insert
  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.user_id, userId),
        eq(pushSubscriptions.device_id, deviceId),
      ),
    )
    .run()

  await db
    .insert(pushSubscriptions)
    .values({
      user_id: userId,
      device_id: deviceId,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      created_at: now,
    })
    .run()

  console.log(`[push] Subscription saved: user=${userId} device=${deviceId}`)
  return c.json({ success: true })
})

// DELETE /api/push-notification/unsubscribe — 客户端取消订阅
pushNotificationRoute.delete('/unsubscribe', async (c) => {
  const userId = (c as any).get('userId') as string
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const { deviceId } = await c.req.json<{ deviceId: string }>()

  if (!deviceId) {
    return c.json({ error: 'Missing deviceId' }, 400)
  }

  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.user_id, userId),
        eq(pushSubscriptions.device_id, deviceId),
      ),
    )
    .run()

  console.log(`[push] Unsubscribed: user=${userId} device=${deviceId}`)
  return c.json({ success: true })
})