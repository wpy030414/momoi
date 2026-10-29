import { useCallback, useRef, useState } from 'react'

export const PIN_MIN = 4
export const PIN_MAX = 8

interface UsePinKeypadOptions {
  maxLength?: number
  /** 每次新输入后被调用（用于清空上一次的错误提示） */
  onChange?: () => void
}

/**
 * PIN 数字键盘的状态机：维护已输入的数字串、处理按键与物理键盘输入。
 *
 * 只负责「输入什么」，不负责「何时提交」——是否达到 PIN_MIN 由提交方判断，
 * 因为设置流程要求输入长度落在 4-8 且两次一致，验证流程只需 >= PIN_MIN。
 */
export function usePinKeypad({ maxLength = PIN_MAX, onChange }: UsePinKeypadOptions = {}) {
  const [value, setValue] = useState('')
  // 用 ref 持有最新回调，避免它变化时重建所有按键回调
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  /** 唯一的写入入口：值真正变化时才通知 onChange */
  const dispatch = useCallback(
    (key: PinKeypadKey) => {
      setValue((prev) => {
        const next = reducePinKey(prev, key, maxLength)
        if (next !== prev) onChangeRef.current?.()
        return next
      })
    },
    [maxLength],
  )

  const append = useCallback((digit: string) => dispatch({ kind: 'digit', digit }), [dispatch])
  const backspace = useCallback(() => dispatch({ kind: 'backspace' }), [dispatch])
  const clear = useCallback(() => dispatch({ kind: 'clear' }), [dispatch])

  /** 物理键盘：数字键直接输入，Backspace 退格，Escape 清空 */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault()
        dispatch({ kind: 'digit', digit: e.key })
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        dispatch({ kind: 'backspace' })
      } else if (e.key === 'Escape') {
        e.preventDefault()
        dispatch({ kind: 'clear' })
      }
    },
    [dispatch],
  )

  return { value, length: value.length, atMax: value.length >= maxLength, append, backspace, clear, handleKeyDown }
}

/** 一次 PIN 输入事件——键盘按钮与物理键盘都归约到这里，状态迁移因此可被单独测试 */
export type PinKeypadKey =
  | { kind: 'digit'; digit: string }
  | { kind: 'backspace' }
  | { kind: 'clear' }

/** 纯函数形式的状态迁移：hook 的行为契约，测试直接锁它而不需要 DOM */
export function reducePinKey(prev: string, key: PinKeypadKey, maxLength = PIN_MAX): string {
  switch (key.kind) {
    case 'digit':
      return prev.length >= maxLength ? prev : prev + key.digit
    case 'backspace':
      return prev.slice(0, -1)
    case 'clear':
      return ''
  }
}
