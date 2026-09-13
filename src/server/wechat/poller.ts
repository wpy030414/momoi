/**
 * 微信消息轮询器：定时遍历所有已绑定用户，拉取新消息并桥接处理。
 * polling cursor 已合入 userWechatBindings 表（updates_buf / last_poll_at）。
 */
import { db, userWechatBindings } from '../db.js'
import { eq } from 'drizzle-orm'
import { getUpdates, WECHAT_BASE_URL, DEFAULT_POLL_TIMEOUT_MS, parseIncoming, type WechatCredentials } from './ilink.js'
import { handleWechatMessage } from './chat.js'

const DEFAULT_INTERVAL_MS = 3_000
let pollTimer: ReturnType<typeof setInterval> | null = null

async function pollOnce(): Promise<void> {
  const bindings = await db.select().from(userWechatBindings).all()
  if (bindings.length === 0) return

  for (const binding of bindings) {
    try {
      // 跳过已过期 session
      if (binding.updates_buf === 'SESSION_EXPIRED') continue

      const creds: WechatCredentials = { baseUrl: WECHAT_BASE_URL, token: binding.bot_token }
      const updatesBuf = binding.updates_buf ?? ''

      const res = await getUpdates(creds, updatesBuf, DEFAULT_POLL_TIMEOUT_MS)

      if (res.errcode === -14) {
        console.error(`[wechat-poller] Session expired for user ${binding.user_id}`)
        await db.update(userWechatBindings)
          .set({ updates_buf: 'SESSION_EXPIRED' })
          .where(eq(userWechatBindings.user_id, binding.user_id)).run()
        continue
      }

      if (res.ret && res.ret !== 0) continue

      // 保存 cursor
      const now = Math.floor(Date.now() / 1000)
      if (res.updatesBuf !== undefined) {
        await db.update(userWechatBindings)
          .set({ updates_buf: res.updatesBuf, last_poll_at: now })
          .where(eq(userWechatBindings.user_id, binding.user_id)).run()
      } else {
        await db.update(userWechatBindings)
          .set({ last_poll_at: now })
          .where(eq(userWechatBindings.user_id, binding.user_id)).run()
      }

      // 处理每条消息
      for (const raw of res.msgs) {
        const parsed = parseIncoming(raw)
        if (!parsed || !parsed.inbound.content) continue
        try {
          await handleWechatMessage({
            userId: binding.user_id,
            senderId: parsed.inbound.senderId,
            text: parsed.inbound.content,
            botToken: binding.bot_token,
            contextToken: parsed.contextToken,
          })
        } catch (e) {
          console.error(`[wechat-poller] Message processing failed for user ${binding.user_id}:`, (e as Error).message)
        }
      }
    } catch (e) {
      console.error(`[wechat-poller] Poll failed for user ${binding.user_id}:`, (e as Error).message)
    }
  }
}

export function startWechatPoller(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (pollTimer) return
  console.log(`[wechat-poller] Starting with interval ${intervalMs}ms`)
  pollOnce().catch((e) => console.error('[wechat-poller] Initial poll failed:', e))
  pollTimer = setInterval(() => {
    pollOnce().catch((e) => console.error('[wechat-poller] Poll cycle failed:', e))
  }, intervalMs)
  pollTimer.unref()
}

export function stopWechatPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
    console.log('[wechat-poller] Stopped')
  }
}