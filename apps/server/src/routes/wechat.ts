import { Hono } from 'hono'
import { db, conversations, wechatBindings } from '../db.js'
import { eq, and, sql } from 'drizzle-orm'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { withNamedLock } from '../im/locks.js'
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
  const binding = await db.select().from(wechatBindings)
    .where(eq(wechatBindings.user_id, userId)).get()

  // A row with empty bot_token is a placeholder created by POST /bind that has
  // not been scanned yet — treat it as unbound so the UI shows the QR flow.
  if (!binding || !binding.bot_token) {
    return c.json({ bound: false })
  }

  return c.json({
    bound: true,
    wechat_user_id: binding.wechat_user_id,
    bound_at: binding.created_at,
    conversation_id: binding.conversation_id || undefined,
    session_expired: binding.session_expired,
  })
})

// POST /api/wechat/bind — start binding, optionally anchor to an existing conversation
wechatRoute.post('/bind', userAuthMiddleware, async (c) => {
  const userId = (c as any).get('userId') as string
  const body = await c.req.json().catch(() => ({})) as { conv_id?: string }

  // If a target conversation is specified, verify it belongs to this user,
  // is not soft-deleted, and is a direct (non-group) conversation.
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
    if (conv.type === 'group') {
      return c.json({ error: 'Group conversations cannot be bound to WeChat' }, 400)
    }
  }

  const res = await fetch(`${ILLINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    headers: wechatHeaders(),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return c.json({ error: `iLink QR code request failed: ${res.status} ${text}` }, 502)
  }

  const data = await res.json() as { qrcode: string; qrcode_img_content: string; expiry_ms: number }
  const expires_at = Date.now() + (data.expiry_ms || 300_000)

  // Store the conversation ID we want to bind to, so that when the first
  // WeChat message arrives after scanning, it continues in this conversation.
  const existing = await db.select().from(wechatBindings)
    .where(eq(wechatBindings.user_id, userId)).get()
  const now = Math.floor(Date.now() / 1000)
  if (existing) {
    // Track whether an existing binding is being re-bound to a new conversation.
    // pending_conversation_id holds the *intended* target while the QR is being scanned.
    await db.update(wechatBindings)
      .set({ pending_conversation_id: targetConvId })
      .where(eq(wechatBindings.user_id, userId)).run()
  } else {
    // Binding row doesn't exist yet — create a placeholder with the anchor
    await db.insert(wechatBindings).values({
      user_id: userId,
      bot_token: '',
      wechat_user_id: '',
      conversation_id: '',
      pending_conversation_id: targetConvId,
      created_at: now,
    }).run()
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

  console.log('[wechat-bind] QR scan status:', data.status,
    'ilink_user_id:', data.ilink_user_id || '(missing)',
    'has_bot_token:', !!data.bot_token)

  if (data.status === 'confirmed' && data.bot_token) {
    // Serialize per-user — prevents two concurrent QR scans from clobbering
    // each other's bot_token / conversation_id (A2).
    return withNamedLock(userId, async () => {
      const existing = await db.select().from(wechatBindings)
        .where(eq(wechatBindings.user_id, userId)).get()

      const now = Math.floor(Date.now() / 1000)

      if (existing) {
        // The conversation this binding should attach to:
        // pending_conversation_id was set during POST /bind; fall back to the
        // existing conversation_id (re-scan without re-anchoring keeps the old target).
        const targetConvId = existing.pending_conversation_id || existing.conversation_id || ''

        // Validate the target conversation is still alive and owned by this user.
        // A stale pending target (target soft-deleted mid-scan) must not bind.
        if (targetConvId) {
          const targetConv = await db.select().from(conversations)
            .where(and(
              eq(conversations.id, targetConvId),
              eq(conversations.user_id, userId),
              sql`${conversations.deleted_at} IS NULL`,
            )).get()
          if (!targetConv) {
            return c.json({ status: 'expired', error: '目标会话已删除，请重新选择会话并绑定。' })
          }
        }

        // 覆盖转移（需求3）：路由权威就是 binding.conversation_id 本身，
        // 换绑写入新目标即完成转移，旧会话不再收到消息。
        await db.update(wechatBindings)
          .set({
            bot_token: data.bot_token,
            wechat_user_id: data.ilink_user_id || existing.wechat_user_id || '',
            conversation_id: targetConvId,
            updates_buf: '',
            session_expired: false,
            pending_conversation_id: '',
            created_at: now,
          })
          .where(eq(wechatBindings.user_id, userId)).run()
      } else {
        // No binding row — the placeholder was created by POST /bind but is
        // gone (e.g. the target conversation was soft-deleted while the QR was
        // showing, and unbindConversationWechat removed the row). Refuse the
        // confirmation instead of creating a conversation_id='' zombie binding
        // that would never route.
        return c.json({ status: 'expired', error: '目标会话已删除，请重新选择会话并绑定。' })
      }

      return c.json({ status: 'confirmed' })
    })
  }

  if (data.status === 'expired') {
    return c.json({ status: 'expired' })
  }

  return c.json({ status: 'wait' })
})

// DELETE /api/wechat/bind — unbind
wechatRoute.delete('/bind', userAuthMiddleware, async (c) => {
  const userId = (c as any).get('userId') as string
  await db.delete(wechatBindings).where(eq(wechatBindings.user_id, userId)).run()
  return c.json({ success: true })
})
