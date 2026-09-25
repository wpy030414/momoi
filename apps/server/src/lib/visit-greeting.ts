// ============================================================
// Visit Greeting — 用户访问时 Agent 主动打招呼
// ============================================================
// 用户通过 SSE 首次连接时（getActiveDeviceCount === 1），
// 随机选一个对话过的 Agent，主动发一条招呼消息——每次上线都触发。
// 不做防抖：把「距上次问候的间隔」注入提示词（内存记录，重启清零），
// 间隔很短 = 用户在反复刷新，Agent 会自然察觉并假装生气吐槽。
//
// 触发点：routes/events.ts（首设备连接后 fire-and-forget）
// 复用：push-scheduler 的 getConversedAgents / sendWebPush
// 产出：仅 Web Push 浏览器通知（不落库）

import { getAgent } from '../lib/config.js'
import { streamChatCompletion } from '../ai/provider.js'
import { describeNetworkError } from '../ai/provider.js'
import { getConfig } from '../lib/config.js'
import { getConversedAgents, sendWebPush } from '../lib/push-scheduler.js'
import { DEFAULT_SYSTEM_PROMPT } from '@momoi/shared/constants'
import type { ChatMessage } from '../ai/provider.js'

// ---- Helpers ----

/** 收集流式 AI 结果为完整字符串。当流正常结束但未产生任何 token 时,
 *  抛出错误——避免空字符串回传给 JSON.parse 后只得到无意义的 SyntaxError。 */
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
  const result = content.trim()
  if (!result) throw new Error('AI stream produced no content')
  return result
}

// ---- Main ----

/** 每用户上次问候推送的时间戳（内存，不落库、重启清零）。
 *  不防抖：每次上线都问候；把间隔注入提示词，由 Agent 自己
 *  察觉「用户在反复刷新」并作出反应。 */
const lastGreetedAt = new Map<string, number>()

/** 间隔毫秒 → 人类友好的相对时间 */
function describeSince(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒前`
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`
  return `${Math.round(s / 3600)} 小时前`
}

export async function triggerVisitGreeting(userId: string): Promise<void> {
  try {
    // 0. 读取上次问候时间并立刻占位（并发上线时，至多一个读到旧值）
    const last = lastGreetedAt.get(userId)
    lastGreetedAt.set(userId, Date.now())
    const sinceLast = last ? describeSince(Date.now() - last) : null

    // 1. 查询对话过的 Agent
    const agentIds = await getConversedAgents(userId)
    if (agentIds.length === 0) {
      console.log(`[visit-greeting] User ${userId} has no conversed agents, skipping`)
      return
    }

    // 2. 随机选一个——每次上线都触发，不再有静默期筛选
    const selectedAgentId = agentIds[Math.floor(Math.random() * agentIds.length)]
    const agent = await getAgent(selectedAgentId)
    if (!agent) {
      console.log(`[visit-greeting] Agent ${selectedAgentId} not found, skipping`)
      return
    }

    console.log(`[visit-greeting] User ${userId}: agent ${agent.name} greeting...`)

    // 3. AI 生成招呼内容
    const config = await getConfig()
    const systemPrompt =
      agent.system_prompt || DEFAULT_SYSTEM_PROMPT || '你是 Momoi，一个由**杏仁鹿**缔造的 Agent，最擅长与用户玩角色扮演的游戏。'

    // 根据距上次问候的间隔拼装不一样的欢迎词。反复刷新（间隔短）
    // → Agent 察觉用户拿自己刷着玩，假装生气吐槽；间隔长 → 正常欢迎。
    const refreshHint = sinceLast
      ? `（说明：用户刚才 ${sinceLast} 也打开过页面，这是短时间内又一次。"你干嘛反复开关页面，拿我刷着玩是吧？"）`
      : `（说明：用户很久没来了，用活泼欢迎的语气说话。）`

    const chatMessages: ChatMessage[] = [
      ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
      {
        role: 'user' as const,
        content: `用户刚打开页面回来了，主动打个招呼。${refreshHint}\n要求：\n1. 用你的性格和语气自然地表示欢迎，以第一人称\n2. 标题不超过8字，正文不超过50字\n3. 严格按 JSON 格式回复，不要包含其他内容：{"title":"...","body":"..."}`,
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
      // describeNetworkError 展开 undici 藏在 err.cause（含 Happy
      // Eyeballs AggregateError.errors）里的连接层根因
      console.error(`[visit-greeting] AI generation failed for agent ${selectedAgentId}:`, describeNetworkError(err))
    }
    if (!title) title = agent.name
    if (!body) body = `欢迎回来～`

    // 4. Web Push 发送（不落库）
    const sent = await sendWebPush(userId, title, body)
    if (sent > 0) {
      console.log(`[visit-greeting] Sent web push to ${sent} device(s) for user ${userId} agent ${agent.name}: title="${title}" body="${body}"`)
    } else {
      console.warn(`[visit-greeting] Web push NOT delivered for user ${userId} (agent ${agent.name}): title="${title}" body="${body}"`)
    }
  } catch (err) {
    console.error(`[visit-greeting] Error for user ${userId}:`, (err as Error).message)
  }
}