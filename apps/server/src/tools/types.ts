// ============================================================
// Tool System — Core Types
// ============================================================

import type { ToolDefinition } from '@momoi/shared/types'
import type { SandboxFS } from './workspace.js'
import type { MentionSignal } from './group-mention-tool.js'

/** Pi Agent Core 的进度回调类型（避免直接依赖 pi-agent-core） */
export type ToolUpdateCallback = (partialResult: { content?: Array<{ type: string; text?: string }>; details?: unknown }) => void

/** Context passed to every tool's execute function */
export interface ToolContext {
  conversationId: string
  userId: string
  workspace: SandboxFS
  signal?: AbortSignal
  /** Group chat: @mention signal shared between orchestrator and at_mention tool */
  mentionSignal?: MentionSignal
  /** Current tool call ID (assigned by Pi loop) */
  currentToolCallId?: string
  /** Pi Agent Core 的进度回调，用于 tool_execution_update 事件 */
  onUpdate?: ToolUpdateCallback
  /** The agent currently speaking (needed by tools like save_memory) */
  agentId?: string
  /**
   * 本次运行禁用跨会话记忆（QQ 群聊等多真人场景）。
   * 双重兜底：`createToolAdapter` 据此剔除 save_memory 工具，
   * 工具执行层（memory-tool.ts）也会拒绝写入——不依赖"工具没被暴露"这一层假设。
   */
  memoryDisabled?: boolean
}

/** Optional artifact: a file produced by a tool, surfaced to the user */
export interface ToolArtifact {
  filename: string      // path within workspace
  displayName: string   // human-friendly name for the download link
  mimeType: string
  downloadUrl: string   // e.g. /api/workspace/{conversationId}/file/{filename}
}

/** What a tool returns after execution */
export interface ToolResult {
  /** Text summary sent back to the LLM */
  summary: string
  /** Optional files produced, surfaced to the user as download links */
  artifacts?: ToolArtifact[]
  /** Optional structured data for the LLM (serialized to JSON) */
  data?: unknown
  /** If true, the tool failed; summary contains the error message */
  error?: boolean
  /**
   * 终止信号（等价 Pi 的 result.terminate）：当本批所有工具都置为 true，
   * 批执行会提前收口，不再发起下一轮 LLM 调用。用于「依据已足够/目标已达成」。
   */
  terminate?: boolean
}

/** Shape every tool module must export */
export interface ToolModule {
  definition: ToolDefinition
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}
