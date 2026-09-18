import type { ToolDefinition } from '@momoi/shared/types'
import { getToolDefinitions } from '../tools/registry.js'

/**
 * Aggregate tool definitions from built-in tool modules.
 */
export function getAllTools(): ToolDefinition[] {
  return getToolDefinitions()
}
