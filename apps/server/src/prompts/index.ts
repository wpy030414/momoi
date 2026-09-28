// ============================================================
// Prompt Rule Engine — 公共出口
// ============================================================
// 外部代码一律从这里导入，保证内置片段一定完成注册（registry 的副作用导入）。
// ============================================================

// 注册内置片段与配方（副作用导入：必须先于任何组装调用完成）
import './registry.js'

export { promptEngine } from './registry.js'
export { PromptEngine } from './engine.js'
export type { PromptFragmentPatch, AssembleOptions } from './engine.js'
export type {
  AssembledPart,
  AssembledPrompt,
  PromptFragment,
  PromptFragmentInfo,
  PromptLayer,
  PromptSource,
  PromptTarget,
  PromptTargetInfo,
  PromptTargetSpec,
} from './types.js'

// ---- 核心 ----
export { resolveAgentPersona, FALLBACK_PERSONA, PERSONA_FALLBACK_ID } from './fragments/core.js'

// ---- 主对话 ----
export { buildChatSystemPrompt, CHAT_SYSTEM_TARGET, CHAT_SYSTEM_LAYERS } from './fragments/chat.js'
export type { ChatPromptContext } from './fragments/chat.js'

// ---- 中立 Agent ----
export {
  buildFollowUpSystemPrompt,
  buildFollowUpUserMessage,
  buildSuggestionsSystemPrompt,
  buildSuggestionsUserMessage,
  buildOrchestrationSystemPrompt,
  buildOrchestrationUserMessage,
  FOLLOWUP_TARGETS,
  SUGGESTIONS_TARGETS,
  ORCHESTRATION_TARGETS,
} from './fragments/neutral.js'

// ---- 通知 ----
export {
  buildGreetingInstruction,
  buildPushInstruction,
  GREETING_TARGET,
  PUSH_TARGET,
} from './fragments/notification.js'

// ---- 重试消息 ----
export {
  getFabricatedReply,
  getRetryPlaceholder,
  FABRICATED_REPLY_ID,
  RETRY_PLACEHOLDER_ID,
} from './fragments/retry.js'

// ---- 工具描述目录 ----
export {
  resolveToolDescription,
  syncToolDescriptions,
  toolDescriptionId,
  TOOL_DESCRIPTION_TARGET,
} from './fragments/tools.js'

// ---- 管理端预览 ----
export { normalizePreviewContext } from './preview.js'
