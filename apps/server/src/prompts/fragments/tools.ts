// ============================================================
// 提示词片段 · 工具描述目录（tool.description）
// ============================================================
// 工具描述是模型每一轮都会读到的提示词（写入 tools 参数里），
// 因此工具描述也纳入引擎目录：可以在 list() / 管理端「找到」，
// 也可以通过 promptEngine.override('tool/<name>', ...) 覆盖文本。
//
// 注入路径保持原样（工具 schema 的 description 字段），仅在此处解析
// 「实际使用哪段描述」——引擎里注册的优先，回退工具定义本身。
// MCP 工具描述来自远端、随连接动态变化，不进入目录（回退原描述）。
// ============================================================

import type { ToolDefinition } from '@momoi/shared/types'
import type { PromptFragment } from '../types.js'
import { promptEngine } from '../instance.js'
import { getToolDefinitions } from '../../tools/registry.js'

export const TOOL_DESCRIPTION_TARGET = 'tool.description'

/** 工具描述片段 id：tool/<工具名> */
export function toolDescriptionId(name: string): string {
  return `tool/${name}`
}

/** 把内置工具描述同步进引擎目录（幂等：已注册的保留原样，不被重新注册抹掉覆盖） */
export function syncToolDescriptions(): void {
  for (const def of getToolDefinitions()) {
    const id = toolDescriptionId(def.name)
    if (promptEngine.has(id)) continue
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
}

/** 解析工具实际使用的描述：引擎目录（可被覆盖）优先，回退到工具定义本身 */
export function resolveToolDescription(def: ToolDefinition): string {
  syncToolDescriptions()
  return promptEngine.render(toolDescriptionId(def.name)) ?? def.description
}
