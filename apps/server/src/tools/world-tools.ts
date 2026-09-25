// ============================================================
// World Tools — Agent 在世界中的行动手段
// ============================================================
// 旁路范式：工具不直接写库，而是把一个可变对象 `WorldSignal` 经 ToolContext 传进来，
// 由它回传「本回合产生了哪些事件」与「实体状态改成了什么」。编排器是**唯一写入方**，
// 统一负责落库与下发 —— 与群聊的 MentionSignal（tools/group-mention-tool.ts +
// group-orchestrator.ts）完全同构。
//
// ⚠️ 世界回合**只开放这些工具**（+ load_skill）。住在沙盘里的生灵不该能读写文件、
// 执行 Shell 或发 HTTP 请求 —— 见 pi-adapter 的 allowedTools 白名单。

import type { ToolDefinition } from '@momoi/shared/types'
import type { WorldEntity, WorldEntityStatus, WorldEvent, WorldEventKind } from '@momoi/shared/types'
import { biomeName, isWater, sampleBiome, sampleHeight } from '@momoi/shared/world'
import type { TerrainSpec } from '@momoi/shared/world'
import type { ToolContext, ToolModule, ToolResult } from './types.js'

/** 编排器交给工具的世界当前状态。工具**就地**修改 entities，事件追加进 pending。 */
export interface WorldView {
  conversationId: string
  spec: TerrainSpec
  laws: string
  turn: number
  /** 当前所有存在（含死亡者 —— 历史里出现过，但不会再行动） */
  entities: WorldEntity[]
  /** 最近的事件，供观察与简报 */
  recentEvents: WorldEvent[]
}

/** 工具产生的、尚待落库的事件草稿 */
export interface WorldEventDraft {
  kind: WorldEventKind
  content: string
  payload?: Record<string, unknown> | null
}

export interface WorldSignal {
  view: WorldView
  /** 本回合的当前行动者（编排器逐个体设置） */
  actorId: string
  /** 本回合已产生的事件草稿 —— 编排器统一落库与下发 */
  pending: WorldEventDraft[]
}

// ---------------------------------------------------------------
// 共享助手
// ---------------------------------------------------------------

/** 把归一化坐标描述成人能读懂的地点（Agent 用它判断「我在哪」） */
export function describeLocation(spec: TerrainSpec, x: number, z: number): string {
  if (isWater(spec, x, z)) {
    const kind = spec.terrain.water === 'toxic' ? '有毒的水域' : '水域'
    return kind
  }
  const biome = sampleBiome(spec, x, z)
  const h = sampleHeight(spec, x, z)
  const relief = h > 0.25 ? '高耸' : h > 0.05 ? '略高' : h > -0.1 ? '平坦' : '低洼'
  return `${biomeName(biome.id)}（${relief}）`
}

/** 解析实体：先按 id，再按名字（大小写不敏感的精确匹配） */
export function resolveEntity(entities: WorldEntity[], ref: string): WorldEntity | undefined {
  const key = ref.trim()
  if (!key) return undefined
  return (
    entities.find((e) => e.id === key) ??
    entities.find((e) => e.name === key) ??
    entities.find((e) => e.name.toLowerCase() === key.toLowerCase())
  )
}

function actorOf(ctx: ToolContext): { signal: WorldSignal; actor: WorldEntity } | ToolResult {
  const signal = ctx.worldSignal
  if (!signal) return { summary: 'Error: this tool is only available inside a world turn', error: true }
  const actor = signal.view.entities.find((e) => e.id === signal.actorId)
  if (!actor) return { summary: 'Error: acting entity not found in this world', error: true }
  return { signal, actor }
}

function isResult(v: ReturnType<typeof actorOf>): v is ToolResult {
  return (v as ToolResult).summary !== undefined
}

function clampCoord(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(1, Math.max(-1, n))
}

function distance(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/** 观察返回的「附近有什么」—— 也用于简报，故导出 */
export function describeSurroundings(view: WorldView, actorId: string, radius = 0.5): string {
  const others = view.entities
    .filter((e) => e.id !== actorId && e.status !== 'gone')
    .map((e) => ({ e, d: distance(e, view.entities.find((x) => x.id === actorId) ?? { x: 0, z: 0 }) }))
    .filter(({ d }) => d <= radius)
    .sort((a, b) => a.d - b.d)
  if (others.length === 0) return '附近没有别的存在。'
  return others
    .map(({ e, d }) => {
      const status = e.status === 'dead' ? '（已死）' : ''
      return `${e.name}${status} 在 (${e.x.toFixed(2)}, ${e.z.toFixed(2)})，相距 ${d.toFixed(2)} —— 那里是${describeLocation(view.spec, e.x, e.z)}`
    })
    .join('\n')
}

// ---------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------

const worldMove: ToolModule = {
  definition: {
    name: 'world_move',
    description:
      '在世界中移动到指定位置。坐标是**归一化**的：世界是边长 2 的正方形沙盘，中心为 (0,0)，' +
      'x 向东为正，z 向南为正，边界为 ±1。移动会受地形影响（可以涉水，但深水与高山更艰难）。',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: '目标位置的 x 坐标，−1 到 1' },
        z: { type: 'number', description: '目标位置的 z 坐标，−1 到 1' },
      },
      required: ['x', 'z'],
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const got = actorOf(ctx)
    if (isResult(got)) return got
    const { signal, actor } = got

    const x = clampCoord(input.x)
    const z = clampCoord(input.z)
    if (x === null || z === null) {
      return { summary: 'Error: x 与 z 必须是 −1 到 1 之间的数值', error: true }
    }

    const from = { x: actor.x, z: actor.z }
    if (from.x === x && from.z === z) {
      return { summary: `你已经在 (${x}, ${z}) —— ${describeLocation(signal.view.spec, x, z)}` }
    }

    actor.x = x
    actor.z = z
    signal.pending.push({
      kind: 'move',
      content: `从 (${from.x.toFixed(2)}, ${from.z.toFixed(2)}) 移动到 (${x.toFixed(2)}, ${z.toFixed(2)})`,
      payload: { from: [from.x, from.z], to: [x, z] },
    })

    return {
      summary: `你移动到 (${x.toFixed(2)}, ${z.toFixed(2)})。此处是${describeLocation(signal.view.spec, x, z)}。`,
    }
  },
}

const worldSpeak: ToolModule = {
  definition: {
    name: 'world_speak',
    description: '在世界中开口说话。附近的存在会听到（可选指定对谁说）。',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '你要说出口的话' },
        to: { type: 'string', description: '可选：听话者的名字或 id；不填则是对四周开口' },
      },
      required: ['content'],
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const got = actorOf(ctx)
    if (isResult(got)) return got
    const { signal, actor } = got

    const content = String(input.content ?? '').trim()
    if (!content) return { summary: 'Error: content 不能为空', error: true }

    const toRaw = String(input.to ?? '').trim()
    let targetName = ''
    if (toRaw) {
      const target = resolveEntity(signal.view.entities, toRaw)
      if (!target) {
        return { summary: `Error: 世界里没有叫「${toRaw}」的存在`, error: true }
      }
      if (target.id === actor.id) {
        return { summary: 'Error: 你不能对自己说话', error: true }
      }
      targetName = target.name
    }

    signal.pending.push({
      kind: 'speak',
      content: targetName ? `对 ${targetName} 说：「${content}」` : `说：「${content}」`,
      payload: targetName ? { to: targetName } : null,
    })
    return { summary: targetName ? `你对 ${targetName} 说了这句话。` : '你说出了这句话，四周回荡着。' }
  },
}

const worldObserve: ToolModule = {
  definition: {
    name: 'world_observe',
    description:
      '观察四周或某个目标。会返回你当前所在的地形、附近有哪些存在（及其位置与所处地形），以及近期发生的事。' +
      '这是只读的，不会改变世界。',
    input_schema: {
      type: 'object',
      properties: {
        radius: { type: 'number', description: '观察半径（归一化距离，默认 0.5；整个世界为 ±1）' },
        target: { type: 'string', description: '可选：只看某个存在（名字或 id）' },
      },
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const got = actorOf(ctx)
    if (isResult(got)) return got
    const { signal, actor } = got
    const view = signal.view

    const targetRef = String(input.target ?? '').trim()
    if (targetRef) {
      const target = resolveEntity(view.entities, targetRef)
      if (!target) return { summary: `Error: 世界里没有叫「${targetRef}」的存在`, error: true }
      return {
        summary:
          `${target.name}：${target.status === 'alive' ? '活着' : target.status === 'dead' ? '已死' : '已消失'}，` +
          `位于 (${target.x.toFixed(2)}, ${target.z.toFixed(2)})，那里是${describeLocation(view.spec, target.x, target.z)}。` +
          `与你相距 ${distance(target, actor).toFixed(2)}。`,
      }
    }

    const r = typeof input.radius === 'number' && Number.isFinite(input.radius) ? Math.min(2, Math.max(0.05, input.radius)) : 0.5
    const recent = view.recentEvents.slice(-6)
    return {
      summary:
        `你位于 (${actor.x.toFixed(2)}, ${actor.z.toFixed(2)}) —— ${describeLocation(view.spec, actor.x, actor.z)}。\n` +
        `附近：\n${describeSurroundings(view, actor.id, r)}\n` +
        `最近发生：\n${recent.length ? recent.map((e) => `  ${e.turn}·${e.actor_name}：${e.content}`).join('\n') : '  （还没有）'}`,
    }
  },
}

const worldAct: ToolModule = {
  definition: {
    name: 'world_act',
    description:
      '做出一个行动（攻击、建造、休息、施法……任何事）。世界法则会决定它的后果。' +
      '若依世界法则该行动**致目标死亡或消失**，在 target_status 中声明 —— 服务端会据此更新目标的状态。' +
      '注意：死亡是不可逆的。',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '你做了什么（一句具体的描述）' },
        target: { type: 'string', description: '可选：行动的目标（名字或 id）' },
        target_status: {
          type: 'string',
          description: '可选：若该行动使目标死亡或消失，在此声明。必须是 "dead" 或 "gone"',
          enum: ['dead', 'gone'],
        },
      },
      required: ['action'],
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const got = actorOf(ctx)
    if (isResult(got)) return got
    const { signal, actor } = got

    const action = String(input.action ?? '').trim()
    if (!action) return { summary: 'Error: action 不能为空', error: true }

    const targetRef = String(input.target ?? '').trim()
    // 显式收敛成字面量联合：`String(...)` 是 string，直接赋给 status 会丢掉类型
    const declaredRaw = String(input.target_status ?? '').trim()
    const declared: WorldEntityStatus | '' =
      declaredRaw === 'dead' || declaredRaw === 'gone' ? declaredRaw : ''

    let target: WorldEntity | undefined
    if (targetRef) {
      target = resolveEntity(signal.view.entities, targetRef)
      if (!target) return { summary: `Error: 世界里没有叫「${targetRef}」的存在`, error: true }
      if (target.id === actor.id) return { summary: 'Error: 目标不能是自己', error: true }
      if (target.status !== 'alive') {
        return { summary: `Error: ${target.name} 已经不是活着的状态了`, error: true }
      }
    }

    // target_status 只在确实有目标时才有意义 —— 防止「凭空声明某人死亡」
    if (declared && !target) {
      return { summary: 'Error: 要声明目标的结局，必须同时指定 target', error: true }
    }
    if (declaredRaw && !declared) {
      return { summary: 'Error: target_status 只能是 "dead" 或 "gone"', error: true }
    }

    signal.pending.push({
      kind: 'act',
      content: target ? `对 ${target.name}：${action}` : action,
      payload: target ? { target: target.name, target_status: declared || null } : null,
    })

    if (target && declared) {
      target.status = declared
      signal.pending.push({
        kind: 'die',
        content: `${target.name}${declared === 'dead' ? '死了' : '消失了'} —— ${actor.name}的「${action}」`,
        payload: { target: target.name, status: declared, by: actor.name },
      })
      return {
        summary: `${action} —— ${target.name}${declared === 'dead' ? '就此死去' : '消失了'}。这件事已经无法挽回。`,
      }
    }

    return { summary: `你做了：${action}` }
  },
}

/** 世界回合可用的全部工具（顺序即暴露给 LLM 的顺序） */
export const worldTools: ToolModule[] = [worldObserve, worldMove, worldSpeak, worldAct]

/** 世界回合的工具白名单 —— 见文件头注释 */
export const WORLD_TOOL_NAMES: string[] = [...worldTools.map((t) => t.definition.name), 'load_skill']

export type { ToolDefinition }
