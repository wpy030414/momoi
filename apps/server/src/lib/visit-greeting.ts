// ============================================================
// Visit Greeting — 用户访问时 Agent 主动打招呼
// ============================================================
// 用户通过 SSE 首次连接时（getActiveDeviceCount === 1），
// 随机选一个对话过的 Agent，主动发一条招呼消息——每次上线都触发。
// 同一用户 5 分钟内重复上线（如刷新页面导致 SSE 重连）只问候一次。
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

/** 同一用户两次问候的最小间隔。刷新页面会让 SSE 断开重连、
 *  设备数重新回到 1——若不防抖，每次刷新都会弹一条推送。 */
const GREETING_DEBOUNCE_MS = 5 * 60 * 1000

const lastGreetedAt = new Map<string, number>()

export async function triggerVisitGreeting(userId: string): Promise<void> {
  try {
    // 0. 防抖：先占位再生成，并发上线（双标签页同时打开）也只问候一次
    const last = lastGreetedAt.get(userId) ?? 0
    if (Date.now() - last < GREETING_DEBOUNCE_MS) {
      console.log(
        `[visit-greeting] User ${userId} greeted ${Math.round((Date.now() - last) / 1000)}s ago, skipping (debounce)`,
      )
      return
    }
    lastGreetedAt.set(userId, Date.now())

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
    // 空 system_prompt 会以 {"role":"system","content":""} 发出，
    // 上游（DEAP/deepseek）对此返回 550 unknownServerError——
    // 与 pi-adapter 的 buildSystemPrompt 相同的兜底链，且绝不发送空 system 消息。
    const config = await getConfig()
    const systemPrompt =
      agent.system_prompt || DEFAULT_SYSTEM_PROMPT || '你是 Momoi，一个由**杏仁鹿**缔造的 Agent，最擅长与用户玩角色扮演的游戏。'
    const chatMessages: ChatMessage[] = [
      ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
      {
        role: 'user' as const,
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