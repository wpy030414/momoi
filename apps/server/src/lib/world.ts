// ============================================================
// World — 世界模拟的服务端状态层
// ============================================================
// 世界的归属**一律以 conversations 为准**（单一事实来源）——worlds 表刻意不存
// user_id，避免重复一份而与之漂移，那等于开出第二条鉴权路径。
//
// ⚠️ conversations 是**软删除**（只置 deleted_at）。因此：
//   1) worlds 行不会随会话删除而消失，没有 FK 级联要补；
//   2) 每一次世界读取都必须连带过滤 conversations.deleted_at IS NULL，
//      否则已删除会话的世界仍可被访问。

import { randomUUID } from 'crypto'
import { db, conversations, worlds, worldEntities, worldEvents, worldPatches, groupConversationAgents, agents as agentsTable } from '../db/index.js'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { NEUTRAL_AGENT_ID } from '@momoi/shared/constants'
import type {
  WorldActorKind, WorldEntity, WorldEntityStatus, WorldEvent, WorldEventKind, WorldState, WorldStatus,
} from '@momoi/shared/types'
import type { TerrainPatch, TerrainSpec } from '@momoi/shared/world'
import { WORLD_LIMITS, spawnPoints, terrainSummary } from '@momoi/shared/world'
import { getConfig, listAgents } from './config.js'
import { broadcastWorldStatus } from './realtime.js'
import { generateWorldTerrain } from '../ai/world-generator.js'

const now = () => Math.floor(Date.now() / 1000)

/**
 * 进程内「正在生成」集合。它同时承担两件事：
 *  1) **并发守卫** —— 同一世界不会跑起两个生成任务；
 *  2) **「这次生成还活着吗」的权威判据** —— 不在集合里却仍是 `generating` 的行，
 *     一定是被进程重启打断的（sql.js 每 30s 持久化一次，SIGTERM 会把 generating
 *     行留在磁盘上），可以安全重跑：生成是**幂等**的，只写 spec + ready。
 *
 * 于是世界会自愈，不需要一个「失败」状态再让用户手动点重试。
 * 仅单实例有效 —— 与 realtime 总线、infiniteState 同一既有限制。
 */
const generatingWorlds = new Set<string>()

export function isWorldGenerating(conversationId: string): boolean {
  return generatingWorlds.has(conversationId)
}

/**
 * 启动（或恢复）一个世界的生成任务。**同步守卫**：先同步占位再异步干活，
 * 故连续两次调用不会都通过检查（异步的 has 检查会有竞态窗口）。
 */
export function resumeWorldGeneration(conversationId: string, userId: string): void {
  if (generatingWorlds.has(conversationId)) return
  generatingWorlds.add(conversationId)
  void runGeneration(conversationId, userId)
}

async function runGeneration(conversationId: string, userId: string): Promise<void> {
  let status: WorldStatus = 'ready'
  try {
    const row = await db.select().from(worlds).where(eq(worlds.conversation_id, conversationId)).get()
    if (!row) return // 世界行已被删除（会话软删不会删行，故这是极罕见的真删除）

    const [config, agents] = await Promise.all([getConfig(), listAgents()])
    const neutral = agents.find((a) => a.id === NEUTRAL_AGENT_ID)
    const model = neutral?.model || agents[0]?.model || 'gpt-4o'

    const { spec, laws } = await generateWorldTerrain({
      config,
      model,
      terrainPrompt: row.terrain_prompt,
    })

    // 给用户留出的窗口：生成期间用户可能已经改过法则，那就别覆盖他的
    const nextLaws = row.laws.trim() ? row.laws : laws

    await db.update(worlds)
      .set({
        terrain_spec: JSON.stringify(spec),
        laws: nextLaws,
        status: 'ready',
        status_error: '',
        updated_at: now(),
      })
      .where(eq(worlds.conversation_id, conversationId))
      .run()

    // 地形就绪即可播种实体（幂等）—— 让 Agent 一进来就站在世界上，
    // 而不是要等第一次回合才出现
    await ensureWorldEntities(conversationId, spec)
  } catch (err) {
    // generateWorldTerrain 本身永不抛异常，故能走到这里只剩灾难情形（DB 写失败等）
    status = 'failed'
    const message = (err as Error).message
    console.error(`[world] 生成失败 ${conversationId}:`, message)
    try {
      await db.update(worlds)
        .set({ status: 'failed', status_error: message, updated_at: now() })
        .where(eq(worlds.conversation_id, conversationId))
        .run()
    } catch (writeErr) {
      console.error('[world] 连失败状态都写不进去:', (writeErr as Error).message)
    }
  } finally {
    generatingWorlds.delete(conversationId)
    broadcastWorldStatus(userId, conversationId, status)
  }
}

/**
 * 启动清扫：把被进程重启打断、仍然停在 `generating` 的世界重新生成。
 * GET 路由里的惰性检查是正确性兜底，这一步只是让它更早可见。
 */
export async function sweepInterruptedWorlds(): Promise<void> {
  try {
    // db 在 sql.js 适配层经 `as any` 导出，故此处显式标注返回形状
    const rows: Array<{ id: string }> = await db
      .select({ id: worlds.conversation_id })
      .from(worlds)
      .where(eq(worlds.status, 'generating'))
      .all()
    const orphans = rows.filter((r) => !generatingWorlds.has(r.id))
    if (orphans.length === 0) return

    for (const orphan of orphans) {
      const conv = await db
        .select({ user_id: conversations.user_id })
        .from(conversations)
        .where(and(eq(conversations.id, orphan.id), isNull(conversations.deleted_at)))
        .get()
      if (!conv) continue
      console.log(`[world] 启动清扫：重新生成被打断的世界 ${orphan.id}`)
      resumeWorldGeneration(orphan.id, conv.user_id)
    }
  } catch (err) {
    console.error('[world] 清扫失败:', (err as Error).message)
  }
}

/**
 * 读取世界状态。归属与存在性一并校验：会话不存在 / 不属于该用户 / 已软删 /
 * 类型不是 world，一律返回 null（调用方转 404，不区分原因以防探测）。
 */
export async function getWorldState(conversationId: string, userId: string): Promise<WorldState | null> {
  const conv = await db
    .select({ type: conversations.type })
    .from(conversations)
    .where(and(
      eq(conversations.id, conversationId),
      eq(conversations.user_id, userId),
      isNull(conversations.deleted_at),
    ))
    .get()
  if (!conv || conv.type !== 'world') return null

  const row = await db.select().from(worlds).where(eq(worlds.conversation_id, conversationId)).get()
  if (!row) return null

  return toWorldState(row)
}

/** 更新世界法则（世界唯一可变项）。terrain_prompt 的不可变性由路由层拒绝。 */
export async function updateWorldLaws(
  conversationId: string,
  userId: string,
  laws: string,
): Promise<WorldState | null> {
  const current = await getWorldState(conversationId, userId)
  if (!current) return null
  await db.update(worlds)
    .set({ laws: laws.slice(0, WORLD_LIMITS.maxLawsLength), updated_at: now() })
    .where(eq(worlds.conversation_id, conversationId))
    .run()
  // 法则变了 → 丢弃系统提示词的缓存，否则最多 10s 内 Agent 仍按旧法则行动，
  // 而用户正在试新法则时会觉得莫名其妙
  invalidateWorldContext(conversationId)
  return getWorldState(conversationId, userId)
}

// ---------------------------------------------------------------
// 实体（世界中的存在）
// ---------------------------------------------------------------

/**
 * 播种世界实体 —— **幂等**：已有实体则不动作。
 *
 * 落点用 Phase 1 的 `spawnPoints`（同一 (spec, agentId) 永远得到同一坐标），
 * 故 Phase 1 的纯函数落点在 Phase 2 升级为持久化实体时语义连续：用户看到的名牌
 * 位置不会因为「实体表建立」而跳动。
 */
export async function ensureWorldEntities(conversationId: string, spec: TerrainSpec): Promise<WorldEntity[]> {
  const existing = await listWorldEntities(conversationId)
  if (existing.length > 0) return existing

  const members = await db
    .select({ agent_id: groupConversationAgents.agent_id, name: agentsTable.name })
    .from(groupConversationAgents)
    .innerJoin(agentsTable, eq(groupConversationAgents.agent_id, agentsTable.id))
    .where(eq(groupConversationAgents.conversation_id, conversationId))
    .orderBy(groupConversationAgents.sort_order)
    .all()
  if (members.length === 0) return []

  const points = spawnPoints(spec, members.map((m: { agent_id: string }) => m.agent_id))
  const at = now()
  const rows = members.map((m: { agent_id: string; name: string }) => {
    const p = points.find((x) => x.id === m.agent_id) ?? { x: 0, z: 0 }
    return {
      id: randomUUID(),
      conversation_id: conversationId,
      kind: 'agent',
      agent_id: m.agent_id,
      name: m.name,
      x: p.x,
      z: p.z,
      status: 'alive',
      created_at: at,
      updated_at: at,
    }
  })
  await db.insert(worldEntities).values(rows).run()
  return listWorldEntities(conversationId)
}

export async function listWorldEntities(conversationId: string): Promise<WorldEntity[]> {
  const rows: WorldEntity[] = await db
    .select()
    .from(worldEntities)
    .where(eq(worldEntities.conversation_id, conversationId))
    .orderBy(asc(worldEntities.created_at), asc(worldEntities.id))
    .all()
  return rows
}

/** 持久化实体位置与状态（编排器在一回合结束时调用一次，N 很小） */
export async function saveWorldEntities(entities: WorldEntity[]): Promise<void> {
  const at = now()
  for (const e of entities) {
    await db.update(worldEntities)
      .set({ x: e.x, z: e.z, status: e.status, updated_at: at })
      .where(eq(worldEntities.id, e.id))
      .run()
  }
}

// ---------------------------------------------------------------
// 改造补丁（叠加层，永不写回 terrain_spec）
// ---------------------------------------------------------------

/** 按 seq 升序读取世界的改造补丁 —— 顺序即折叠顺序，不可打乱 */
export async function listWorldPatches(conversationId: string): Promise<TerrainPatch[]> {
  const rows: Array<{ patch: string }> = await db
    .select({ patch: worldPatches.patch })
    .from(worldPatches)
    .where(eq(worldPatches.conversation_id, conversationId))
    .orderBy(asc(worldPatches.seq))
    .all()
  const out: TerrainPatch[] = []
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.patch) as TerrainPatch
      // 逐条校验，坏行不污染整份补丁链
      if (parsed && Array.isArray(parsed.center) && parsed.center.length === 2) out.push(parsed)
    } catch {
      console.warn('[world] 跳过无法解析的补丁行')
    }
  }
  return out
}

/** 追加一批改造补丁（编排器是唯一调用方）。seq 全局单调递增。 */
export async function appendWorldPatches(
  conversationId: string,
  turn: number,
  patches: TerrainPatch[],
  actor: { source: 'agent' | 'god'; agentId: string | null; name: string },
): Promise<void> {
  if (patches.length === 0) return
  const maxRow = await db
    .select({ maxSeq: sql<number>`COALESCE(MAX(world_patches.seq), 0)` })
    .from(worldPatches)
    .where(eq(worldPatches.conversation_id, conversationId))
    .get()
  let seq = Number(maxRow?.maxSeq ?? 0)
  const at = now()
  for (const patch of patches) {
    seq += 1
    await db.insert(worldPatches).values({
      conversation_id: conversationId,
      seq,
      patch: JSON.stringify(patch),
      source: actor.source,
      agent_id: actor.agentId,
      actor_name: actor.name,
      turn,
      created_at: at,
    }).run()
  }
}

// ---------------------------------------------------------------
// 上帝的化身
// ---------------------------------------------------------------

/** 上帝在事件日志与沙盘上的显示名 */
export const GOD_ENTITY_NAME = '上帝'

/**
 * 取（或创建）本世界的上帝化身。**按 kind 唯一** —— 一个世界只有一个上帝。
 * 用户第一次放置化身时创建；此后移动只改坐标。
 */
export async function placeGodEntity(
  conversationId: string,
  x: number,
  z: number,
): Promise<WorldEntity> {
  const existing = (await listWorldEntities(conversationId)).find((e) => e.kind === 'god')
  const at = now()
  if (existing) {
    await db.update(worldEntities)
      .set({ x, z, updated_at: at })
      .where(eq(worldEntities.id, existing.id))
      .run()
    return { ...existing, x, z, updated_at: at }
  }
  const entity: WorldEntity = {
    id: randomUUID(),
    conversation_id: conversationId,
    kind: 'god',
    agent_id: null,
    name: GOD_ENTITY_NAME,
    x,
    z,
    status: 'alive',
    created_at: at,
    updated_at: at,
  }
  await db.insert(worldEntities).values(entity).run()
  return entity
}

// ---------------------------------------------------------------
// 事件（世界的「消息」）
// ---------------------------------------------------------------

export interface WorldEventInput {
  actorKind: WorldActorKind
  actorId: string | null
  actorName: string
  kind: WorldEventKind
  content: string
  payload?: Record<string, unknown> | null
}

/** 追加一批事件 —— **编排器是唯一调用方**。seq 在 turn 内单调递增。 */
export async function appendWorldEvents(
  conversationId: string,
  turn: number,
  inputs: WorldEventInput[],
): Promise<WorldEvent[]> {
  if (inputs.length === 0) return []
  const maxRow = await db
    .select({ maxSeq: sql<number>`COALESCE(MAX(world_events.seq), 0)` })
    .from(worldEvents)
    .where(and(eq(worldEvents.conversation_id, conversationId), eq(worldEvents.turn, turn)))
    .get()
  // 本批之前的最大 seq 即本批的起始下标（seq 是 1 起的稠密编号），
  // 回读后据此切出**新增**的那几条 —— 否则调用方会把整回合的历史重复下发一遍。
  const before = Number(maxRow?.maxSeq ?? 0)
  let seq = before
  const at = now()

  for (const input of inputs) {
    seq += 1
    await db.insert(worldEvents).values({
      conversation_id: conversationId,
      turn,
      seq,
      actor_kind: input.actorKind,
      actor_id: input.actorId,
      actor_name: input.actorName,
      kind: input.kind,
      content: input.content,
      payload: input.payload ? JSON.stringify(input.payload) : null,
      created_at: at,
    }).run()
  }
  // 回读以获得自增 id 与实际 seq（sql.js 适配层不返回插入结果）
  const rows = await db.select().from(worldEvents)
    .where(and(eq(worldEvents.conversation_id, conversationId), eq(worldEvents.turn, turn)))
    .orderBy(asc(worldEvents.seq))
    .all()
  return rows.slice(before).map(toWorldEvent)
}

export async function listWorldEvents(conversationId: string, limit = 200): Promise<WorldEvent[]> {
  const rows = await db.select().from(worldEvents)
    .where(eq(worldEvents.conversation_id, conversationId))
    .orderBy(desc(worldEvents.id))
    .limit(limit)
    .all()
  rows.reverse()
  return rows.map(toWorldEvent)
}

function toWorldEvent(row: typeof worldEvents.$inferSelect): WorldEvent {
  let payload: Record<string, unknown> | null = null
  if (row.payload) {
    try { payload = JSON.parse(row.payload) as Record<string, unknown> } catch { payload = null }
  }
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    turn: row.turn,
    seq: row.seq,
    actor_kind: row.actor_kind as WorldActorKind,
    actor_id: row.actor_id,
    actor_name: row.actor_name,
    kind: row.kind as WorldEventKind,
    content: row.content,
    payload,
    created_at: row.created_at,
  }
}

// ---------------------------------------------------------------
// 系统提示词的世界上下文（带 TTL 缓存）
// ---------------------------------------------------------------

interface WorldContextEntry {
  at: number
  ctx: { laws: string; terrainSummary: string } | null
}

/**
 * 一个世界回合会对每个参与 Agent 各调一次 runPiAgentLoop，故这里必须缓存 ——
 * 否则同一份 spec 会在几十毫秒内被反复解析。
 * TTL 10 秒（与群聊缺席记忆同款惯例）；法则变更会显式失效，故用户不必等 TTL。
 */
const worldContextCache = new Map<string, WorldContextEntry>()
const WORLD_CONTEXT_TTL_MS = 10_000

export async function loadWorldContext(
  conversationId: string,
): Promise<{ laws: string; terrainSummary: string } | null> {
  const hit = worldContextCache.get(conversationId)
  if (hit && Date.now() - hit.at < WORLD_CONTEXT_TTL_MS) return hit.ctx

  const row = await db
    .select({ laws: worlds.laws, terrain_spec: worlds.terrain_spec, status: worlds.status })
    .from(worlds)
    .where(eq(worlds.conversation_id, conversationId))
    .get()

  let ctx: { laws: string; terrainSummary: string } | null = null
  if (row && row.status === 'ready' && row.terrain_spec) {
    try {
      ctx = { laws: row.laws, terrainSummary: terrainSummary(JSON.parse(row.terrain_spec) as TerrainSpec) }
    } catch {
      ctx = null
    }
  }
  worldContextCache.set(conversationId, { at: Date.now(), ctx })
  return ctx
}

export function invalidateWorldContext(conversationId: string): void {
  worldContextCache.delete(conversationId)
}

// ---------------------------------------------------------------
// 回合并发守卫
// ---------------------------------------------------------------

/**
 * 正在跑回合的世界。与 generatingWorlds 同款：同步占位，无竞态。
 * 一个世界同时只允许一个回合 —— 否则两个回合会交错写 turn 与实体位置。
 */
const runningTurns = new Set<string>()

export function isWorldTurnRunning(conversationId: string): boolean {
  return runningTurns.has(conversationId)
}

/** 同步占位；返回 false 表示已有回合在跑 */
export function claimWorldTurn(conversationId: string): boolean {
  if (runningTurns.has(conversationId)) return false
  runningTurns.add(conversationId)
  return true
}

export function releaseWorldTurn(conversationId: string): void {
  runningTurns.delete(conversationId)
}

function toWorldState(row: typeof worlds.$inferSelect): WorldState {
  let spec: TerrainSpec | null = null
  if (row.terrain_spec) {
    try {
      spec = JSON.parse(row.terrain_spec) as TerrainSpec
    } catch {
      spec = null
    }
  }

  let status = row.status as WorldStatus
  let status_error = row.status_error
  // 声称已就绪却解析不出地形 —— 那是坏数据，不是「还在生成中」。
  // 若不修正，前端会永远停在生成态转圈。
  if (status === 'ready' && !spec) {
    status = 'failed'
    status_error = status_error || '地形数据损坏'
  }

  return {
    conversation_id: row.conversation_id,
    status,
    status_error,
    terrain_prompt: row.terrain_prompt,
    terrain_spec: spec,
    laws: row.laws,
    turn: row.turn,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}
