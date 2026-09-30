// ============================================================
// World Routes — 世界模拟的创建 / 读取 / 法则编辑
// ============================================================
// 世界模拟是群聊的变体（conversations.type = 'world'）：成员复用
// group_conversation_agents，消息走 messages 表与 POST /api/chat 的群聊编排。
// 本路由只负责三件事：
//   1. 创建世界会话（同步落库 —— 创建即就绪）
//   2. 读取世界法则
//   3. 修改世界法则（世界唯一的可变项）
//
// 世界只需要法则：世界不依赖描述生成初始内容，Agent 的人设就是它的身份，
// 法则就是它的约束。额外的世界描述只会稀释法则的权重。

import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { ErrCode } from '@momoi/shared/errors'
import { db, conversations, groupConversationAgents, agents, worlds } from '../db/index.js'
import { eq, and, sql } from 'drizzle-orm'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { NEUTRAL_AGENT_ID } from '@momoi/shared/constants'
import { ApiError } from '../lib/apiError.js'
import { broadcastConversationSync } from '../lib/realtime.js'
import { trackUserActivity } from './user.js'
import { resolveWorkspaceAnchor } from './workspaces.js'

function getUserId(c: any): string {
  return c.get('userId') || ''
}

export const worldsRoute = new Hono()
worldsRoute.use('*', userAuthMiddleware)

/** 文本上限：法则为整段文本，超出直接截断（前端另有 maxlength 提示） */
const MAX_TEXT_LENGTH = 2000

/** 读取世界行（含归属校验：不存在 / 他人所有 / 已软删统一 404，防探测） */
async function findWorld(conversationId: string, userId: string) {
  const row = await db.select({
    conversation_id: worlds.conversation_id,
    laws: worlds.laws,
    created_at: worlds.created_at,
    updated_at: worlds.updated_at,
  })
    .from(worlds)
    .innerJoin(conversations, eq(worlds.conversation_id, conversations.id))
    .where(and(
      eq(worlds.conversation_id, conversationId),
      eq(conversations.user_id, userId),
      sql`${conversations.deleted_at} IS NULL`,
    ))
    .get()
  return row ?? null
}

/** 世界成员（结构与群聊成员完全同构） */
async function listWorldAgents(conversationId: string) {
  const rows = await db.select({
    agent_id: groupConversationAgents.agent_id,
    name: agents.name,
    avatar: agents.avatar,
  })
    .from(groupConversationAgents)
    .innerJoin(agents, eq(groupConversationAgents.agent_id, agents.id))
    .where(eq(groupConversationAgents.conversation_id, conversationId))
    .orderBy(groupConversationAgents.sort_order)
    .all()
  return rows.map((r: { agent_id: string; name: string; avatar: string }) => ({
    id: r.agent_id,
    name: r.name,
    avatar: r.avatar,
  }))
}

/**
 * 创建世界。
 *
 * 请求：{ laws?, agent_ids, title? }
 *   `laws` 是世界法则 —— 可留空，之后随时修改。
 *
 * 同步创建（无任何异步生成）：世界只是 法则 + 一群 Agent，落库即诞生。
 * 世界不需要 description：不依赖描述生成初始内容；Agent 的人设本身就是身份，
 * 法则就是约束，额外描述反而稀释法则。
 */
worldsRoute.post('/', async (c) => {
  const userId = getUserId(c)
  if (!userId) throw new ApiError(ErrCode.UNAUTHORIZED)

  const body = await c.req.json<{
    laws?: string
    agent_ids?: string[]
    title?: string
    workspace_id?: string | null
  }>()

  // 至少 1 个 Agent（群聊要求 ≥2，世界无此约束 —— 一个人的世界也是世界）
  const agentIds = (body.agent_ids ?? []).filter((id) => id && id !== NEUTRAL_AGENT_ID)
  if (agentIds.length < 1) {
    throw new ApiError(ErrCode.WORLD_AGENTS_REQUIRED)
  }

  // 分组工作区：创建时锁定（永不 UPDATE）；归属校验失败统一 404 防探测
  const workspaceAnchor = await resolveWorkspaceAnchor(body.workspace_id, userId)

  const convId = randomUUID()
  const now = Math.floor(Date.now() / 1000)

  // 无 db.transaction()（sql.js 适配层不支持）—— 顺序写入
  await db.insert(conversations).values({
    id: convId,
    user_id: userId,
    title: (body.title || '').trim().slice(0, 40) || '世界模拟',
    agent_id: agentIds[0],
    type: 'world',
    workspace_id: workspaceAnchor,
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
    laws: (body.laws ?? '').trim().slice(0, MAX_TEXT_LENGTH),
    created_at: now,
    updated_at: now,
  }).run()

  broadcastConversationSync(userId)
  trackUserActivity(userId).catch(() => {})

  const world = await findWorld(convId, userId)
  const conv = await db.select().from(conversations).where(eq(conversations.id, convId)).get()
  return c.json({ conversation: conv, world }, 201)
})

// 读取世界（法则 + 成员）。归属校验在 findWorld（含 deleted_at 过滤）。
worldsRoute.get('/:id', async (c) => {
  const userId = getUserId(c)
  if (!userId) throw new ApiError(ErrCode.UNAUTHORIZED)

  const id = c.req.param('id')
  const world = await findWorld(id, userId)
  if (!world) throw new ApiError(ErrCode.WORLD_NOT_FOUND)

  return c.json({ world, agents: await listWorldAgents(id) })
})

// 编辑世界法则 —— 世界唯一的可变项。
worldsRoute.patch('/:id', async (c) => {
  const userId = getUserId(c)
  if (!userId) throw new ApiError(ErrCode.UNAUTHORIZED)

  const id = c.req.param('id')
  const body = await c.req.json<{ laws?: string }>()

  if (typeof body.laws !== 'string') {
    throw new ApiError(ErrCode.WORLD_NOTHING_TO_UPDATE)
  }

  const existing = await findWorld(id, userId)
  if (!existing) throw new ApiError(ErrCode.WORLD_NOT_FOUND)

  const laws = body.laws.trim().slice(0, MAX_TEXT_LENGTH)
  const now = Math.floor(Date.now() / 1000)
  await db.update(worlds).set({ laws, updated_at: now })
    .where(eq(worlds.conversation_id, id)).run()

  const world = await findWorld(id, userId)
  return c.json({ world })
})