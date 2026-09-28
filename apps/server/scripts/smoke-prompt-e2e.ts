// ============================================================
// 真实链路冒烟：提示词组装 → 上游模型 → 回复
// ============================================================
// 用途：改完提示词（prompts/fragments/**）后，验证整条推理链路仍然工作。
// 直接调用 runPiAgentLoop，不经 HTTP / 鉴权 / 落库；需要 .env 中配置 OPENAI_*。
//
// 会真实调用一次上游模型（消耗极少量 token）——不要放进自动化测试。
//
// 用法：
//   pnpm --filter @momoi/server exec tsx scripts/smoke-prompt-e2e.ts
// ============================================================

import { rmSync } from 'node:fs'
import path from 'node:path'
import { runPiAgentLoop } from '../src/ai/pi-adapter.js'
import { listAgents } from '../src/lib/config.js'
import { repoRoot } from '../src/lib/paths.js'

const convId = `e2e-prompt-smoke-${Date.now()}`
const agents = await listAgents()
const agent = agents.find((a) => a.role !== 'neutral') ?? agents[0]
if (!agent) {
  console.error('[smoke] 没有可用 Agent（agents 表为空）')
  process.exit(1)
}

console.log(`[smoke] agent=${agent.name} (${agent.id})  model=${agent.model || '(默认)'}`)
console.log(`[smoke] 人设长度=${agent.system_prompt.length} 字符（将由规则引擎组装进系统提示词）`)

const events: string[] = []
const result = await runPiAgentLoop({
  userMessage: '用一句话自我介绍，不超过 20 字。',
  history: [],
  send: (msg) => { events.push(msg.type) },
  thinkingMode: true,
  conversationId: convId,
  userId: 'e2e-smoke',
  agentId: agent.id,
})

console.log(`[smoke] 事件流：${events.join(' → ') || '(无)'}`)
console.log(`[smoke] 回复：${result.reply || '(空)'}`)

// 清理本次冒烟的工作区（runPiAgentLoop 会为会话建立沙盒目录）
try {
  rmSync(path.resolve(repoRoot(), 'data', 'workspaces', convId), { recursive: true, force: true })
} catch { /* 忽略清理失败 */ }

if (!result.reply) {
  console.error('[smoke] 失败：空回复（检查 .env 的 OPENAI_* 与上游可达性）')
  process.exit(1)
}
console.log('[smoke] OK ✓')
