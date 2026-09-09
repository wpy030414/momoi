// ============================================================
// Ask User Tool — 阻塞式询问用户
// ============================================================
//
// 当 Agent 需要用户补充信息时，调用此工具暂停执行并向用户提问。
// 用户回答（选选项 / 自由填写 / 跳过）后，回答作为工具结果回传 LLM。
//
// 核心机制：execute() 返回一个不 resolve 的 Promise，Pi 循环自然等待。
// 通过 ctx.onUpdate 触发 tool_execution_update 事件，下发 ask_user SSE。
// 外部通过 resolveQuestion() 唤醒 Promise，由 POST /api/chat/:id/answer 端点调用。
//
// ============================================================

import { randomUUID } from 'node:crypto'
import type { ToolModule, ToolContext, ToolResult } from './types.js'
import type { AskUserQuestion } from '../../shared/types.js'

const ASK_USER_TIMEOUT_MS = 120_000

// ---- 问题挂起表 ----

interface PendingQuestion {
  resolve: (result: ToolResult) => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
  toolCallId: string
  conversationId: string
  questionId: string
}

const questionMap = new Map<string, PendingQuestion>()

/** 清理挂起问题（resolve/reject 后调用，确保幂等） */
function cleanup(questionId: string): void {
  const entry = questionMap.get(questionId)
  if (!entry) return
  clearTimeout(entry.timer)
  questionMap.delete(questionId)
}

/** 由 answer 端点调用：接受用户回答 */
export function resolveQuestion(questionId: string, answer: string, selectedOptions?: string[]): boolean {
  const entry = questionMap.get(questionId)
  if (!entry) return false

  const answerText = selectedOptions && selectedOptions.length > 0
    ? `用户选择了: ${selectedOptions.join(', ')}。附加说明: ${answer || '无'}`
    : (answer || '用户跳过了此问题。')

  cleanup(questionId)
  entry.resolve({
    summary: answerText,
    data: { questionId, answer, selectedOptions },
  })
  return true
}

/** 拒绝问题（超时/取消/abort 时调用） */
export function rejectQuestion(questionId: string, reason: string): boolean {
  const entry = questionMap.get(questionId)
  if (!entry) return false
  cleanup(questionId)
  entry.reject(new Error(reason))
  return true
}

/** 获取挂起问题信息（用于端点验证） */
export function getPendingQuestion(questionId: string): PendingQuestion | undefined {
  return questionMap.get(questionId)
}

/** 断开时清理指定会话的所有挂起问题 */
export function cleanupConversationQuestions(conversationId: string): void {
  for (const [id, entry] of questionMap) {
    if (entry.conversationId === conversationId) {
      clearTimeout(entry.timer)
      entry.reject(new Error('SSE 连接已断开'))
      questionMap.delete(id)
    }
  }
}

// ---- 工具定义 ----

export const askUserTool: ToolModule = {
  definition: {
    name: 'ask_user',
    description:
      '向用户提问并等待回答。当你需要用户做出选择、补充信息、确认决定、' +
      '或任何你不确定而用户清楚的事情时，应当优先使用此工具而不是猜测或假设。' +
      '典型场景：命名文件/变量/项目、选择技术方案/数据库/工具、确认操作（是否删除/覆盖）、' +
      '询问偏好（格式/风格/语言）、索取缺失的必要参数。' +
      '调用后你会暂停执行，直到用户回答。提供选项能让用户更快做出决定，但不是必须的——' +
      '如果问题太开放无法预设选项，传空 options 即可让用户自由输入。' +
      '不要在琐碎小事上使用（如"我可以开始了吗"），但遇到真正的决策点应主动询问。',
    input_schema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description:
            '要问用户的问题列表（通常只需 1 个问题）。每个问题是一个对象，' +
            '包含以下字段：header（短标签，最多 12 字符）、question（完整问题文本）、' +
            'options（选项数组，每个选项包含 label 和可选的 description，2-4 个）、' +
            'multiSelect（是否允许多选，默认 false）。如果不需要预设选项，options 可以设为空数组，' +
            '用户将可以自由输入文字。',
          items: {
            type: 'object',
            properties: {
              header: {
                type: 'string',
                description: '问题的简短标签（如「文件命名」「数据库选择」），最多 12 字符，显示为 chip 标签',
              },
              question: {
                type: 'string',
                description: '完整的、需要用户回答的问题文本。应当清晰、具体，让用户一看就明白需要做什么决定',
              },
              options: {
                type: 'array',
                description: '预设选项列表，2-4 个。如果不需要选项，传空数组 []，用户将可以自由输入文字',
                items: {
                  type: 'object',
                  properties: {
                    label: {
                      type: 'string',
                      description: '选项的显示文本，如「SQLite」「PostgreSQL」',
                    },
                    description: {
                      type: 'string',
                      description: '可选：该选项的辅助说明文字，如轻量级优先选此',
                    },
                  },
                  required: ['label'],
                },
              },
              multiSelect: {
                type: 'boolean',
                description: '是否允许多选。false=单选，true=多选。默认为 false',
              },
            },
            required: ['header', 'question', 'options', 'multiSelect'],
          },
        },
      },
      required: ['questions'],
    },
  },

  execute: async (input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
    const questionsRaw = input.questions as AskUserQuestion[] | undefined

    if (!questionsRaw || !Array.isArray(questionsRaw) || questionsRaw.length === 0) {
      return { summary: 'Error: questions must be a non-empty array.', error: true }
    }

    // 验证每个问题
    for (const q of questionsRaw) {
      if (!q.question) {
        return { summary: 'Error: each question must have a "question" field.', error: true }
      }
      if (q.options && (q.options.length < 2 || q.options.length > 4)) {
        return { summary: 'Error: options must have 2-4 items.', error: true }
      }
    }

    const questionId = randomUUID()
    const toolCallId = ctx.currentToolCallId || 'unknown'

    // 通过 onUpdate 发送问题到客户端
    if (ctx.onUpdate) {
      ctx.onUpdate({
        details: {
          type: 'ask_user',
          questionId,
          questions: questionsRaw,
        },
      })
    }

    // 创建挂起的 Promise
    return new Promise<ToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup(questionId)
        reject(new Error('用户未在 120 秒内回答，问题已过期。'))
      }, ASK_USER_TIMEOUT_MS)

      questionMap.set(questionId, {
        resolve,
        reject,
        timer,
        toolCallId,
        conversationId: ctx.conversationId,
        questionId,
      })

      // 监听 abort 信号
      if (ctx.signal) {
        if (ctx.signal.aborted) {
          cleanup(questionId)
          reject(new Error('操作已取消。'))
          return
        }
        ctx.signal.addEventListener('abort', () => {
          cleanup(questionId)
          reject(new Error('操作已取消。'))
        }, { once: true })
      }
    })
  },
}