// ============================================================
// GodActionBar — 上帝行动输入条
// ============================================================
// 用户以「上帝」身份写下一步做什么，提交后跑一个回合：所有存活 Agent 依次行动一拍。
// 回合进行中输入禁用 —— 一个世界同时只允许一个回合（服务端也有同款守卫）。

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/button'
import { Send, Loader2 } from 'lucide-react'
import { WORLD_LIMITS } from '@momoi/shared/world'

interface GodActionBarProps {
  disabled: boolean
  acting: boolean
  onSubmit: (content: string) => void
}

export function GodActionBar({ disabled, acting, onSubmit }: GodActionBarProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  // 自适应高度：随内容长高，但设上限，避免输入框吃掉整个沙盘
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`
  }, [value])

  const canSubmit = value.trim().length > 0 && !disabled && !acting

  const submit = () => {
    const text = value.trim()
    if (!text || disabled || acting) return
    setValue('')
    onSubmit(text)
  }

  return (
    <div className="border-t bg-card/60 backdrop-blur px-3 py-2 shrink-0">
      <div className="flex items-end gap-2 max-w-3xl mx-auto">
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => setValue(e.target.value.slice(0, WORLD_LIMITS.maxGodActionLength))}
          onKeyDown={(e) => {
            // Enter 提交、Shift+Enter 换行 —— 与聊天输入框一致的手感
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          rows={1}
          disabled={disabled || acting}
          placeholder={t('world.actionPlaceholder')}
          className="flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
        <Button size="icon" className="h-9 w-9 shrink-0" disabled={!canSubmit} onClick={submit}>
          {acting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  )
}
