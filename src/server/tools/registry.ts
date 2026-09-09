// ============================================================
// Tool Registry — Aggregates all built-in tool modules
// ============================================================

import { fileTools } from './file-tools.js'
import { httpTool } from './http-tool.js'
import { documentTools } from './document-tools.js'
import { skillTools } from './skill-tools.js'
import { bashTool } from './bash-tool.js'
import type { ToolModule } from './types.js'
import type { ToolDefinition } from '../../shared/types.js'

const allTools: ToolModule[] = [
  ...fileTools,
  httpTool,
  ...documentTools,
  ...skillTools,
  bashTool,
]

/** Get all tool definitions for the LLM */
export function getToolDefinitions(): ToolDefinition[] {
  return allTools.map((t) => t.definition)
}

/** Find a tool module by name */
export function resolveTool(name: string): ToolModule | undefined {
  return allTools.find((t) => t.definition.name === name)
}
