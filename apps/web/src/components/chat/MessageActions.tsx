import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Pencil, RotateCcw } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '../ui/context-menu'
import { useToast } from '../ui/toast'

interface MessageActionsProps {
  children: React.ReactNode
  /** 复制到剪贴板的消息正文 */
  text: string
  /** 编辑入口（用户消息走「截断 + 重发」，AI 消息只改历史内容） */
  onEdit?: () => void
  /** 用户消息：沿用既有的「强制重试」路线（回退 + 重发） */
  onForceRetry?: () => void
  /** 生成中：只允许复制，避免与流式状态互相踩踏 */
  disabled?: boolean
  /** 内联编辑中：完全抑制菜单（保留输入框的原生右键/选择行为） */
  suppressMenu?: boolean
}

/** 复制文本：优先 Clipboard API，失败时退回隐藏 textarea（钉钉 WebView 等） */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 继续走兜底 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    ta.style.top = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

const LONG_PRESS_MS = 480
const MOVE_TOLERANCE_PX = 10

/**
 * 消息气泡的右键 / 长按菜单。
 *
 * - 桌面端：Radix ContextMenu 原生响应右键
 * - 移动端：自己识别长按（480ms、位移 ≤10px），向触发区派发一次合成
 *   contextmenu 事件，复用 Radix 的定位与键盘可达性
 */
export function MessageActions({
  children,
  text,
  onEdit,
  onForceRetry,
  disabled,
  suppressMenu,
}: MessageActionsProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const originRef = useRef<{ x: number; y: number } | null>(null)
  /** 长按触发时刻（0 = 未触发）。抬起后浏览器补发的 click 只在时间窗内拦截，
   *  避免布尔标记残留导致下一次正常点击被吞。 */
  const longPressAtRef = useRef(0)

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    originRef.current = null
  }

  const restoreSelection = () => {
    const el = wrapperRef.current
    if (!el) return
    el.style.userSelect = ''
    ;(el.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = ''
  }

  useEffect(() => () => {
    clearTimer()
    restoreSelection()
  }, [])

  const handlePointerDown = (e: React.PointerEvent) => {
    if (suppressMenu) return
    if (e.pointerType === 'mouse') return // 桌面端交给原生右键
    if (e.button !== 0) return
    clearTimer()
    longPressAtRef.current = 0
    originRef.current = { x: e.clientX, y: e.clientY }
    // 长按期间禁止选中文本 / 弹出系统 callout，避免与菜单抢焦点
    const el = wrapperRef.current
    if (el) {
      el.style.userSelect = 'none'
      ;(el.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = 'none'
    }
    timerRef.current = setTimeout(() => {
      const origin = originRef.current
      if (!origin) return
      longPressAtRef.current = Date.now()
      try {
        navigator.vibrate?.(12)
      } catch {
        /* 无振动硬件 */
      }
      wrapperRef.current?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: origin.x,
          clientY: origin.y,
          button: 2,
          buttons: 2,
        }),
      )
      // 菜单已打开：立即恢复选择能力，避免指针在菜单上抬起导致包装层
      // 收不到 pointerup、user-select:none 残留
      restoreSelection()
      timerRef.current = null
    }, LONG_PRESS_MS)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!originRef.current) return
    if (
      Math.abs(e.clientX - originRef.current.x) > MOVE_TOLERANCE_PX ||
      Math.abs(e.clientY - originRef.current.y) > MOVE_TOLERANCE_PX
    ) {
      clearTimer()
      restoreSelection()
    }
  }

  const handlePointerEnd = () => {
    clearTimer()
    restoreSelection()
  }

  const handleClickCapture = (e: React.MouseEvent) => {
    if (!longPressAtRef.current) return
    if (Date.now() - longPressAtRef.current > 1000) {
      longPressAtRef.current = 0
      return
    }
    // 长按抬起后浏览器仍可能补发一次 click：拦掉，避免误触气泡里的按钮
    longPressAtRef.current = 0
    e.preventDefault()
    e.stopPropagation()
  }

  const handleCopy = async () => {
    if (!text) return
    const ok = await copyToClipboard(text)
    toast(
      ok
        ? { title: t('chat.copied'), variant: 'success' }
        : { title: t('chat.copyFailed'), variant: 'error' },
    )
  }

  // 「强制重试对方」不提供：AI 消息用编辑即可改写历史（见 D69 最终方案）
  return (
    <ContextMenu onOpenChange={(open) => { if (!open) longPressAtRef.current = 0 }}>
      <ContextMenuTrigger asChild disabled={suppressMenu}>
        <div
          ref={wrapperRef}
          className="w-full [-webkit-touch-callout:none]"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onPointerLeave={handlePointerEnd}
          onClickCapture={handleClickCapture}
        >
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!text.trim()} onSelect={() => void handleCopy()}>
          <Copy className="h-3.5 w-3.5" />
          {t('chat.copy')}
        </ContextMenuItem>
        {onEdit && (
          <ContextMenuItem disabled={disabled} onSelect={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
            {t('chat.editMessage')}
          </ContextMenuItem>
        )}
        {onForceRetry && (
          <ContextMenuItem disabled={disabled} destructive onSelect={onForceRetry}>
            <RotateCcw className="h-3.5 w-3.5" />
            {t('chat.forceRetry')}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
