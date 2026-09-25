// ============================================================
// Push Notification Routes — Web Push 订阅管理 + VAPID 公钥
// ============================================================

import { Hono } from 'hono'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { db, pushSubscriptions } from '../db/index.js'
import { getVapidKeys } from '../lib/config.js'
import { and, eq, or, ne } from 'drizzle-orm'

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

  // 原子 upsert：以物理唯一键 (user_id, device_id) 为冲突目标——
  // 并发上报（StrictMode 双 effect / 开关与自动订阅竞争）天然幂等，
  // 同一设备换 endpoint（订阅续期）时原位更新，不残留旧行。
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
    .onConflictDoUpdate({
      target: [pushSubscriptions.user_id, pushSubscriptions.device_id],
      set: { endpoint, p256dh: keys.p256dh, auth: keys.auth, created_at: now },
    })
    .run()

  // 兜底清理：同一条浏览器订阅（endpoint 唯一）落在其他 (user, device)
  // 行上的残留——如换账号登录、sessionStorage device_id 轮换的旧行。
  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.endpoint, endpoint),
        or(
          ne(pushSubscriptions.user_id, userId),
          ne(pushSubscriptions.device_id, deviceId),
        ),
      ),
    )
    .run()

  console.log(`[push] Subscription saved: user=${userId} device=${deviceId}`)
  return c.json({ success: true })
})

// DELETE /api/push-notification/unsubscribe — 客户端取消订阅
pushNotificationRoute.delete('/unsubscribe', async (c) => {
  const userId = (c as any).get('userId') as string
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const { endpoint, deviceId } = await c.req.json<{ endpoint?: string; deviceId?: string }>()

  if (!endpoint && !deviceId) {
    return c.json({ error: 'Missing endpoint or deviceId' }, 400)
  }

  // 优先按 endpoint 精确删除；endpoint 不可得（本地订阅已消失）时按
  // deviceId 兜底清理历史行。
  if (endpoint) {
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).run()
  } else {
    await db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.user_id, userId),
          eq(pushSubscriptions.device_id, deviceId!),
        ),
      )
      .run()
  }

  console.log(`[push] Unsubscribed: user=${userId} endpoint=${endpoint?.slice(0, 40) ?? `by-device ${deviceId}`}`)
  return c.json({ success: true })
})