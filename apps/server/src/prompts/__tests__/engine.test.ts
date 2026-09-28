// ============================================================
// PromptEngine 单元测试
// ============================================================

import { describe, it, expect } from 'vitest'
import { PromptEngine } from '../engine.js'
import type { PromptFragment } from '../types.js'

function frag(over: Partial<PromptFragment<any>> & { id: string }): PromptFragment<any> {
  return {
    targets: 'demo',
    layer: 'body',
    description: `${over.id} 的用途说明`,
    render: () => over.id,
    ...over,
  }
}

describe('注册表：找得到 / 管得动', () => {
  it('list() 返回元信息，可按目标过滤', () => {
    const e = new PromptEngine()
    e.registerAll([
      frag({ id: 'a', targets: 'demo' }),
      frag({ id: 'b', targets: 'other', when: () => true }),
    ])
    const all = e.list()
    expect(all.map((f) => f.id)).toEqual(['a', 'b'])
    expect(all[0]).toMatchObject({ conditional: false, disabled: false, source: 'builtin' })
    expect(all[1].conditional).toBe(true)
    expect(e.list({ target: 'demo' }).map((f) => f.id)).toEqual(['a'])
  })

  it('重复注册同 id = 原位覆盖，不改变排序位置', () => {
    const e = new PromptEngine()
      .defineTarget('demo', { layers: ['body'] })
      .register(frag({ id: 'first' }))
      .register(frag({ id: 'second' }))
      .register(frag({ id: 'first', render: () => '覆盖后' }))
    const { text, parts } = e.assemble('demo', {})
    expect(parts.map((p) => p.id)).toEqual(['first', 'second'])
    expect(text).toBe('覆盖后\n\nsecond')
    expect(e.list()).toHaveLength(2)
  })

  it('override 生效且只有显式给出的字段被替换；缺失 id 返回 false', () => {
    const e = new PromptEngine()
    const original = () => '原文本'
    e.register(frag({ id: 'x', render: original, when: () => true }))
    expect(e.override('x', { render: () => '新文本' })).toBe(true)
    expect(e.render('x')).toBe('新文本')
    // 未显式给出 when：条件函数保留（此处仍为真）
    expect(e.assemble('demo', {}).parts).toHaveLength(1)
    expect(e.override('missing', { render: () => 'x' })).toBe(false)
    // override 默认打上来源标记
    expect(e.list()[0].source).toBe('override')
  })

  it('disable/enable：仍在注册表（找得到）但不参与组装', () => {
    const e = new PromptEngine().defineTarget('demo', { layers: ['body'] }).register(frag({ id: 'x' }))
    expect(e.disable('x')).toBe(true)
    expect(e.assemble('demo', {}).text).toBe('')
    expect(e.list().map((f) => f.id)).toEqual(['x'])
    expect(e.list()[0].disabled).toBe(true)
    expect(e.render('x')).toBeNull()
    e.enable('x')
    expect(e.assemble('demo', {}).text).toBe('x')
  })

  it('unregister 移除片段', () => {
    const e = new PromptEngine().register(frag({ id: 'x' }))
    expect(e.unregister('x')).toBe(true)
    expect(e.unregister('x')).toBe(false)
    expect(e.list()).toHaveLength(0)
  })

  it('注册非法片段（无 render / 无 targets）直接报错', () => {
    const e = new PromptEngine()
    expect(() => e.register({ id: 'bad', targets: 'demo', layer: 'body', description: '', render: null as any })).toThrow()
    expect(() => e.register({ id: 'bad2', targets: '' as any, layer: 'body', description: '', render: () => '' })).toThrow()
  })
})

describe('组装：层 / 优先级 / 条件 / 拼接', () => {
  it('层顺序决定先后，priority 大者靠前，同优先级按注册顺序', () => {
    const e = new PromptEngine()
      .defineTarget('demo', { layers: ['head', 'body', 'tail'] })
      .register(frag({ id: 'b1', layer: 'body', priority: 0 }))
      .register(frag({ id: 't1', layer: 'tail' }))
      .register(frag({ id: 'h1', layer: 'head' }))
      .register(frag({ id: 'b2', layer: 'body', priority: 10 }))
    expect(e.assemble('demo', {}).parts.map((p) => p.id)).toEqual(['h1', 'b2', 'b1', 't1'])
  })

  it('配方未声明的层排在已知层之后，按层首次出现的先后兜底', () => {
    const e = new PromptEngine()
      .defineTarget('demo', { layers: ['head'] })
      .register(frag({ id: 'x1', layer: 'zeta' }))
      .register(frag({ id: 'h', layer: 'head' }))
      .register(frag({ id: 'x2', layer: 'alpha' }))
    expect(e.assemble('demo', {}).parts.map((p) => p.id)).toEqual(['h', 'x1', 'x2'])
  })

  it('when=false 与空产出（null/空串）都不参与', () => {
    const e = new PromptEngine()
      .defineTarget('demo', { layers: ['body'] })
      .register(frag({ id: 'a' }))
      .register(frag({ id: 'b', when: () => false }))
      .register(frag({ id: 'c', render: () => null }))
      .register(frag({ id: 'd', render: () => '   ' }))
    expect(e.assemble('demo', {}).text).toBe('a')
  })

  it('块首尾空白被裁剪，内部换行保留', () => {
    const e = new PromptEngine()
      .defineTarget('demo', { layers: ['body'] })
      .register(frag({ id: 'a', render: () => '\n\n第一行\n第二行\n\n' }))
    expect(e.assemble('demo', {}).text).toBe('第一行\n第二行')
  })

  it('separator 可用配方定义或调用时覆盖', () => {
    const e = new PromptEngine()
      .defineTarget('demo', { layers: ['body'], separator: '\n' })
      .register(frag({ id: 'a' }))
      .register(frag({ id: 'b' }))
    expect(e.assemble('demo', {}).text).toBe('a\nb')
    expect(e.assemble('demo', {}, { separator: ' | ' }).text).toBe('a | b')
  })

  it('未定义配方也能组装（按注册顺序兜底）', () => {
    const e = new PromptEngine().register(frag({ id: 'a' })).register(frag({ id: 'b' }))
    expect(e.assemble('demo', {}).text).toBe('a\n\nb')
    expect(e.assemble('未注册的目标', {}).text).toBe('')
  })

  it('临时片段参与层/优先级排序，来源标记为 runtime', () => {
    const e = new PromptEngine()
      .defineTarget('demo', { layers: ['head', 'body'] })
      .register(frag({ id: 'h', layer: 'head' }))
      .register(frag({ id: 't', layer: 'body' }))
    const { parts } = e.assemble('demo', {}, {
      fragments: [frag({ id: '数据', layer: 'body', priority: 5, render: () => '运行时数据' })],
    })
    expect(parts.map((p) => p.id)).toEqual(['h', '数据', 't'])
    expect(parts[1].source).toBe('runtime')
    // 临时片段不进入注册表
    expect(e.list().map((f) => f.id)).toEqual(['h', 't'])
  })

  it('targets: "*" 命中所有配方（全局规则）', () => {
    const e = new PromptEngine()
      .defineTarget('demo', { layers: ['body'] })
      .defineTarget('other', { layers: ['body'] })
      .register(frag({ id: 'global', targets: '*' }))
      .register(frag({ id: 'only-demo', targets: 'demo' }))
    expect(e.assemble('other', {}).text).toBe('global')
    expect(e.assemble('demo', {}).parts.map((p) => p.id)).toEqual(['global', 'only-demo'])
  })

  it('单个片段抛错只跳过自身（容错），不影响其他片段', () => {
    const e = new PromptEngine()
      .defineTarget('demo', { layers: ['body'] })
      .register(frag({ id: 'ok1' }))
      .register(frag({ id: 'boom-when', when: () => { throw new Error('when 炸了') } }))
      .register(frag({ id: 'boom-render', render: () => { throw new Error('render 炸了') } }))
      .register(frag({ id: 'ok2' }))
    expect(e.assemble('demo', {}).text).toBe('ok1\n\nok2')
  })

  it('parts 逐段溯源：id / layer / priority / description / source / content', () => {
    const e = new PromptEngine()
      .defineTarget('demo', { layers: ['body'] })
      .register(frag({ id: 'x', layer: 'body', priority: 3, source: 'skill:demo-skill', render: () => '内容' }))
    const { parts } = e.assemble('demo', {})
    expect(parts).toEqual([
      { id: 'x', layer: 'body', priority: 3, description: 'x 的用途说明', source: 'skill:demo-skill', content: '内容' },
    ])
  })

  it('render(id) 按名渲染单片段（工具描述 / 兜底人设等场景）', () => {
    const e = new PromptEngine().register(frag({ id: 'x', render: (ctx: { v: string }) => ctx.v }))
    expect(e.render('x', { v: '嗨' })).toBe('嗨')
    expect(e.render('不存在')).toBeNull()
  })

  it('defineTarget 可列出配方清单（层顺序 / 连接符 / 片段数）', () => {
    const e = new PromptEngine()
      .defineTarget('demo', { layers: ['head', 'body'], description: '演示配方' })
      .register(frag({ id: 'h', layer: 'head' }))
      .register(frag({ id: 'b', layer: 'body' }))
      .register(frag({ id: 'other', targets: 'elsewhere' }))
    expect(e.listTargets()).toEqual([
      { target: 'demo', description: '演示配方', layers: ['head', 'body'], separator: '\n\n', fragmentCount: 2 },
    ])
    expect(e.hasTarget('demo')).toBe(true)
  })
})
