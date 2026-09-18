/**
 * 微信消息轮询器：定时遍历所有已绑定用户，拉取新消息并桥接处理。
 * 通道状态（updates_buf / session_expired）都在 wechat_bindings 表。
 */
import { db, conversations, wechatBindings } from '../db.js'
import { eq, and, sql } from 'drizzle-orm'
import { getUpdates, WECHAT_BASE_URL, DEFAULT_POLL_TIMEOUT_MS, parseIncoming, type WechatCredentials } from './ilink.js'
import { handleWechatMessage } from './chat.js'

const DEFAULT_INTERVAL_MS = 5_000
let pollTimer: ReturnType<typeof setTimeout> | null = null
/** Per-user guard: prevents overlapping getUpdates for the same user across cycles */
const busyUsers = new Set<string>()

type BindingRow = typeof wechatBindings.$inferSelect

/** 仅轮询「已绑定到未删除会话」的行；未绑定会话 / 绑定会话已删的跳过 */
async function pollAll(): Promise<void> {
  const cycleStart = Date.now()
  const bindings = await db.select().from(wechatBindings).all()
  if (bindings.length === 0) return

  // Resolve which bound conversations are still alive (not soft-deleted)
  const active = bindings.filter(
    (b: BindingRow) => !b.session_expired && !!b.bot_token,
  )
  const convChecks = await Promise.all(
    active.map(async (b: BindingRow) => {
      if (!b.conversation_id) return false
      const conv = await db.select({ id: conversations.id }).from(conversations)
        .where(and(
          eq(conversations.id, b.conversation_id),
          sql`${conversations.deleted_at} IS NULL`,
        )).get()
      if (!conv) {
        // Binding points at a deleted conversation — self-heal (B3):
        // remove the binding so the user can rebind.
        console.log(`[wechat-poller] Binding for user ${b.user_id} points at deleted conversation ${b.conversation_id}, clearing`)
        await db.delete(wechatBindings).where(eq(wechatBindings.user_id, b.user_id)).run()
        return false
      }
      return true
    }),
  )
  const activeToPoll = active.filter((b: BindingRow, i: number) => convChecks[i] && !busyUsers.has(b.user_id))

  await Promise.allSettled(
    activeToPoll.map((b: BindingRow) => {
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

  // Token-generation guard (A1): the pollUser closure holds a snapshot of this
  // binding taken at cycle start. If the user re-bound (bot_token replaced by a
  // new QR scan) while getUpdates was in flight, this write must NOT touch the
  // new binding row — otherwise a stale -14/cursor would poison the fresh
  // binding (expiry loop / cursor clobber). Scope every write by the
  // exact bot_token we actually polled.
  const writeGuard = eq(wechatBindings.bot_token, binding.bot_token)

  if (res.errcode === -14) {
    console.error(`[wechat-poller] Session expired for user ${binding.user_id}`)
    await db.update(wechatBindings)
      .set({ session_expired: true })
      .where(and(eq(wechatBindings.user_id, binding.user_id), writeGuard)).run()
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
  if (res.updatesBuf !== undefined) {
    await db.update(wechatBindings)
      .set({ updates_buf: res.updatesBuf })
      .where(and(eq(wechatBindings.user_id, binding.user_id), writeGuard)).run()
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