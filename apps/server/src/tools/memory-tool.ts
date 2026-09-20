// ============================================================
// save_memory — Cross-session persistent memory for agents
// ============================================================

import type { ToolModule, ToolResult } from './types.js'
import { saveUserAgentMemory } from '../lib/config.js'

const MAX_MEMORY_LENGTH = 4000

export const memoryTool: ToolModule = {
  definition: {
    name: 'save_memory',
    description:
      '把关于当前用户的重要信息写入跨会话长期记忆。写入后会持久保存，' +
      '并在以后的每次会话中自动回到你的系统提示词里——即使换了新会话、历史被清空，你依然记得。' +
      '\n【必须调用】用户明确要求你记住某事时（「记住」「记一下」「别忘了」「永远记住」「以后都要」；' +
      '英文 remember this / keep that in mind / don\'t forget），必须立即调用本工具。' +
      '只在回复里口头答应「我记住了」不会真正记住——下次会话你就会彻底忘记。' +
      '\n【主动调用】用户透露了值得长期保留的事实时：期望的称呼与名字、身份、' +
      '稳定的喜好与厌恶、长期目标与约定、重要日期、对彼此有特殊意义的事。' +
      '\n【不要调用】一次性的、临时的、剧情内的琐事；也不要把整段对话总结成一条记忆。' +
      '\n一条独立事实调用一次，同一轮可以调用多次。content 写成脱离当前对话也能读懂的完整陈述句' +
      '（用「用户…」或第三人称），不要用「你」「刚才说的」这类依赖上下文的指代。' +
      '\n返回成功即表示已经持久化，同一条事实不需要重复保存。',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description:
            '要保存的记忆内容。写成一条脱离当前对话也能读懂的陈述句，' +
            '例如「用户希望被称呼为『鹿鹿』」或「用户是研究火山活动的研究生」。' +
            '一条独立事实一条记忆，不要合并成长段落。',
        },
      },
      required: ['content'],
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const content = String(input.content || '').trim()
    if (!content) {
      return { summary: 'Memory content cannot be empty.', error: true }
    }
    if (content.length > MAX_MEMORY_LENGTH) {
      return { summary: `Memory content too long (${content.length} characters, max ${MAX_MEMORY_LENGTH}).`, error: true }
    }
    if (ctx.memoryDisabled) {
      return { summary: 'Cannot save memory: cross-session memory is disabled in this conversation.', error: true }
    }
    if (!ctx.agentId) {
      return { summary: 'Cannot save memory: agent identity unknown.', error: true }
    }

    await saveUserAgentMemory(ctx.userId, ctx.agentId, content, 'agent')
    const preview = content.length > 200 ? content.slice(0, 200) + '...' : content
    return { summary: `Memory saved for all future sessions: "${preview}"` }
  },
}