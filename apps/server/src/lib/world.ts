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

import { db, conversations, worlds } from '../db/index.js'
import { and, eq, isNull } from 'drizzle-orm'
import { NEUTRAL_AGENT_ID } from '@momoi/shared/constants'
import type { WorldState, WorldStatus } from '@momoi/shared/types'
import type { TerrainSpec } from '@momoi/shared/world'
import { WORLD_LIMITS } from '@momoi/shared/world'
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
  return getWorldState(conversationId, userId)
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
