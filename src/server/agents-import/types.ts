import type { AgentOrigin } from '../../shared/types.js'

/** 包级元数据（预览响应 package 字段的来源） */
export interface AipPackageInfo {
  name: string
  version: string
  host?: string
}

/** 包内发现的一个 persona（扩展清单或通用层） */
export interface PersonaCandidate {
  id: string
  name: string
  /** 插件根相对路径的 primary 正文文件 */
  primaryFile: string
  /** primary 文件原始字节数 */
  primaryBytes: number
  /** primary 文件正文 trim() 后的系统提示词 */
  systemPrompt: string
  /** 头像 dataURL；仅当头像文件存在且 ≤5MB */
  avatar?: string
  /** 清单声明的档位组合数（未声明 levels 时为 1，即 primary 本身） */
  levelCount: number
}

export interface SkillFileEntry {
  /** 技能目录内的 posix 相对路径 */
  path: string
  data: Buffer
}

export interface SkillCandidate {
  name: string
  description: string
  files: SkillFileEntry[]
  /** 文件树 sha256（排序后按路径 + 长度 + 内容） */
  contentHash: string
}

export interface ParsedPackage {
  package: AipPackageInfo
  candidates: PersonaCandidate[]
  skills: SkillCandidate[]
  warnings: string[]
  errors: string[]
}

/** 包级致命失败（映射为 400）或解析成功 */
export type ParseResult = { ok: true; data: ParsedPackage } | { ok: false; error: string }

export interface PersonaConflictInfo {
  agentId: string
  agentName: string
  sameOrigin: boolean
}

export interface SkillConflictInfo {
  installed: boolean
  contentIdentical: boolean
}

export interface PersonaConflictEntry {
  candidate: PersonaCandidate
  conflict?: PersonaConflictInfo
}

export interface SkillConflictEntry {
  candidate: SkillCandidate
  conflict: SkillConflictInfo
}

export interface ConflictReport {
  personas: PersonaConflictEntry[]
  skills: SkillConflictEntry[]
}

/** 冲突比对所需的已装技能摘要（名称 + 文件树哈希） */
export interface InstalledSkillHash {
  name: string
  contentHash: string
}

export type PersonaAction = 'create' | 'overwrite' | 'skip'
export type SkillAction = 'install' | 'skip'

export interface PersonaDecision {
  id: string
  action: PersonaAction
  name?: string
  model?: string
}

export interface SkillDecision {
  name: string
  action: SkillAction
}

export interface CommitDecisions {
  personas?: PersonaDecision[]
  skills?: SkillDecision[]
}

export interface PersonaPlanItem {
  kind: PersonaAction
  candidate: PersonaCandidate
  name: string
  model: string
  origin: AgentOrigin
  /** 仅 overwrite：冲突命中的目标 agent id */
  targetAgentId?: string
}

export interface SkillPlanItem {
  kind: 'install' | 'overwrite' | 'skip'
  candidate: SkillCandidate
}

/**
 * 决议映射结果：纯数据，由路由执行。
 * requestError 非空时映射为 400（整单拒绝）；errors 为逐条失败（其余继续）。
 */
export interface CommitPlan {
  personas: PersonaPlanItem[]
  skills: SkillPlanItem[]
  errors: string[]
  requestError?: string
}
