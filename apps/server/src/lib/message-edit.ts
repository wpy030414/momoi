/**
 * 消息编辑的纯函数助手（可单测）。
 *
 * AI 消息编辑只改 `content` 与 trace 里的正文分片：思考 / 工具 / 卡片保留，
 * 末尾追加一份新文本，保证刷新后时间线仍按发生顺序渲染。
 */

import type { TraceEntry } from '@momoi/shared/types'

/**
 * 重写 trace：去掉所有旧正文分片，保留非正文条目，并在末尾追加新正文。
 * 原 trace 不存在 → 返回 null（legacy 消息由 content 直接渲染）。
 * 原 trace 损坏 → 退化为只含新正文的单条目 trace。
 */
export function rewriteTraceForEditedContent(traceJson: string | null | undefined, content: string): string | null {
  if (!traceJson) return null
  try {
    const parsed = JSON.parse(traceJson)
    if (!Array.isArray(parsed)) return null
    const kept: TraceEntry[] = (parsed as TraceEntry[]).filter((e) => e?.type !== 'text' && e && typeof e === 'object')
    kept.push({ type: 'text', text: content })
    return JSON.stringify(kept)
  } catch {
    return JSON.stringify([{ type: 'text', text: content }])
  }
}
