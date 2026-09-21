// ============================================================
// Push Scheduler — 离线推送通知调度器
// ============================================================
// 用户关闭所有设备后为每个用户启动定时器。定时器触发时：
// 1. 查询该用户对话过的所有 Agent → 随机选一个
// 2. 取该 Agent 最近更新的 direct 会话
// 3. 调用 AI 生成一条符合人设的通知消息
// 4. 写入 messages 表
// 5. 通过 Web Push 发送浏览器通知
// 6. 重新调度下一次（2h ± 15min）
//
// 深夜/凌晨时段（22:00-05:59）免打扰，延迟到 06:00。

import { db, conversations, messages, pushSubscriptions } from '../db/index.js'
import { and, eq, desc } from 'drizzle-orm'
import { listAgents, getAgent, getVapidKeys } from '../lib/config.js'
import { streamChatCompletion } from '../ai/provider.js'
import { getConfig } from '../lib/config.js'
import type { ChatMessage } from '../ai/provider.js'

// ---- Types ----

interface OfflineTimer {
  userId: string
  timer: NodeJS.Timeout
}

// ---- State ----

const timers = new Map<string, OfflineTimer>()

// ---- Helpers ----

/** 是否在免打扰时段（22:00-05:59） */
export function isQuietHours(): boolean {
  const now = new Date()
  const hour = now.getHours()
  const minute = now.getMinutes()
  const timeInMinutes = hour * 60 + minute
  // 22:00-05:59 (1320 - 360)
  return timeInMinutes >= 1320 || timeInMinutes < 360
}

/** 2h ± 15min 随机延迟 */
export function getRandomDelay(): number {
  const baseMs = 2 * 60 * 60 * 1000 // 2 hours
  const jitterMs = (Math.random() * 30 - 15) * 60 * 1000 // ±15 minutes
  return Math.max(30_000, baseMs + jitterMs) // minimum 30s for safety
}

/** 深夜时段结束的延迟（到 06:00） */
function delayToDawn(): number {
  const now = new Date()
  const dawn = new Date(now)
  dawn.setHours(6, 0, 0, 0)
  if (dawn <= now) {
    dawn.setDate(dawn.getDate() + 1)
  }
  return dawn.getTime() - now.getTime() + (Math.random() * 10 * 60 * 1000) // +0-10min jitter
}

/** 收集流式 AI 结果为完整字符串 */
async function collectAIResponse(config: Awaited<ReturnType<typeof getConfig>>, model: string, messages: ChatMessage[]): Promise<string> {
  let content = ''
  for await (const event of streamChatCompletion(config, model, messages, [], false)) {
    if (event.type === 'token' && event.text) {
      content += event.text
    }
  }
  return content.trim()
}

// ---- Agent Selection ----

/** 查询用户对话过的 Agent（有 user 消息的 direct 会话关联的 agent_id），去重 */
async function getConversedAgents(userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ agent_id: conversations.agent_id })
    .from(conversations)
    .innerJoin(messages, eq(messages.conversation_id, conversations.id))
    .where(
      and(
        eq(conversations.user_id, userId),
        eq(conversations.type, 'direct'),
        eq(messages.role, 'user'),
      ),
    )
    .all()

  return rows
    .map((r: typeof conversations.$inferSelect) => r.agent_id)
    .filter((id: string) => id)
}

/** 取该 Agent 最近更新的 direct 会话 */
async function getLatestConversation(userId: string, agentId: string): Promise<typeof conversations.$inferSelect | null> {
  const row = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.user_id, userId),
        eq(conversations.agent_id, agentId),
        eq(conversations.type, 'direct'),
      ),
    )
    .orderBy(desc(conversations.updated_at))
    .limit(1)
    .get()

  return (row as typeof conversations.$inferSelect) ?? null
}

// ---- Web Push ----

async function sendWebPush(userId: string, title: string, body: string): Promise<void> {
  try {
    const { publicKey, privateKey } = await getVapidKeys()
    const webPush = await import('web-push')

    webPush.setVapidDetails(
      'mailto:no-reply@momoi.local',
      publicKey,
      privateKey,
    )

    const subs = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.user_id, userId))
      .all()

    for (const sub of subs) {
      try {
        await webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          JSON.stringify({ title, body }),
        )
      } catch (err: any) {
        // 404/410 → subscription expired / unsubscribed → clean up
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await db
            .delete(pushSubscriptions)
            .where(eq(pushSubscriptions.endpoint, sub.endpoint))
            .run()
          console.log(`[push] Removed expired subscription for user ${userId}`)
        } else {
          console.error(`[push] Failed to send notification:`, err?.message ?? err)
        }
      }
    }
  } catch (err) {
    console.error(`[push] Web Push error for user ${userId}:`, (err as Error).message)
  }
}

// ---- Core Tick ----

async function tick(userId: string): Promise<void> {
  try {
    // 1. 检查是否仍是离线（timer 仍在说明没有新连接）
    if (!timers.has(userId)) return

    // 2. 免打扰时段 → 延迟到 06:00
    if (isQuietHours()) {
      const delay = delayToDawn()
      console.log(`[push] User ${userId} in quiet hours, rescheduling to +${Math.round(delay / 60000)}min`)
      scheduleTimer(userId, delay)
      return
    }

    // 3. 查询对话过的 Agent
    const agentIds = await getConversedAgents(userId)
    if (agentIds.length === 0) {
      console.log(`[push] User ${userId} has no conversed agents, skipping`)
      timers.delete(userId)
      return
    }

    // 4. 随机选一个
    const selectedAgentId = agentIds[Math.floor(Math.random() * agentIds.length)]
    const agent = await getAgent(selectedAgentId)
    if (!agent) {
      console.log(`[push] Agent ${selectedAgentId} not found for user ${userId}, skipping`)
      return
    }

    // 5. 取该 Agent 最近更新的会话
    const conv = await getLatestConversation(userId, selectedAgentId)
    if (!conv) {
      console.log(`[push] No conversation found for user ${userId} agent ${selectedAgentId}`)
      return
    }

    // 6. AI 生成通知内容
    const config = await getConfig()
    const now = Date.now()

    const messages: ChatMessage[] = [
      { role: 'system', content: agent.system_prompt },
      {
        role: 'user',
        content: `给用户发一条不超过50字的提醒消息。用你的性格和语气自然地催促用户回来，不要重复之前的内容。`,
      },
    ]

    let notificationContent: string
    try {
      notificationContent = await collectAIResponse(config, agent.model, messages)
      if (!notificationContent) {
        notificationContent = `${agent.name} 想念你了，快回来看看吧～`
      }
    } catch (err) {
      console.error(`[push] AI generation failed for agent ${selectedAgentId}:`, (err as Error).message)
      notificationContent = `${agent.name} 想念你了，快回来看看吧～`
    }

    // 7. 写入 messages
    const createdAt = Math.floor(now / 1000)
    await db.insert(messages).values({
      conversation_id: conv.id,
      role: 'assistant',
      content: notificationContent,
      agent_id: selectedAgentId,
      created_at: createdAt,
    }).run()

    // 更新会话的 updated_at
    await db.update(conversations)
      .set({ updated_at: createdAt })
      .where(eq(conversations.id, conv.id))
      .run()

    console.log(`[push] Wrote notification message for user ${userId} agent ${agent.name}: "${notificationContent}"`)

    // 8. Web Push 发送
    await sendWebPush(userId, `${agent.name} 想你了`, notificationContent)

    // 9. 清理旧定时器
    const existing = timers.get(userId)
    if (existing) {
      clearTimeout(existing.timer)
    }

    // 10. 重新调度下一次
    const nextDelay = getRandomDelay()
    console.log(`[push] Next notification for user ${userId} in +${Math.round(nextDelay / 60000)}min`)
    scheduleTimer(userId, nextDelay)
  } catch (err) {
    console.error(`[push] Tick error for user ${userId}:`, (err as Error).message)
    timers.delete(userId)
  }
}

// ---- Schedule / Cancel ----

function scheduleTimer(userId: string, delay: number): void {
  const timer = setTimeout(() => tick(userId), delay)
  timers.set(userId, { userId, timer })
}

/** 用户离线时调用 */
export function scheduleOfflineNotifications(userId: string): void {
  if (timers.has(userId)) return // 已存在则不重复

  const delay = getRandomDelay()
  console.log(`[push] User ${userId} went offline, first notification in +${Math.round(delay / 60000)}min`)
  scheduleTimer(userId, delay)
}

/** 用户上线时调用（取消所有待发送的定时器） */
export function cancelOfflineNotifications(userId: string): void {
  const existing = timers.get(userId)
  if (existing) {
    clearTimeout(existing.timer)
    timers.delete(userId)
    console.log(`[push] User ${userId} back online, cancelled pending notifications`)
  }
}