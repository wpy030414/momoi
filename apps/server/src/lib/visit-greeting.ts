// ============================================================
// Visit Greeting — 用户访问时 Agent 主动打招呼
// ============================================================
// 用户通过 SSE 首次连接时（getActiveDeviceCount === 1），
// 随机选一个 ≥2h 没发过消息的 Agent，主动发一条招呼消息。
// 找不到符合条件的 Agent 则不发。
//
// 触发点：routes/events.ts（首设备连接后 fire-and-forget）
// 复用：push-scheduler 的 getConversedAgents / getRandomDelay
// 产出：写入 messages 表 + broadcastStream + broadcastUnreadUpdate

import { db, conversations, messages } from '../db/index.js'
import { and, eq, desc } from 'drizzle-orm'
import { getAgent } from '../lib/config.js'
import { streamChatCompletion } from '../ai/provider.js'
import { getConfig } from '../lib/config.js'
import { getConversedAgents, getRandomDelay } from '../lib/push-scheduler.js'
import { broadcastStream, broadcastConversationSync, broadcastUnreadUpdate } from '../lib/realtime.js'
import { countUnread } from './unread.js'
import type { ChatMessage } from '../ai/provider.js'

// ---- Helpers ----

/** 查询用户与某 Agent 最后一次 assistant 消息的时间戳与所属会话 ID */
async function getLastAssistantMessage(
  userId: string,
  agentId: string,
): Promise<{ convId: string; createdAt: number } | null> {
  const rows = await db
    .select({
      conv_id: conversations.id,
      created_at: messages.created_at,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversation_id, conversations.id))
    .where(
      and(
        eq(conversations.user_id, userId),
        eq(conversations.agent_id, agentId),
        eq(conversations.type, 'direct'),
        eq(messages.role, 'assistant'),
      ),
    )
    .orderBy(desc(messages.created_at))
    .limit(1)
    .all()

  const row = rows[0]
  if (!row) return null
  return { convId: row.conv_id, createdAt: row.created_at }
}

/** 收集流式 AI 结果为完整字符串 */
async function collectAIResponse(
  config: Awaited<ReturnType<typeof getConfig>>,
  model: string,
  chatMessages: ChatMessage[],
): Promise<string> {
  let content = ''
  for await (const event of streamChatCompletion(config, model, chatMessages, [], false)) {
    if (event.type === 'token' && event.text) {
      content += event.text
    }
  }
  return content.trim()
}

// ---- Main ----

export async function triggerVisitGreeting(userId: string): Promise<void> {
  try {
    // 1. 查询对话过的 Agent
    const agentIds = await getConversedAgents(userId)
    if (agentIds.length === 0) {
      console.log(`[visit-greeting] User ${userId} has no conversed agents, skipping`)
      return
    }

    // 2. 查询每个 Agent 的最后一次 assistant 消息时间
    const threshold = Math.floor(Date.now() / 1000) - 105 * 60 // 105min = 2h - 15min
    const candidates: Array<{ agentId: string; convId: string; lastAssistantAt: number }> = []

    for (const agentId of agentIds) {
      const lastMsg = await getLastAssistantMessage(userId, agentId)
      if (lastMsg && lastMsg.createdAt < threshold) {
        candidates.push({
          agentId,
          convId: lastMsg.convId,
          lastAssistantAt: lastMsg.createdAt,
        })
      }
    }

    if (candidates.length === 0) {
      console.log(`[visit-greeting] User ${userId}: no agents qualify (all active within 105min)`)
      return
    }

    // 3. 随机选一个
    const selected = candidates[Math.floor(Math.random() * candidates.length)]
    const agent = await getAgent(selected.agentId)
    if (!agent) {
      console.log(`[visit-greeting] Agent ${selected.agentId} not found, skipping`)
      return
    }

    console.log(
      `[visit-greeting] User ${userId}: agent ${agent.name} (last active ${Math.round((Date.now() / 1000 - selected.lastAssistantAt) / 60)}min ago), greeting...`,
    )

    // 4. AI 生成招呼内容
    const config = await getConfig()
    const chatMessages: ChatMessage[] = [
      { role: 'system', content: agent.system_prompt },
      {
        role: 'user',
        content: `用户刚打开页面回来了，主动打个招呼。用你的性格和语气自然地表示欢迎，不超过50字，不要重复之前的内容。`,
      },
    ]

    let greetingContent: string
    try {
      greetingContent = await collectAIResponse(config, agent.model, chatMessages)
      if (!greetingContent) {
        greetingContent = `${agent.name} 欢迎回来～`
      }
    } catch (err) {
      console.error(`[visit-greeting] AI generation failed for agent ${selected.agentId}:`, (err as Error).message)
      greetingContent = `${agent.name} 欢迎回来～`
    }

    // 5. 写入 messages 表
    const createdAt = Math.floor(Date.now() / 1000)
    await db.insert(messages).values({
      conversation_id: selected.convId,
      role: 'assistant',
      content: greetingContent,
      agent_id: selected.agentId,
      created_at: createdAt,
    }).run()

    // 更新会话 updated_at
    await db.update(conversations)
      .set({ updated_at: createdAt })
      .where(eq(conversations.id, selected.convId))
      .run()

    console.log(`[visit-greeting] Wrote greeting for user ${userId} agent ${agent.name}: "${greetingContent}"`)

    // 6. 广播给所有设备
    broadcastStream(userId, '', {
      conversation_id: selected.convId,
      event: {
        type: 'done',
        conversation_id: selected.convId,
        reply: greetingContent,
        suggestions: [],
        agent_id: selected.agentId,
        agent_name: agent.name,
      },
    })
    broadcastConversationSync(userId)
    broadcastUnreadUpdate(userId, selected.convId, await countUnread(selected.convId))
  } catch (err) {
    console.error(`[visit-greeting] Error for user ${userId}:`, (err as Error).message)
  }
}