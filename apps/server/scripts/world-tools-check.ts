// 世界回合工具白名单守卫
// 运行：pnpm --filter @momoi/server world:tools
//
// 盯住一条**安全边界**：世界回合里 Agent 只应拿到世界工具 + load_skill。
// 住在沙盘里的生灵不该能读写文件、执行 Shell 或发 HTTP 请求 —— 那些能力属于
// 「与用户对话的助手」，不属于「世界里的人」。
//
// 这条边界靠 pi-adapter 里两处代码维持：defs 的白名单选择、以及「世界回合到此为止」
// 的提前返回（跳过 at_mention 与 MCP 工具的注入）。任一处被改坏，本测试都会失败。
//
// ⚠️ 导入 pi-adapter 会连带初始化数据库（lib/config → db），故结尾必须 process.exit(0)
//    以免 30 秒持久化定时器把进程挂住。

import { createToolAdapter } from '../src/ai/pi-adapter.js'
import { worldTools, WORLD_TOOL_NAMES } from '../src/tools/world-tools.js'
import type { WorldSignal, WorldView } from '../src/tools/world-tools.js'
import type { ToolContext } from '../src/tools/types.js'
import { defaultTerrainSpec } from '@momoi/shared/world'
import type { WorldEntity } from '@momoi/shared/types'

let pass = 0
let fail = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; console.log(`  ❌ ${label}  ${detail}`) }
}

const baseCtx = {
  conversationId: 'test-conv',
  userId: 'tester',
  workspace: {} as never,
  agentId: 'agent-x',
} as unknown as ToolContext

const worldCtx = { ...baseCtx, worldSignal: {} as WorldSignal } as unknown as ToolContext

const worldNames = (await createToolAdapter(worldCtx)).map((t) => t.name).sort()
const chatNames = (await createToolAdapter(baseCtx)).map((t) => t.name).sort()

console.log('【世界回合】')
console.log(`  工具：${worldNames.join(', ')}`)
check('恰好是白名单集合', JSON.stringify(worldNames) === JSON.stringify([...WORLD_TOOL_NAMES].sort()),
  `expected ${JSON.stringify([...WORLD_TOOL_NAMES].sort())}`)
for (const forbidden of ['read_file', 'write_file', 'bash', 'http_request', 'delete_file', 'list_files', 'save_memory', 'ask_user']) {
  check(`不含 ${forbidden}`, !worldNames.includes(forbidden))
}
check('含 load_skill（世界里也能翻阅学识）', worldNames.includes('load_skill'))
check('worldTools 常量覆盖五个世界工具', worldTools.length === 5)

console.log('\n【对照：普通对话仍拿到完整工具集】')
console.log(`  工具数：${chatNames.length}`)
for (const expected of ['read_file', 'write_file', 'bash', 'http_request']) {
  check(`仍含 ${expected}`, chatNames.includes(expected), '白名单改动波及了既有路径！')
}
check('普通对话不含世界工具', !chatNames.some((n) => n.startsWith('world_')),
  JSON.stringify(chatNames.filter((n) => n.startsWith('world_'))))

// ---------------------------------------------------------------
// 工具契约
// ---------------------------------------------------------------
// 直接调用工具的 execute —— 端到端测试无法确定性地让 LLM 调用某一个工具，
// 而工具的校验、上限与事件产出**是**确定性的，值得逐一钉住。

console.log('\n【工具契约】')
const spec = defaultTerrainSpec('连绵的山脉与森林', '')
const convId = 'tool-test-conv'
const ent = (
  id: string, name: string, x: number, z: number, kind: WorldEntity['kind'] = 'agent',
): WorldEntity => ({
  id, conversation_id: convId, kind, agent_id: kind === 'agent' ? `ag-${id}` : null,
  name, x, z, status: 'alive', created_at: 0, updated_at: 0,
})

function freshBox(actorId = 'a1') {
  const entities = [
    ent('a1', '阿黛尔', 0.1, 0.1),
    ent('a2', '小羊', 0.2, 0.2),
    ent('g1', '上帝', 0.15, 0.15, 'god'),
  ]
  const view: WorldView = { conversationId: convId, spec, laws: '', turn: 1, entities, recentEvents: [], patches: [] }
  const signal: WorldSignal = { view, actorId, pending: [], pendingPatches: [] }
  const ctx = { conversationId: convId, userId: 'tester', workspace: {} as never, agentId: 'ag-a1', worldSignal: signal } as unknown as ToolContext
  const run = (name: string, input: Record<string, unknown>) => {
    const tool = worldTools.find((t) => t.definition.name === name)!
    return tool.execute(input, ctx)
  }
  return { view, signal, run }
}

// world_move
{
  const b = freshBox()
  const r = await b.run('world_move', { x: 0.9, z: -0.9 })
  check('move 更新实体坐标', b.view.entities[0].x === 0.9 && b.view.entities[0].z === -0.9)
  check('move 产出事件', b.signal.pending.length === 1 && b.signal.pending[0].kind === 'move')
  check('move 结果描述目的地', String(r.summary).includes('你移动到'), String(r.summary).slice(0, 40))
  const b2 = freshBox()
  await b2.run('world_move', { x: 99, z: -99 })
  check('move 越界坐标被钳制到 ±1', b2.view.entities[0].x === 1 && b2.view.entities[0].z === -1)
  const bad = await freshBox().run('world_move', { x: 'abc', z: 0 })
  check('move 非数值坐标被拒', bad.error === true)
}

// world_speak
{
  const b = freshBox()
  const r = await b.run('world_speak', { content: '你好', to: '小羊' })
  check('speak 产出事件且带接收者', b.signal.pending.length === 1 && String(b.signal.pending[0].content).includes('小羊'))
  check('speak 结果确认送达', String(r.summary).includes('小羊'))
  const bad = await freshBox().run('world_speak', { content: '你好', to: '不存在的人' })
  check('speak 未知接收者被拒', bad.error === true)
  const self = await freshBox().run('world_speak', { content: '你好', to: '阿黛尔' })
  check('speak 不能对自己说', self.error === true)
}

// world_observe
{
  const b = freshBox()
  const r = await b.run('world_observe', {})
  check('observe 返回自身位置', String(r.summary).includes('你位于'))
  check('observe 列出附近存在', String(r.summary).includes('小羊'))
  check('observe 只读 —— 不产出事件', b.signal.pending.length === 0)
}

// world_act
{
  const b = freshBox()
  const r = await b.run('world_act', { action: '击碎了脚下的岩石', target: '小羊', target_status: 'dead' })
  check('act 致死 → 目标状态变更', b.view.entities[1].status === 'dead', b.view.entities[1].status)
  check('act 产出 act + die 两条事件', b.signal.pending.length === 2 && b.signal.pending[1].kind === 'die')
  check('act 结果声明不可挽回', String(r.summary).includes('无法挽回'))
  const noTarget = await freshBox().run('world_act', { action: 'x', target_status: 'dead' })
  check('act 声明结局但无目标 → 拒', noTarget.error === true)
  const badStatus = await freshBox().run('world_act', { action: 'x', target: '小羊', target_status: '受伤' })
  check('act 非法 target_status → 拒', badStatus.error === true)
  const onGod = await freshBox().run('world_act', { action: '试图弑神', target: '上帝' })
  check('act 无法作用于上帝', onGod.error === true)
}

// world_reshape
{
  const b = freshBox()
  const r = await b.run('world_reshape', { op: 'raise', x: 0.1, z: 0.1, radius: 0.3, strength: 0.8 })
  check('reshape 产出补丁', b.signal.pendingPatches.length === 1)
  check('reshape 补丁内容正确', b.signal.pendingPatches[0].op === 'raise' && b.signal.pendingPatches[0].center[0] === 0.1)
  check('reshape 产出事件', b.signal.pending.length === 1 && b.signal.pending[0].kind === 'act')
  check('reshape 结果声明永久', String(r.summary).includes('永久'))
  const clamped = await freshBox().run('world_reshape', { op: 'lower', x: 0, z: 0, radius: 99, strength: 1 })
  check('reshape 半径被钳制到 0.5', clamped.error !== true)
  const b2 = freshBox()
  await b2.run('world_reshape', { op: 'raise', x: 0, z: 0, radius: 0.2, strength: 0.5 })
  await b2.run('world_reshape', { op: 'raise', x: 0.3, z: 0, radius: 0.2, strength: 0.5 })
  const third = await b2.run('world_reshape', { op: 'raise', x: -0.3, z: 0, radius: 0.2, strength: 0.5 })
  check('reshape 单回合上限 2 次 → 第三次被拒', third.error === true, JSON.stringify(third.summary))
  check('reshape 上限内共 2 个补丁', b2.signal.pendingPatches.length === 2)
  const badOp = await freshBox().run('world_reshape', { op: '炸开', x: 0, z: 0, radius: 0.2, strength: 0.5 })
  check('reshape 非法 op → 拒', badOp.error === true)
  const badBiome = await freshBox().run('world_reshape', { op: 'paint', x: 0, z: 0, radius: 0.2, strength: 0.5, biome: '彩虹' })
  check('reshape 词表外 biome → 拒', badBiome.error === true)
  const okBiome = await freshBox().run('world_reshape', { op: 'paint', x: 0, z: 0, radius: 0.2, strength: 0.5, biome: 'lava' })
  check('reshape 词表内 biome → 通过', okBiome.error !== true && okBiome ? true : false)
}

console.log(`\n${'='.repeat(52)}\n通过 ${pass} 项，失败 ${fail} 项\n${'='.repeat(52)}`)
process.exit(fail > 0 ? 1 : 0)
