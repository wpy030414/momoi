// ============================================================
// Prompt Rule Engine — 内置片段注册表
// ============================================================
// 引擎实例（instance.ts）+ 全部内置片段的注册与配方定义。
// 这里是「所有的提示词都可以在里面被找到」的那个「里面」：
//   - 找：promptEngine.list() / listTargets()（管理端 API 亦然）
//   - 管：register / override / disable / enable / unregister
//   - 组装：promptEngine.assemble(target, ctx)（各域 build* 函数是其封装）
//
// 本模块有副作用：导入即完成注册。外部代码一律从 index.js 导入。
// ============================================================

import { promptEngine } from './instance.js'
import { coreFragments } from './fragments/core.js'
import { chatFragments, CHAT_SYSTEM_TARGET, CHAT_SYSTEM_LAYERS } from './fragments/chat.js'
import {
  neutralFragments,
  FOLLOWUP_TARGETS,
  SUGGESTIONS_TARGETS,
  ORCHESTRATION_TARGETS,
} from './fragments/neutral.js'
import { notificationFragments, GREETING_TARGET, PUSH_TARGET } from './fragments/notification.js'
import { retryFragments } from './fragments/retry.js'
import { syncToolDescriptions, TOOL_DESCRIPTION_TARGET } from './fragments/tools.js'

// ---- 配方定义（层顺序 = 最终提示词中的先后位置） ----

promptEngine
  .defineTarget(CHAT_SYSTEM_TARGET, {
    layers: CHAT_SYSTEM_LAYERS,
    description: '主对话系统提示词：网页 / 群聊 / 世界 / 微信 / QQ 的 Agent 回复共用',
  })
  .defineTarget(FOLLOWUP_TARGETS.system, {
    layers: ['body'],
    description: '无限演算模式 · 追问代笔（系统提示词）',
  })
  .defineTarget(FOLLOWUP_TARGETS.user, {
    layers: ['body'],
    separator: '\n',
    description: '无限演算模式 · 追问代笔（对话记录 + 输出锚点）',
  })
  .defineTarget(SUGGESTIONS_TARGETS.system, {
    layers: ['body'],
    description: '追问建议 · 3 条备选（系统提示词）',
  })
  .defineTarget(SUGGESTIONS_TARGETS.user, {
    layers: ['body'],
    separator: '\n',
    description: '追问建议 · 对话记录 + 输出锚点',
  })
  .defineTarget(ORCHESTRATION_TARGETS.system, {
    layers: ['body'],
    description: '群聊发言调度裁决（系统提示词）',
  })
  .defineTarget(ORCHESTRATION_TARGETS.user, {
    layers: ['body'],
    description: '群聊发言调度裁决（成员名单 + 对话上下文）',
  })
  .defineTarget(GREETING_TARGET, {
    layers: ['body'],
    description: '访问问候：Agent 主动打招呼的生成指令',
  })
  .defineTarget(PUSH_TARGET, {
    layers: ['body'],
    description: '离线推送：Agent 催回消息的生成指令',
  })
  .defineTarget('persona.fallback', {
    layers: ['body'],
    description: '默认人设兜底（Agent 未配置 system_prompt 时使用）',
  })
  .defineTarget('retry.message', {
    layers: ['body'],
    description: '敏感词规避链路注入对话流的消息文本',
  })
  .defineTarget(TOOL_DESCRIPTION_TARGET, {
    layers: ['body'],
    description: '工具描述目录（按工具名单独渲染，写入工具 schema）',
  })

// ---- 内置片段注册 ----

promptEngine.registerAll([
  ...coreFragments,
  ...chatFragments,
  ...neutralFragments,
  ...notificationFragments,
  ...retryFragments,
])

// 工具描述目录（幂等；不覆盖运行时 override）
syncToolDescriptions()

export { promptEngine }
