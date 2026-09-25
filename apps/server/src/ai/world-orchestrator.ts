// ============================================================
// World Orchestrator — 一个回合：上帝行动 → Agent 依次行动一拍
// ============================================================
// 结构对标 group-orchestrator：串行、逐个体、每个失败不回滚整轮。
//
// 与群聊的关键差别：世界的「历史」是 **world_events**（持久化的事件日志），
// 不是聊天消息。故每个 Agent 的简报直接由事件日志构成，不传递聊天历史 ——
// 事件日志就是历史，这也让世界不依赖 messages 表的任何机制（落库、建议、语音…）。

import type { ServerMessage, WorldActorKind, WorldEntity, WorldEvent } from '@momoi/shared/types'
import type { TerrainSpec } from '@momoi/shared/world'
import { runPiAgentLoop } from './pi-adapter.js'
import { describeLocation, describeSurroundings } from '../tools/world-tools.js'
import type { WorldEventDraft, WorldSignal, WorldView } from '../tools/world-tools.js'
import { appendWorldEvents, saveWorldEntities } from '../lib/world.js'
import type { WorldEventInput } from '../lib/world.js'

/** 事件日志里出现的历史条数上限（简报里给 Agent 看多少过去） */
const BRIEFING_HISTORY = 20
/** 上帝在事件日志里的显示名 */
const GOD_NAME = '上帝'

export interface WorldTurnOptions {
  conversationId: string
  userId: string
  /** 本回合序号（调用方已写库） */
  turn: number
  spec: TerrainSpec
  laws: string
  /** 上帝这一步做了什么 */
  godAction: string
  /** 当前全部实体（含死亡者）—— **就地修改**，由编排器统一持久化 */
  entities: WorldEntity[]
  /** 最近的事件（升序）—— 会被就地追加，供后续 Agent 看到本回合前面发生的事 */
  recentEvents: WorldEvent[]
  /** 下发本回合的 SSE 事件 */
  send: (msg: ServerMessage) => void
  signal?: AbortSignal
  language?: string
}

/**
 * 跑一个回合。**不抛异常**：单个 Agent 失败只记一条事件，其余照常行动
 * （与群聊编排的容错一致 —— 一个 Agent 崩了不该让整轮消失）。
 */
export async function runWorldTurn(opts: WorldTurnOptions): Promise<void> {
  const { conversationId, userId, turn, spec, laws, godAction, entities, recentEvents, send, signal, language } = opts
  const view: WorldView = { conversationId, spec, laws, turn, entities, recentEvents }

  /** 落库一批事件并逐条下发（编排器是唯一写入方） */
  const commit = async (
    drafts: WorldEventDraft[],
    actor: { kind: WorldActorKind; id: string | null; name: string },
  ): Promise<void> => {
    if (drafts.length === 0) return
    const inputs: WorldEventInput[] = drafts.map((d) => ({
      actorKind: actor.kind,
      actorId: actor.id,
      actorName: actor.name,
      kind: d.kind,
      content: d.content,
      payload: d.payload ?? null,
    }))
    const saved = await appendWorldEvents(conversationId, turn, inputs)
    for (const e of saved) {
      recentEvents.push(e)
      send({ type: 'world_event', event: e })
    }
  }

  // ---- 1) 上帝的行动先入史，让所有 Agent 都能看到 ----
  await commit([{ kind: 'act', content: godAction }], { kind: 'god', id: null, name: GOD_NAME })

  send({ type: 'world_turn_start', turn, entities: entities.map((e) => ({ ...e })) })

  // ---- 2) 逐个存活个体行动一拍 ----
  const actors = entities.filter((e) => e.kind === 'agent' && e.status === 'alive')
  for (const actor of actors) {
    if (signal?.aborted) break
    send({ type: 'world_agent_start', entity_id: actor.id, name: actor.name })

    const box: WorldSignal = { view, actorId: actor.id, pending: [] }
    try {
      const res = await runPiAgentLoop({
        userMessage: buildBriefing(view, actor, godAction),
        // 世界不传递聊天历史 —— 事件日志已经是历史
        history: [],
        // 世界回合不流式下发 token / 思考 / 工具轨迹：客户端渲染的是事件日志，
        // 不是消息气泡。契约因此保持纯净（只有 world_* 事件）。
        send: () => {},
        // 思考**开启**：关掉它会让「我先看看四周」这类计划句无处可去，直接漏进
        // 叙述正文（实测出现过英文计划句 + 中文叙述拼接的割裂）。开启后推理走
        // reasoning_content 通道，由上面那个空 send 丢弃，正文只剩叙述本身。
        thinkingMode: true,
        conversationId,
        userId,
        agentId: actor.agent_id ?? undefined,
        language,
        worldSignal: box,
      })
      if (res.reply.trim()) {
        box.pending.push({ kind: 'narration', content: res.reply.trim() })
      }
    } catch (err) {
      // 单个 Agent 失败不中断整轮 —— 记一条事件即可
      console.error(`[world] Agent ${actor.name} 行动失败:`, (err as Error).message)
      box.pending.push({
        kind: 'narration',
        content: `（${actor.name} 这一拍没能行动：${(err as Error).message}）`,
      })
    }

    await commit(box.pending, { kind: 'agent', id: actor.id, name: actor.name })
    // 每拍都持久化实体 —— 中途崩溃不至于丢掉前面几拍的移动与死亡
    await saveWorldEntities(entities)
    send({ type: 'world_agent_done', entity_id: actor.id, name: actor.name })
  }

  await saveWorldEntities(entities)
  send({ type: 'world_turn_end', turn })
}

/**
 * 构造某个 Agent 的世界简报。
 *
 * 这是它在世界里的「眼睛与耳朵」：确切的自身坐标、附近有什么（含对方所处地形）、
 * 最近发生了什么、以及上帝这一步做了什么。坐标系在这里再讲一遍 ——
 * Agent 最容易犯的错就是把归一化坐标当成世界单位。
 */
function buildBriefing(view: WorldView, actor: WorldEntity, godAction: string): string {
  const history = view.recentEvents
    .filter((e) => e.kind !== 'move') // 移动事件噪音大、信息量低，不值得占简报篇幅
    .slice(-BRIEFING_HISTORY)

  const lines = [
    '【世界状态】',
    `回合：${view.turn}`,
    `你的位置：(${actor.x.toFixed(2)}, ${actor.z.toFixed(2)}) —— ${describeLocation(view.spec, actor.x, actor.z)}`,
    '你附近：',
    describeSurroundings(view, actor.id),
    '',
    '最近发生：',
    history.length > 0
      ? history.map((e) => `  · [回合${e.turn}] ${e.actor_name}：${e.content}`).join('\n')
      : '  （还没有）',
    '',
    '【上帝的行动】',
    godAction,
    '',
    '轮到你了。请用工具表达你的行动（world_move / world_speak / world_observe / world_act），',
    '并在回复文本里叙述你做了什么 —— 两者必须一致。',
    // 语言锚定：简报与提示词都是中文，但模型（尤其小参数模型）容易顺着英文系统段
    // 滑向英文输出。实测出现过上帝用中文行动、Agent 用英文叙述的割裂。
    '用与【上帝的行动】相同的语言叙述。',
    '直接输出你的叙述本身 —— 不要输出思考过程、计划或「我准备先……」之类的说明。',
  ]
  return lines.join('\n')
}
