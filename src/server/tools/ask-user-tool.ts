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
      '当你在执行任务过程中需要用户补充信息、做出选择或确认某个决定时，调用此工具向用户提问。' +
      '调用后你会暂停执行，直到用户回答。用户可以：选择选项、自由填写文字、或跳过问题。' +
      '每个问题可以包含 2-4 个预设选项（支持单选/多选），也可以让用户自由输入。' +
      '请仅在确实需要用户输入时使用此工具，避免为无关紧要的小事打断用户。',
    input_schema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          items: { type: 'object' },
          description: '要问用户的问题列表。每个问题包含 header（短标签）、question（完整问题文本）、options（选项列表，2-4 个）、multiSelect（是否多选）。',
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