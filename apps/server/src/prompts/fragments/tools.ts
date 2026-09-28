// ============================================================
// 提示词片段 · 工具描述目录（tool.description）
// ============================================================
// 工具描述是模型每一轮都会读到的提示词（写入 tools 参数里），
// 因此工具描述也纳入引擎目录：可以在 list() / 管理端「找到」，
// 也可以通过 promptEngine.override('tool/<name>', ...) 覆盖文本。
//
// 注入路径保持原样（工具 schema 的 description 字段），仅在此处解析
// 「实际使用哪段描述」——引擎里注册的优先，回退工具定义本身。
//
// 本模块刻意 **不 import 工具系统**：prompts 库保持为「纯字符串 + 注册表」，
// 不把 DB（sql.js）与文档解析库拖进任何引用 prompts/index.js 的地方。
// 描述源由调用方注入（pi-adapter 手里的 ToolDefinition 就够了）；
// 管理端目录另经 seedToolDescriptions() 批量播种。
// MCP 工具描述来自远端、随连接动态变化，不进入目录（回退远程描述）。
// ============================================================

import type { ToolDefinition } from '@momoi/shared/types'
import type { PromptFragment } from '../types.js'
import { promptEngine } from '../instance.js'

export const TOOL_DESCRIPTION_TARGET = 'tool.description'

/** 工具描述片段 id：tool/<工具名> */
export function toolDescriptionId(name: string): string {
  return `tool/${name}`
}

/** 确保某个工具的描述已进入目录（幂等：已有条目——含运行时覆盖——不重注册） */
export function ensureToolDescription(def: ToolDefinition): void {
  const id = toolDescriptionId(def.name)
  if (promptEngine.has(id)) return
  const fragment: PromptFragment<{ name: string }> = {
    id,
    targets: TOOL_DESCRIPTION_TARGET,
    layer: 'body',
    description: `工具描述：${def.name}`,
    source: 'tool',
    render: () => def.description,
  }
  promptEngine.register(fragment)
}

/** 批量播种工具描述目录（管理端列表 / 启动期调用；幂等） */
export function seedToolDescriptions(defs: ToolDefinition[]): void {
  for (const def of defs) ensureToolDescription(def)
}

/** 解析工具实际使用的描述：引擎目录（可被覆盖）优先，回退到工具定义本身 */
export function resolveToolDescription(def: ToolDefinition): string {
  ensureToolDescription(def)
  return promptEngine.render(toolDescriptionId(def.name)) ?? def.description
}
