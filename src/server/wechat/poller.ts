/**
 * 微信消息轮询器：定时遍历所有已绑定用户，拉取新消息并桥接处理。
 * polling cursor 已合入 userWechatBindings 表（updates_buf / last_poll_at）。
 */
import { db, userWechatBindings } from '../db.js'
import { eq } from 'drizzle-orm'
import { getUpdates, WECHAT_BASE_URL, DEFAULT_POLL_TIMEOUT_MS, parseIncoming, type WechatCredentials } from './ilink.js'
import { handleWechatMessage } from './chat.js'

const DEFAULT_INTERVAL_MS = 3_000
let pollTimer: ReturnType<typeof setTimeout> | null = null
/** Per-user guard: prevents overlapping getUpdates for the same user across cycles */
const busyUsers = new Set<string>()

type BindingRow = typeof userWechatBindings.$inferSelect

async function pollAll(): Promise<void> {
  const cycleStart = Date.now()
  const bindings = await db.select().from(userWechatBindings).all()
  if (bindings.length === 0) return

  const active = bindings.filter(
    (b: BindingRow) => b.updates_buf !== 'SESSION_EXPIRED' && !busyUsers.has(b.user_id),
  )
  await Promise.allSettled(
    active.map((b: BindingRow) => {
        busyUsers.add(b.user_id)
        return pollUser(b).finally(() => busyUsers.delete(b.user_id))
      }),
  )

  const elapsed = Date.now() - cycleStart
  if (elapsed > 5_000) {
    console.warn(`[wechat-poller] Slow poll cycle: ${elapsed}ms`)
  }
}

async function pollUser(binding: BindingRow): Promise<void> {
  const creds: WechatCredentials = { baseUrl: WECHAT_BASE_URL, token: binding.bot_token }
  const updatesBuf = binding.updates_buf ?? ''

  const res = await getUpdates(creds, updatesBuf, DEFAULT_POLL_TIMEOUT_MS).catch((e) => {
    console.error(`[wechat-poller] getUpdates failed for user ${binding.user_id}:`, (e as Error).message)
    return null
  })
  if (!res) return

  if (res.errcode === -14) {
    console.error(`[wechat-poller] Session expired for user ${binding.user_id}`)
    await db.update(userWechatBindings)
      .set({ updates_buf: 'SESSION_EXPIRED' })
      .where(eq(userWechatBindings.user_id, binding.user_id)).run()
    return
  }

  if (res.ret && res.ret !== 0) return

  // Process messages first, THEN save cursor — prevents re-delivery if processing fails
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
        messageId: parsed.messageId,
      })
    } catch (e) {
      console.error(`[wechat-poller] Message processing failed for user ${binding.user_id}:`, (e as Error).message)
    }
  }

  // Save cursor after all messages processed
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
}

function scheduleNext(intervalMs: number): void {
  pollTimer = setTimeout(() => {
    pollAll()
      .catch((e) => console.error('[wechat-poller] Poll cycle failed:', e))
      .finally(() => scheduleNext(intervalMs))
  }, intervalMs)
  if (pollTimer.unref) pollTimer.unref()
}

export function startWechatPoller(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (pollTimer) return
  console.log(`[wechat-poller] Starting with interval ${intervalMs}ms, per-user guard + setTimeout recursion`)
  pollAll().catch((e) => console.error('[wechat-poller] Initial poll failed:', e))
  scheduleNext(intervalMs)
}

export function stopWechatPoller(): void {
  if (pollTimer) {
    clearTimeout(pollTimer)
    pollTimer = null
    console.log('[wechat-poller] Stopped')
  }
}