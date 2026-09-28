// ============================================================
// Prompt Rule Engine — 类型契约
// ============================================================
// 「提示词规则引擎」把散落在各处的提示词收敛为一等公民：
//
//   PromptFragment（规则/片段） —— 一段带条件的、可插拔的提示词文本
//   PromptTarget（配方）        —— 某个调用场景要组装的完整提示词
//   PromptLayer（层）           —— 片段在配方中的位置（顺序由配方定义）
//   PromptEngine（引擎）        —— 注册表 + 组装流水线（见 engine.ts）
//
// 设计立场：片段是「规则」，条件（when）是「规则的适用前提」，
// 层与优先级是「规则的作用位置」，组装结果可逐段溯源（AssembledPart）。
// ============================================================

/** 组装目标：一个消费提示词的位置（一份「配方」）。
 *  内置目标见各 fragments 模块；字符串类型是开放的——技能等扩展可自定义配方。 */
export type PromptTarget = string

/** 组装层级：决定片段在最终提示词中的先后位置。
 *  顺序由目标配方的 layerOrder 定义（见 registry.ts 的 defineTarget 调用）。 */
export type PromptLayer = string

/** 片段来源标记（供 list() / 管理端展示与排查） */
export type PromptSource =
  | 'builtin'          // 引擎内置
  | 'override'         // 运行时覆盖（override() 写入）
  | `skill:${string}`  // 技能扩展
  | 'runtime'          // 临时片段（组装时注入，如对话记录等数据块）
  | 'tool'             // 工具描述目录

/**
 * 提示词片段（一条规则）。
 *
 * - `id` 全局唯一，建议 `领域/名称`（如 `chat/memory-rules`）；重复注册 = 原位覆盖。
 * - `targets` 为 `'*'` 时适用于所有目标（全局规则）。
 * - `when` 返回 false 时该片段不产出；缺省恒真。
 * - `render` 返回空串/null 视为不产出（片段之间不会留下空位）。
 */
export interface PromptFragment<C extends object = Record<string, unknown>> {
  id: string
  targets: '*' | PromptTarget | PromptTarget[]
  layer: PromptLayer
  /** 同层内的排序权重：数值大者靠前（默认 0） */
  priority?: number
  /** 用途说明（list()/管理端展示用——「找得到」的入口） */
  description: string
  when?: (ctx: C) => boolean
  render: (ctx: C) => string | null | undefined
  source?: PromptSource
}

/** 组装结果中的单个片段贡献（逐段溯源：这段文字从哪来） */
export interface AssembledPart {
  id: string
  layer: PromptLayer
  priority: number
  description: string
  source: PromptSource
  /** 该片段渲染出的文本 */
  content: string
}

/** 组装结果：text 即最终提示词；parts 供管理端/调试查看逐段来源 */
export interface AssembledPrompt {
  target: PromptTarget
  text: string
  parts: AssembledPart[]
}

/** 目标配方：定义层顺序与拼接方式 */
export interface PromptTargetSpec {
  /** 层顺序（先出现者在前；未列出的层排在已知层之后） */
  layers: PromptLayer[]
  /** 片段之间的连接符（默认 '\n\n'） */
  separator?: string
  /** 配方用途说明 */
  description?: string
}

/** 片段元信息（list() 返回，不含 render 函数） */
export interface PromptFragmentInfo {
  id: string
  targets: PromptTarget[]
  layer: PromptLayer
  priority: number
  description: string
  source: PromptSource
  /** 是否带 when 条件 */
  conditional: boolean
  /** 是否被禁用 */
  disabled: boolean
}

/** 目标配方元信息（listTargets() 返回） */
export interface PromptTargetInfo {
  target: PromptTarget
  description: string
  layers: PromptLayer[]
  separator: string
  /** 已注册到该目标的片段数（不含禁用与临时片段） */
  fragmentCount: number
}
