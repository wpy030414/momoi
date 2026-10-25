import { describe, it, expect } from 'vitest'
import { rewriteTraceForEditedContent } from '../src/lib/message-edit.js'

describe('rewriteTraceForEditedContent', () => {
  it('保留思考 / 工具 / 卡片，去掉全部旧正文并在末尾追加新正文', () => {
    const trace = [
      { type: 'thinking', text: '先想一下' },
      { type: 'text', text: '旧正文一' },
      { type: 'tool_call', id: 't1', name: 'search', input: {} },
      { type: 'text', text: '旧正文二' },
      { type: 'card', id: 't1', card: { component: 'stat', props: {} } },
    ]
    const result = JSON.parse(rewriteTraceForEditedContent(JSON.stringify(trace), '新正文')!)
    expect(result.map((e: any) => e.type)).toEqual(['thinking', 'tool_call', 'card', 'text'])
    expect(result.at(-1)).toEqual({ type: 'text', text: '新正文' })
  })

  it('没有 trace 的 legacy 消息保持 null（content 直接渲染）', () => {
    expect(rewriteTraceForEditedContent(null, '新正文')).toBeNull()
    expect(rewriteTraceForEditedContent(undefined, '新正文')).toBeNull()
  })

  it('损坏的 trace 退化为只含新正文的单条目', () => {
    const result = JSON.parse(rewriteTraceForEditedContent('{not json', '新正文')!)
    expect(result).toEqual([{ type: 'text', text: '新正文' }])
  })

  it('非数组 trace 不覆盖（返回 null）', () => {
    expect(rewriteTraceForEditedContent(JSON.stringify({ foo: 1 }), '新正文')).toBeNull()
  })
})
