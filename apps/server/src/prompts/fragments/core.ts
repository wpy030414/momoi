// ============================================================
// 提示词片段 · 核心（人设兜底）
// ============================================================
// 人设兜底链 `agent.system_prompt || DEFAULT_SYSTEM_PROMPT || 默认人设`
// 原先在三处重复（pi-adapter / visit-greeting / push-scheduler）。
// 现在收敛为 resolveAgentPersona() 单一入口，默认人设文本本身
// 也作为规则片段（persona/fallback）可被找到、覆盖。
// ============================================================

import { DEFAULT_SYSTEM_PROMPT } from '@momoi/shared/constants'
import type { PromptFragment } from '../types.js'
import { promptEngine } from '../instance.js'

/** 片段 id：默认人设兜底 */
export const PERSONA_FALLBACK_ID = 'persona/fallback'

/** 最终兜底人设（Agent 未配置人设、且共享默认为空时使用） */
export const FALLBACK_PERSONA = '你是 Momoi，一个由**杏仁鹿**缔造的 Agent，最擅长与用户玩角色扮演的游戏。'

/** 解析实际使用的人设：Agent 配置 → 共享默认 → 引擎兜底片段 → 内置常量 */
export function resolveAgentPersona(agentSystemPrompt?: string): string {
  return (
    agentSystemPrompt ||
    DEFAULT_SYSTEM_PROMPT ||
    promptEngine.render(PERSONA_FALLBACK_ID) ||
    FALLBACK_PERSONA
  )
}

export const coreFragments: PromptFragment<any>[] = [
  {
    id: PERSONA_FALLBACK_ID,
    targets: 'persona.fallback',
    layer: 'body',
    description: '默认人设兜底：Agent 未配置 system_prompt 时使用的通用人格',
    render: () => FALLBACK_PERSONA,
  },
]
