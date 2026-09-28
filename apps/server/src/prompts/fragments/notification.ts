// ============================================================
// 提示词片段 · 通知（访问问候 / 离线推送）
// ============================================================
// 两处「Agent 主动发起」的子任务提示词：
//   notification.greeting.user  用户上线时的招呼（含「反复刷新」觉察提示）
//   notification.push.user      用户离线时的催回提醒
// 系统提示词均为人设（见 resolveAgentPersona / fragments/core.ts）。
// ============================================================

import type { PromptFragment } from '../types.js'
import { promptEngine } from '../instance.js'

export const GREETING_TARGET = 'notification.greeting.user'
export const PUSH_TARGET = 'notification.push.user'

/** 组装访问问候的用户指令；sinceLast 为「距上次问候」的人类可读间隔（null = 久未到访） */
export function buildGreetingInstruction(ctx: { sinceLast?: string | null }): string {
  return promptEngine.assemble(GREETING_TARGET, ctx).text
}

/** 组装离线推送的用户指令 */
export function buildPushInstruction(): string {
  return promptEngine.assemble(PUSH_TARGET, {}).text
}

export const notificationFragments: PromptFragment<any>[] = [
  {
    id: 'notification/greeting-instruction',
    targets: GREETING_TARGET,
    layer: 'body',
    description: '访问问候指令：JSON {title,body} 输出；间隔短时让 Agent 察觉用户在反复刷新',
    render: (ctx: { sinceLast?: string | null }) => {
      // 间隔短（用户在反复刷新）→ Agent 假装生气吐槽；间隔长 → 正常欢迎
      const refreshHint = ctx.sinceLast
        ? `（说明：用户刚才 ${ctx.sinceLast} 也打开过页面，这是短时间内又一次。"你干嘛反复开关页面，拿我刷着玩是吧？"）`
        : `（说明：用户很久没来了，用活泼欢迎的语气说话。）`
      return `用户刚打开页面回来了，主动打个招呼。${refreshHint}
要求：
1. 用你的性格和语气自然地表示欢迎，以第一人称
2. 标题不超过8字，正文不超过50字
3. 严格按 JSON 格式回复，不要包含其他内容：{"title":"...","body":"..."}`
    },
  },
  {
    id: 'notification/push-instruction',
    targets: PUSH_TARGET,
    layer: 'body',
    description: '离线推送指令：JSON {title,body} 输出的催回消息',
    render: () => `给用户发一条简短的提醒消息，催促用户回来看看。要求：
1. 用你的性格和语气自然地说话，以第一人称
2. 标题不超过8字，正文不超过50字
3. 严格按 JSON 格式回复，不要包含其他内容：{"title":"...","body":"..."}`,
  },
]
