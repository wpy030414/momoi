// ============================================================
// World Ticker — 自动演算
// ============================================================
// 「回合制为默认，附自动演算开关」（用户拍板的产品决策）。
//
// 开关状态**存在内存**里，与无限演算模式的 infiniteState 同一惯例：它是「用户
// 希望这个世界自己往前走」的会话级意图，重启后回到关闭是合理且安全的默认 ——
// 而给它加一个 worlds 列要付的代价是：PG 那条 ALTER 通道在本仓库里**并不存在**
// （见 module-database.md 的「新增一张表的四个落点」），为一次性的开关加列不划算。
//
// 采用**自重新调度的 setTimeout**（而非 setInterval）：一个回合可能跑十几秒，
// 固定间隔会让两个回合重叠 —— 而 turn 与实体位置都不允许交错写。
// 与本仓库的 push-scheduler / 微信轮询器同一范式。

import type { ServerMessage } from '@momoi/shared/types'
import type { TerrainSpec } from '@momoi/shared/world'
import { db, conversations, worlds } from '../db/index.js'
import { eq } from 'drizzle-orm'
import { runWorldTurn } from '../ai/world-orchestrator.js'
import { broadcastWorldEvent, broadcastWorldTurn } from './realtime.js'
import {
  claimWorldTurn,
  listWorldEntities,
  listWorldEvents,
  listWorldPatches,
  releaseWorldTurn,
} from './world.js'

/** 两拍之间的间隔。留足时间让用户读完上一拍发生了什么。 */
const TICK_INTERVAL_MS = 15_000
/** 回合开始时喂给编排器的事件条数（与手动回合一致） */
const TURN_CONTEXT_EVENTS = 60

const timers = new Map<string, ReturnType<typeof setTimeout>>()

export function isWorldAutoTicking(conversationId: string): boolean {
  return timers.has(conversationId)
}

/** 停掉某个世界的自动演算。幂等。 */
export function stopWorldAutoTick(conversationId: string): void {
  const timer = timers.get(conversationId)
  if (timer) clearTimeout(timer)
  timers.delete(conversationId)
}

/** 开启自动演算。已开启则什么都不做（幂等）。 */
export function startWorldAutoTick(conversationId: string, userId: string): void {
  if (timers.has(conversationId)) return
  // 先占位再调度：同步写入 Map，故连续两次调用不会都通过检查
  timers.set(conversationId, setTimeout(() => void tick(conversationId, userId), TICK_INTERVAL_MS))
  console.log(`[world] 自动演算开启：${conversationId}`)
}

function schedule(conversationId: string, userId: string): void {
  if (!timers.has(conversationId)) return // 期间被关掉了
  timers.set(conversationId, setTimeout(() => void tick(conversationId, userId), TICK_INTERVAL_MS))
}

async function tick(conversationId: string, userId: string): Promise<void> {
  // 每一拍都重新读世界状态：期间它可能被删、被软删、或还没生成完
  try {
    const conv = await db
      .select({ deleted_at: conversations.deleted_at })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()
    if (!conv || conv.deleted_at) {
      stopWorldAutoTick(conversationId)
      console.log(`[world] 自动演算停止（会话已删除）：${conversationId}`)
      return
    }

    const row = await db.select().from(worlds).where(eq(worlds.conversation_id, conversationId)).get()
    if (!row || row.status !== 'ready' || !row.terrain_spec) {
      schedule(conversationId, userId) // 还没就绪 / 暂时失败 —— 下一拍再看
      return
    }

    const entities = await listWorldEntities(conversationId)
    const alive = entities.filter((e) => e.kind === 'agent' && e.status === 'alive')
    if (alive.length === 0) {
      // 所有存在都已死去或消失 —— 世界不再自行运转（否则只会不停地记空回合）
      stopWorldAutoTick(conversationId)
      console.log(`[world] 自动演算停止（没有存活的存在）：${conversationId}`)
      return
    }

    // 手动回合正在跑 → 让路，下一拍再来（不抢，也不打断）
    if (!claimWorldTurn(conversationId)) {
      schedule(conversationId, userId)
      return
    }

    const turn = row.turn + 1
    await db.update(worlds)
      .set({ turn, updated_at: Math.floor(Date.now() / 1000) })
      .where(eq(worlds.conversation_id, conversationId))
      .run()

    // 自动演算没有上帝行动 —— 编排器会因此不记上帝事件（godAction 为空）
    const send = (msg: ServerMessage): void => {
      if (msg.type === 'world_event') broadcastWorldEvent(userId, conversationId, msg.event)
      else if (msg.type === 'world_turn_start') broadcastWorldTurn(userId, conversationId, msg.turn, true, true)
      else if (msg.type === 'world_turn_end') broadcastWorldTurn(userId, conversationId, msg.turn, false, true)
    }

    try {
      await runWorldTurn({
        conversationId,
        userId,
        turn,
        spec: JSON.parse(row.terrain_spec) as TerrainSpec,
        laws: row.laws,
        godAction: '',
        entities,
        recentEvents: await listWorldEvents(conversationId, TURN_CONTEXT_EVENTS),
        patches: await listWorldPatches(conversationId),
        godEntity: entities.find((e) => e.kind === 'god') ?? null,
        send,
      })
    } finally {
      releaseWorldTurn(conversationId)
    }
    schedule(conversationId, userId)
  } catch (err) {
    // 单拍失败不停整个自动演算：世界继续运转，错误留在日志里
    console.error(`[world] 自动演算某一拍失败 ${conversationId}:`, (err as Error).message)
    schedule(conversationId, userId)
  }
}

/** 进程退出 / 测试收尾用：停掉全部计时器 */
export function stopAllWorldAutoTicks(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
}
