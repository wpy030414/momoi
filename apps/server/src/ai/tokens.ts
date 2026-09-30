// 字符级 token 估算：上游不回 usage（多数 OpenAI 兼容网关在流式响应中不携带）
// 时，会话状态条的 contextTokens / 累计消耗 / tok/s 退化为此估算。
// 依据 o200k/cl100k 对中英混排的经验值：
//   - CJK（含全角标点）≈ 0.6 token/字（常用汉字 1 token、次常用 2 token 的折中）
//   - 其余（拉丁字母/数字/符号/空白）≈ 1 token / 4 chars
// 估算参与的快照一律带 ≈ 标记上 wire（ConversationStats.estimated / totalEstimated），
// 与真值区分。

import type { ContentPart } from './provider.js'

const CJK_RE = /[⺀-鿿豈-﫿＀-￯]/g

export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = text.match(CJK_RE)?.length ?? 0
  const rest = text.length - cjk
  return Math.round(cjk * 0.6 + rest / 4)
}

/** 多段文本聚合估算（system prompt + 各消息正文 + 工具调用 JSON 等） */
export function estimateTokensOfParts(parts: Array<string | null | undefined>): number {
  let total = 0
  for (const p of parts) total += estimateTokens(p || '')
  return total
}

/** 图片按 ≈800 token/张 折算（用 1300 个 CJK 字符占位，0.6 tok/字）。 */
const IMAGE_PLACEHOLDER = '图'.repeat(1300)

/** 消息内容 → 可估算文本段：字符串直取；多模态把图片折成占位符。
 *  各调用点共用同一份折算规则，避免真值与估算的口径在模块间走样。 */
export function contentToEstimateParts(content: string | ContentPart[] | null | undefined, parts: string[]): void {
  if (typeof content === 'string') {
    parts.push(content)
  } else if (Array.isArray(content)) {
    for (const c of content) {
      if (c.type === 'text') parts.push(c.text)
      else parts.push(IMAGE_PLACEHOLDER)
    }
  }
}
