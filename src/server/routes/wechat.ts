import { Hono } from 'hono'
import { db, userWechatBindings, wechatSessions } from '../db.js'
import { eq } from 'drizzle-orm'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { randomUUID } from 'crypto'
import QRCode from 'qrcode'

export const wechatRoute = new Hono()

const ILLINK_BASE = 'https://ilinkai.weixin.qq.com'

function wechatHeaders(): Record<string, string> {
  const uin = Buffer.from(String(Math.floor(Math.random() * 4294967295))).toString('base64')
  return {
    'Content-Type': 'application/json',
    'iLink-App-ClientVersion': '0',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': uin,
  }
}

// GET /api/wechat/bind — check current user's binding status
wechatRoute.get('/bind', userAuthMiddleware, async (c) => {
  const userId = (c as any).get('userId') as string
  const binding = await db.select().from(userWechatBindings)
    .where(eq(userWechatBindings.user_id, userId)).get()

  if (!binding) {
    return c.json({ bound: false })
  }

  return c.json({
    bound: true,
    wechat_user_id: binding.wechat_user_id,
    bound_at: binding.created_at,
  })
})

// POST /api/wechat/bind — start binding, optionally anchor to an existing conversation
wechatRoute.post('/bind', userAuthMiddleware, async (c) => {
  const userId = (c as any).get('userId') as string
  const body = await c.req.json().catch(() => ({})) as { conv_id?: string }

  const res = await fetch(`${ILLINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    headers: wechatHeaders(),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return c.json({ error: `iLink QR code request failed: ${res.status} ${text}` }, 502)
  }

  const data = await res.json() as { qrcode: string; qrcode_img_content: string; expiry_ms: number }
  const expires_at = Date.now() + (data.expiry_ms || 300_000)

  // Store the conversation ID we want to anchor to, so that when the first
  // WeChat message arrives after scanning, it continues in this conversation.
  if (body.conv_id) {
    const existing = await db.select().from(userWechatBindings)
      .where(eq(userWechatBindings.user_id, userId)).get()
    const now = Math.floor(Date.now() / 1000)
    if (existing) {
      await db.update(userWechatBindings)
        .set({ pending_conv_id: body.conv_id })
        .where(eq(userWechatBindings.user_id, userId)).run()
    } else {
      // Binding row doesn't exist yet — create a placeholder with the anchor
      await db.insert(userWechatBindings).values({
        id: randomUUID(),
        user_id: userId,
        bot_token: '',
        wechat_user_id: '',
        updates_buf: '',
        last_poll_at: now,
        pending_conv_id: body.conv_id,
        created_at: now,
      }).run()
    }
  }

  // The QR code that WeChat scans is the liteapp URL. We generate it ourselves
  // server-side so the browser never needs to contact liteapp.weixin.qq.com.
  const liteappUrl = data.qrcode_img_content
  let qrcode_data_uri = ''
  if (liteappUrl && typeof liteappUrl === 'string') {
    try {
      qrcode_data_uri = await QRCode.toDataURL(liteappUrl, {
        width: 300,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      })
    } catch (err) {
      console.log('[wechat] QR code generation error:', (err as Error).message)
    }
  }

  return c.json({
    qrcode_id: data.qrcode,
    qrcode_page_url: liteappUrl,
    qrcode_data_uri,
    expires_at,
  })
})

// GET /api/wechat/bind/status — poll QR scan status
wechatRoute.get('/bind/status', userAuthMiddleware, async (c) => {
  const userId = (c as any).get('userId') as string
  const qrcodeId = c.req.query('qrcode_id')
  if (!qrcodeId) return c.json({ error: 'Missing qrcode_id' }, 400)

  const res = await fetch(`${ILLINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`, {
    headers: {
      'Content-Type': 'application/json',
      'iLink-App-ClientVersion': '0',
    },
  })

  if (!res.ok) {
    return c.json({ status: 'wait' })
  }

  const data = await res.json() as { status: string; bot_token?: string; ilink_user_id?: string }

  if (data.status === 'confirmed' && data.bot_token) {
    const existing = await db.select().from(userWechatBindings)
      .where(eq(userWechatBindings.user_id, userId)).get()

    const now = Math.floor(Date.now() / 1000)
    if (existing) {
      await db.update(userWechatBindings)
        .set({
          bot_token: data.bot_token,
          ilink_user_id: data.ilink_user_id || existing.ilink_user_id || '',
          updates_buf: '',
          last_poll_at: now,
          created_at: now,
        })
        .where(eq(userWechatBindings.user_id, userId)).run()
      // Don't clear pending_conv_id — it was set in POST /bind before scanning
    } else {
      await db.insert(userWechatBindings).values({
        id: randomUUID(),
        user_id: userId,
        bot_token: data.bot_token,
        ilink_user_id: data.ilink_user_id || '',
        wechat_user_id: '',
        updates_buf: '',
        last_poll_at: now,
        pending_conv_id: '',
        created_at: now,
      }).run()
    }

    return c.json({ status: 'confirmed' })
  }

  if (data.status === 'expired') {
    return c.json({ status: 'expired' })
  }

  return c.json({ status: 'wait' })
})

// DELETE /api/wechat/bind — unbind
wechatRoute.delete('/bind', userAuthMiddleware, async (c) => {
  const userId = (c as any).get('userId') as string
  await db.delete(userWechatBindings).where(eq(userWechatBindings.user_id, userId)).run()
  await db.delete(wechatSessions).where(eq(wechatSessions.user_id, userId)).run()
  return c.json({ success: true })
})