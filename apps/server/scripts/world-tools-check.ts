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
import type { WorldSignal } from '../src/tools/world-tools.js'
import type { ToolContext } from '../src/tools/types.js'

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
check('worldTools 常量覆盖四个世界工具', worldTools.length === 4)

console.log('\n【对照：普通对话仍拿到完整工具集】')
console.log(`  工具数：${chatNames.length}`)
for (const expected of ['read_file', 'write_file', 'bash', 'http_request']) {
  check(`仍含 ${expected}`, chatNames.includes(expected), '白名单改动波及了既有路径！')
}
check('普通对话不含世界工具', !chatNames.some((n) => n.startsWith('world_')),
  JSON.stringify(chatNames.filter((n) => n.startsWith('world_'))))

console.log(`\n${'='.repeat(52)}\n通过 ${pass} 项，失败 ${fail} 项\n${'='.repeat(52)}`)
process.exit(fail > 0 ? 1 : 0)
