// ============================================================
// Momoi — Thinking 分段编解码
// 多轮思考链在 DB 以「含分隔符的纯文本」存储；
// 前端按 THINKING_SEGMENT 分隔符解析成结构化分段渲染。
// 服务端 loop.ts 与客户端 useChat / ThinkingBlock 共用这里。
// ============================================================

import { THINKING_SEGMENT_OPEN, THINKING_SEGMENT_CLOSE, THINKING_TRUNCATED_MARK } from './constants'

export interface ThinkingSegment {
  round: number
  text: string
}

/** 生成形如「〔思考片段 N〕」的分隔符文本（N 从 1 起）。 */
export function thinkingSegmentHeader(round: number): string {
  return THINKING_SEGMENT_OPEN + (round + 1) + THINKING_SEGMENT_CLOSE
}

/** 把分段数组编码成含分隔符的纯文本（供 DB 持久化，与 server loop 同格式）。 */
export function encodeThinkingSegments(segments: ThinkingSegment[]): string {
  return segments.map((s) => thinkingSegmentHeader(s.round) + s.text).join('')
}

/**
 * 把含分隔符的纯文本按轮切分成结构化分段。
 * 兼容两种输入：
 *  - 新格式：形如 〔思考片段 1〕...〔思考片段 2〕...
 *  - 历史纯文本：无分隔符 → 当作单段 { round: 0, text }
 */
export function decodeThinkingToSegments(text?: string | null): ThinkingSegment[] {
  if (!text) return []
  const headerRe = new RegExp(THINKING_SEGMENT_OPEN + '(\\d+)' + THINKING_SEGMENT_CLOSE, 'g')
  // 收集所有分隔符位置 [index, round]
  const markers: Array<{ index: number; round: number }> = []
  let m: RegExpExecArray | null
  while ((m = headerRe.exec(text)) !== null) {
    markers.push({ index: m.index, round: parseInt(m[1], 10) - 1 })
  }
  if (markers.length === 0) {
    return text.trim() ? [{ round: 0, text }] : []
  }
  const segments: ThinkingSegment[] = []
  // 第一个分隔符之前的残段归入 round 0
  if (markers[0].index > 0 && text.slice(0, markers[0].index).trim()) {
    segments.push({ round: 0, text: text.slice(0, markers[0].index) })
  }
  for (let i = 0; i < markers.length; i++) {
    const header = thinkingSegmentHeader(markers[i].round)
    const start = markers[i].index + header.length
    const end = i + 1 < markers.length ? markers[i + 1].index : text.length
    const body = text.slice(start, end)
    if (body.trim()) segments.push({ round: markers[i].round, text: body })
  }
  return segments
}

/** 是否含「思考被截断」标记（translate end marker）。 */
export function isThinkingTruncated(text: string): boolean {
  return text.includes(THINKING_TRUNCATED_MARK)
}