// ============================================================
// Visit Greeting — 用户访问时 Agent 主动打招呼
// ============================================================
// 用户通过 SSE 首次连接时（getActiveDeviceCount === 1），
// 随机选一个 ≥2h 没发过消息的 Agent，主动发一条招呼消息。
// 找不到符合条件的 Agent 则不发。
//
// 触发点：routes/events.ts（首设备连接后 fire-and-forget）
// 复用：push-scheduler 的 getConversedAgents / sendWebPush
// 产出：仅 Web Push 浏览器通知（不落库）

import { db, conversations, messages } from '../db/index.js'
import { and, eq, desc } from 'drizzle-orm'
import { getAgent } from '../lib/config.js'
import { streamChatCompletion } from '../ai/provider.js'
import { getConfig } from '../lib/config.js'
import { getConversedAgents, sendWebPush } from '../lib/push-scheduler.js'
import type { ChatMessage } from '../ai/provider.js'

// ---- Helpers ----

/** 查询用户与某 Agent 最后一次 assistant 消息的时间戳 */
async function getLastAssistantMessage(
  userId: string,
  agentId: string,
): Promise<number | null> {
  const rows = await db
    .select({
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
  return row.created_at
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
    const candidates: Array<{ agentId: string; lastAssistantAt: number }> = []

    for (const agentId of agentIds) {
      const lastMsg = await getLastAssistantMessage(userId, agentId)
      if (lastMsg && lastMsg < threshold) {
        candidates.push({
          agentId,
          lastAssistantAt: lastMsg,
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
        content: `用户刚打开页面回来了，主动打个招呼。要求：\n1. 用你的性格和语气自然地表示欢迎，以第一人称\n2. 标题不超过8字，正文不超过50字\n3. 严格按 JSON 格式回复，不要包含其他内容：{"title":"...","body":"..."}`,
      },
    ]

    let title = ''
    let body = ''
    try {
      const raw = await collectAIResponse(config, agent.model, chatMessages)
      const json = JSON.parse(raw)
      title = json.title || agent.name
      body = json.body || ''
    } catch (err) {
      console.error(`[visit-greeting] AI generation failed for agent ${selected.agentId}:`, (err as Error).message)
    }
    if (!title) title = agent.name
    if (!body) body = `欢迎回来～`

    // 5. Web Push 发送（不落库）
    await sendWebPush(userId, title, body)
    console.log(`[visit-greeting] Sent web push for user ${userId} agent ${agent.name}: title="${title}" body="${body}"`)
  } catch (err) {
    console.error(`[visit-greeting] Error for user ${userId}:`, (err as Error).message)
  }
}