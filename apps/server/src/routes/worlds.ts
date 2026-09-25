// ============================================================
// World Routes — 世界模拟的创生 / 读取 / 法则编辑
// ============================================================
// 世界不走「新会话草稿态」（D34）：创生时立即落库。理由见 DECISIONS 中世界模拟那条。
//
// 创生流程刻意是「立即建行 + 异步生成地形 + 实时通知」而非「在 POST 里同步等 LLM」：
//   · 同步等待会把一个 10~60s 的 XHR 挂在代理超时边界上（nginx 默认 60s），
//     钉钉 Android WebView 尤其容易把这种「长时间无字节流动」的请求判死；
//   · 异步则生成中刷新页面 / 关标签都能恢复，失败也有持久痕迹；
//   · 而且这本来就是世界的形状 —— 世界是长生命周期对象，生成只是它的第一个 job。

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { randomUUID } from 'crypto'
import { db, conversations, groupConversationAgents, agents, worlds } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { NEUTRAL_AGENT_ID } from '@momoi/shared/constants'
import { WORLD_LIMITS } from '@momoi/shared/world'
import type { ServerMessage } from '@momoi/shared/types'
import { broadcastConversationSync, broadcastWorldEvent, broadcastWorldTurn } from '../lib/realtime.js'
import {
  appendWorldEvents,
  claimWorldTurn,
  ensureWorldEntities,
  getWorldState,
  isWorldGenerating,
  listWorldEntities,
  listWorldEvents,
  releaseWorldTurn,
  resumeWorldGeneration,
  updateWorldLaws,
} from '../lib/world.js'
import { runWorldTurn } from '../ai/world-orchestrator.js'
import { trackUserActivity } from './user.js'

function getUserId(c: any): string {
  return c.get('userId') || ''
}

/** 快照里返回的最近事件条数 */
const EVENT_PAGE_SIZE = 200
/** 回合开始时喂给编排器的事件条数（Agent 简报只取其中最近 20 条） */
const TURN_CONTEXT_EVENTS = 60
/** 上帝在事件日志里的显示名 */
const GOD_NAME = '上帝'

export const worldsRoute = new Hono()
worldsRoute.use('*', userAuthMiddleware)

/**
 * 创生世界。
 *
 * 请求：{ prompt, agent_ids, title?, }
 *   `prompt` 是用户编写的那一段世界描述 —— 同时覆盖「世界地形规则」与「世界法则」，
 *   由 world-generator 拆成结构化的 terrain 与可编辑的 laws（落在 worlds.terrain_prompt
 *   列上：那一列记录的是**地形规则的来源**，创生后不可修改，故列名与字段名不同）。
 */
worldsRoute.post('/', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<{
    prompt?: string
    agent_ids?: string[]
    title?: string
  }>()

  const prompt = (body.prompt ?? '').trim().slice(0, WORLD_LIMITS.maxPromptLength)
  if (!prompt) return c.json({ error: 'A world prompt is required' }, 400)

  // 世界模拟要求至少 1 个 Agent（与群聊的「至少 2 个」不同）
  const agentIds = (body.agent_ids ?? []).filter((id) => id && id !== NEUTRAL_AGENT_ID)
  if (agentIds.length < WORLD_LIMITS.minAgents) {
    return c.json({ error: 'At least one agent is required' }, 400)
  }

  const convId = randomUUID()
  const now = Math.floor(Date.now() / 1000)

  // 无 db.transaction()（sql.js 适配层不支持）—— 顺序写入
  await db.insert(conversations).values({
    id: convId,
    user_id: userId,
    title: (body.title || prompt.slice(0, 40) || '世界模拟'),
    agent_id: agentIds[0],
    type: 'world',
    created_at: now,
    updated_at: now,
  }).run()

  // 成员复用群聊关联表：世界的参与 Agent 与群聊成员结构完全同构
  // （同样的列、同样的排序语义、同样的生命周期）
  await db.insert(groupConversationAgents).values(
    agentIds.map((aid, idx) => ({ conversation_id: convId, agent_id: aid, sort_order: idx })),
  ).run()

  await db.insert(worlds).values({
    conversation_id: convId,
    terrain_prompt: prompt,
    terrain_spec: '',
    laws: '',
    status: 'generating',
    status_error: '',
    turn: 0,
    created_at: now,
    updated_at: now,
  }).run()

  broadcastConversationSync(userId)
  trackUserActivity(userId).catch(() => {})

  // 起火异步生成：不 await，故 POST 在毫秒级返回。地形就绪后由 world_status 事件通知。
  resumeWorldGeneration(convId, userId)

  const world = await getWorldState(convId, userId)
  const conv = await db.select().from(conversations).where(eq(conversations.id, convId)).get()
  return c.json({ conversation: conv, world }, 201)
})

// 读取世界状态。归属校验交给 getWorldState（含 deleted_at 过滤）。
worldsRoute.get('/:id', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const id = c.req.param('id')
  const world = await getWorldState(id, userId)
  if (!world) return c.json({ error: 'Not found' }, 404)

  // 惰性自愈：声称在生成、却没有任何任务在跑 ⇒ 一定是被进程重启打断的。
  // 直接重新生成（生成幂等），而不是标一个「失败」再让用户手动重试。
  if (world.status === 'generating' && !isWorldGenerating(id)) {
    resumeWorldGeneration(id, userId)
  }

  const rows = await db.select({
    agent_id: groupConversationAgents.agent_id,
    name: agents.name,
    avatar: agents.avatar,
  })
    .from(groupConversationAgents)
    .innerJoin(agents, eq(groupConversationAgents.agent_id, agents.id))
    .where(eq(groupConversationAgents.conversation_id, id))
    .orderBy(groupConversationAgents.sort_order)
    .all()

  // 地形就绪但没有实体（例如实体表是后加的）→ 就地补播种，让世界自愈
  const entities = world.status === 'ready' && world.terrain_spec
    ? await ensureWorldEntities(id, world.terrain_spec)
    : await listWorldEntities(id)
  const events = await listWorldEvents(id, EVENT_PAGE_SIZE)

  return c.json({
    world,
    entities,
    events,
    agents: rows.map((r: { agent_id: string; name: string; avatar: string }) => ({
      id: r.agent_id,
      name: r.name,
      avatar: r.avatar,
    })),
  })
})

/**
 * 编辑世界法则 —— 世界唯一的可变项。
 *
 * **服务端的这条拒绝才是「地形规则不可修改」的保证本身**；在界面上藏起输入框不算。
 */
worldsRoute.patch('/:id', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const id = c.req.param('id')
  const body = await c.req.json<{ laws?: string; terrain_prompt?: string; prompt?: string }>()

  if (body.terrain_prompt !== undefined || body.prompt !== undefined) {
    return c.json({ error: 'terrain_prompt is immutable' }, 400)
  }
  if (typeof body.laws !== 'string') {
    return c.json({ error: 'Nothing to update' }, 400)
  }
  const before = ((await getWorldState(id, userId))?.laws ?? '').trim()

  const world = await updateWorldLaws(id, userId, body.laws)
  if (!world) return c.json({ error: 'Not found' }, 404)

  // 法则变更也进事件日志：既是一份审计轨迹，也让「法则何时被改过」进入
  // 后续回合 Agent 可见的历史 —— 否则旧法则下的行动会显得毫无来由。
  if (body.laws.trim() !== before) {
    const saved = await appendWorldEvents(id, world.turn, [{
      actorKind: 'god',
      actorId: null,
      actorName: GOD_NAME,
      kind: 'law',
      content: body.laws.trim() ? `改写了世界法则：${body.laws.trim()}` : '撤去了世界法则',
      payload: { laws: body.laws.trim() },
    }])
    for (const e of saved) broadcastWorldEvent(userId, id, e)
  }

  return c.json({ world })
})

/**
 * 上帝行动 —— 跑一个回合（SSE）。
 *
 * **不复用 `POST /api/chat`**：那个处理函数是 ~600 行围绕**消息**的机制（落库、追问建议、
 * 语音合成、无限模式、ask_user、附件、群聊编排），对世界回合全部不适用；逐一加分支会把
 * 两者都拖成杂糅。世界有自己的落库目标（world_events 而非 messages）与自己的编排器。
 */
worldsRoute.post('/:id/act', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const id = c.req.param('id')
  const body = await c.req.json<{ content?: string; language?: string }>()
  const content = (body.content ?? '').trim().slice(0, WORLD_LIMITS.maxGodActionLength)
  if (!content) return c.json({ error: 'An action is required' }, 400)

  const world = await getWorldState(id, userId)
  if (!world) return c.json({ error: 'Not found' }, 404)
  if (world.status !== 'ready' || !world.terrain_spec) {
    return c.json({ error: 'World is not ready' }, 409)
  }
  // 并发守卫：一个世界同时只允许一个回合，否则两个回合会交错写 turn 与实体位置
  if (!claimWorldTurn(id)) {
    return c.json({ error: 'A turn is already running in this world' }, 409)
  }

  const spec = world.terrain_spec
  const entities = await ensureWorldEntities(id, spec)
  const recentEvents = await listWorldEvents(id, TURN_CONTEXT_EVENTS)
  const turn = world.turn + 1
  await db.update(worlds).set({ turn, updated_at: Math.floor(Date.now() / 1000) })
    .where(eq(worlds.conversation_id, id)).run()

  return streamSSE(c, async (stream) => {
    const abort = new AbortController()
    stream.onAbort(() => abort.abort())

    // 写入串行化：与 chat.ts 同款，防止流关闭时尾部事件丢失
    // 用 Promise<unknown> 而非 void：stream.write 返回 StreamingApi，链式 then 会带上它
    let writeChain: Promise<unknown> = Promise.resolve()
    let closed = false
    const send = (msg: ServerMessage): void => {
      // 他设备：单条事件与回合生命周期分别中继（源设备自己直接读这个流）
      if (msg.type === 'world_event') broadcastWorldEvent(userId, id, msg.event)
      else if (msg.type === 'world_turn_start') broadcastWorldTurn(userId, id, msg.turn, true)
      else if (msg.type === 'world_turn_end') broadcastWorldTurn(userId, id, msg.turn, false)
      if (closed) return
      writeChain = writeChain
        .then(() => stream.writeSSE({ data: JSON.stringify(msg), event: 'message' }))
        .catch(() => { closed = true })
    }

    const keepalive = setInterval(() => {
      // SSE 注释行保活 —— 防止代理/浏览器关闭空闲连接（与 chat.ts 同款）
      if (!closed) writeChain = writeChain.then(() => stream.write(':keepalive\n\n')).catch(() => { closed = true })
    }, 15_000)

    try {
      await runWorldTurn({
        conversationId: id,
        userId,
        turn,
        spec,
        laws: world.laws,
        godAction: content,
        entities,
        recentEvents,
        send,
        signal: abort.signal,
        language: body.language,
      })
    } catch (err) {
      // runWorldTurn 内部已逐个体容错；能走到这里说明是编排层本身的意外
      send({ type: 'error', message: `世界回合失败：${(err as Error).message}` })
    } finally {
      clearInterval(keepalive)
      releaseWorldTurn(id)
      broadcastWorldTurn(userId, id, turn, false)
      await writeChain   // 流关闭前 flush 尾部事件
    }
  })
})
