// ============================================================
// reducePinKey 回归测试 —— 登录页数字键盘的输入状态机
// ============================================================
//
// 登录页 PIN 键盘的输入逻辑以纯函数 reducePinKey 表达（hook 只是 React 包装），
// 因此这里不需要 DOM 环境即可锁定契约：长度上限、退格、清空，以及「值未变化时
// 不得触发 onChange」（登录页靠 onChange 清掉上一次的错误提示，多余的触发会让
// 用户输错后刚敲一位错误就消失）。

import { describe, it, expect } from 'vitest'
import { PIN_MIN, PIN_MAX, reducePinKey, type PinKeypadKey } from '../../web/src/hooks/usePinKeypad'

/** 把一串按键依序喂给 reducer */
const run = (keys: PinKeypadKey[], maxLength = PIN_MAX) => keys.reduce((v, k) => reducePinKey(v, k, maxLength), '')
const digit = (d: string): PinKeypadKey => ({ kind: 'digit', digit: d })

describe('reducePinKey', () => {
  it('空输入保持不变', () => {
    expect(reducePinKey('', { kind: 'backspace' })).toBe('')
    expect(reducePinKey('', { kind: 'clear' })).toBe('')
  })

  it('依次追加数字', () => {
    expect(run([digit('1'), digit('2'), digit('3')])).toBe('123')
  })

  it('达到 maxLength 后拒绝追加', () => {
    const full = run(Array.from({ length: PIN_MAX }, (_, i) => digit(String(i % 10))))
    expect(full).toHaveLength(PIN_MAX)
    expect(reducePinKey(full, digit('9'))).toBe(full)
  })

  it('自定义 maxLength 生效', () => {
    expect(run([digit('1'), digit('2'), digit('3')], 2)).toBe('12')
  })

  it('backspace 删除最后一位', () => {
    expect(run([digit('1'), digit('2'), { kind: 'backspace' }])).toBe('1')
    expect(run([digit('1'), { kind: 'backspace' }, { kind: 'backspace' }])).toBe('')
  })

  it('clear 清空全部', () => {
    expect(run([digit('1'), digit('2'), digit('3'), { kind: 'clear' }])).toBe('')
  })

  it('值未变化时返回同一引用（供 onChange 判定是否真正变化）', () => {
    expect(reducePinKey('', { kind: 'backspace' })).toBe('')
    expect(reducePinKey('', { kind: 'clear' })).toBe('')
    const full = '12345678'
    expect(reducePinKey(full, digit('9'))).toBe(full)
  })

  it('PIN_MIN 与 PIN_MAX 为 4 / 8', () => {
    expect(PIN_MIN).toBe(4)
    expect(PIN_MAX).toBe(8)
  })
})
