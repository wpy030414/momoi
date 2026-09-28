// ============================================================
// 提示词规则引擎 — 预览上下文归化
// ============================================================
// 管理端「提示词预览」用：把请求里的任意 JSON 归化为某份配方的合法上下文。
// 白名单化（键 + 类型双重过滤），避免把未预期的数据喂进片段渲染。
// ============================================================

import type { PromptTarget } from './types.js'
import { CHAT_SYSTEM_TARGET } from './fragments/chat.js'
import {
  FOLLOWUP_TARGETS,
  SUGGESTIONS_TARGETS,
  ORCHESTRATION_TARGETS,
} from './fragments/neutral.js'
import { GREETING_TARGET } from './fragments/notification.js'

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined
}

/** 把管理端请求体归化为 chat.system 的合法上下文 */
function pickChatContext(input: Record<string, unknown>): Record<string, unknown> {
  const ctx: Record<string, unknown> = {}
  const strings = ['agentSystemPrompt', 'language', 'agentName', 'mentionedBy', 'protagonistName'] as const
  for (const key of strings) {
    const v = asString(input[key])
    if (v !== undefined) ctx[key] = v
  }
  const booleans = ['thinkingMode', 'memoryEnabled', 'isGroup', 'isQqGroup', 'infiniteMode'] as const
  for (const key of booleans) {
    const v = asBoolean(input[key])
    if (v !== undefined) ctx[key] = v
  }
  const arrays = ['userMemories', 'groupAgentNames'] as const
  for (const key of arrays) {
    const v = asStringArray(input[key])
    if (v !== undefined) ctx[key] = v
  }
  const lastMessageAt = asNumber(input.lastMessageAt)
  if (lastMessageAt !== undefined) ctx.lastMessageAt = lastMessageAt
  const now = asNumber(input.now)
  if (now !== undefined) ctx.now = now

  const world = input.world
  if (world && typeof world === 'object' && typeof (world as { laws?: unknown }).laws === 'string') {
    ctx.world = { laws: (world as { laws: string }).laws }
  }
  const speakingRole = asString(input.speakingRole)
  if (speakingRole === 'protagonist' || speakingRole === 'supporting') {
    ctx.speakingRole = speakingRole
  }
  const skills = input.skills
  if (
    Array.isArray(skills) &&
    skills.every(
      (s) => s && typeof s === 'object' && typeof (s as any).name === 'string' && typeof (s as any).description === 'string',
    )
  ) {
    ctx.skills = (skills as Array<{ name: string; description: string }>).map((s) => ({
      name: s.name,
      description: s.description,
    }))
  }
  return ctx
}

/** 按配方白名单归化预览上下文；未识别的键一律丢弃。 */
export function normalizePreviewContext(
  target: PromptTarget,
  input: Record<string, unknown>,
): Record<string, unknown> {
  switch (target) {
    case CHAT_SYSTEM_TARGET:
      return pickChatContext(input)
    case FOLLOWUP_TARGETS.system:
    case SUGGESTIONS_TARGETS.system:
    case ORCHESTRATION_TARGETS.system:
      return { extra: asString(input.extra) }
    case FOLLOWUP_TARGETS.user:
    case SUGGESTIONS_TARGETS.user:
      return { context: asString(input.context) ?? '' }
    case ORCHESTRATION_TARGETS.user:
      return { members: asStringArray(input.members) ?? [], context: asString(input.context) ?? '' }
    case GREETING_TARGET:
      return { sinceLast: input.sinceLast == null ? null : asString(input.sinceLast) ?? null }
    default:
      return {}
  }
}
