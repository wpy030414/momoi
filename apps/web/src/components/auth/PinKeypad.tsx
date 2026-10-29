import { Delete } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'

interface PinKeypadProps {
  onDigit: (digit: string) => void
  onBackspace: () => void
  /** 返回上一步（对应键盘左下角）；缺省时该键留空占位 */
  onExtra?: () => void
  extraLabel?: string
  /** 右下角显示「删除」还是「提交」 */
  showSubmit: boolean
  submitLabel: string
  onSubmit: () => void
  disabled?: boolean
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

/**
 * iOS 锁屏样式的 3×4 拨号键盘。
 *
 * 交互设计要点：
 * - 数字 1-9 / 0 固定在 3×4 网格上，触屏时手指不必重新定位；
 * - 左下角是「返回」，与 iOS 锁屏的「取消」同位；
 * - 右下角在输入未满足长度前是「删除」，满足后切换为「提交」——每次按键只做一件事；
 * - 全部使用 button，天然获得 Tab 焦点与 Enter/Space 激活。
 */
export function PinKeypad({
  onDigit,
  onBackspace,
  onExtra,
  extraLabel,
  showSubmit,
  submitLabel,
  onSubmit,
  disabled,
}: PinKeypadProps) {
  const { t } = useTranslation()

  const keyClass =
    'flex h-16 w-full max-w-[72px] select-none items-center justify-center rounded-full text-2xl font-light tabular-nums transition active:bg-accent/60 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50'

  return (
    <div className="grid grid-cols-3 justify-items-center gap-y-3" role="group" aria-label={t('login.keypad')}>
      {KEYS.map((k) => (
        <button key={k} type="button" className={keyClass} onClick={() => onDigit(k)} disabled={disabled}>
          {k}
        </button>
      ))}

      {/* 左下：返回 / 占位 */}
      <button
        type="button"
        className={cn(keyClass, 'text-sm font-normal text-muted-foreground')}
        onClick={onExtra}
        disabled={disabled || !onExtra}
        aria-hidden={onExtra ? undefined : true}
        tabIndex={onExtra ? undefined : -1}
        aria-label={extraLabel ?? t('login.back')}
      >
        {onExtra ? (extraLabel ?? t('login.back')) : ' '}
      </button>

      {/* 中下：0 */}
      <button type="button" className={keyClass} onClick={() => onDigit('0')} disabled={disabled}>
        0
      </button>

      {/* 右下：删除 ⇄ 提交 */}
      {showSubmit ? (
        <button
          type="button"
          className={cn(keyClass, 'bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90')}
          onClick={onSubmit}
          disabled={disabled}
        >
          {submitLabel}
        </button>
      ) : (
        <button
          type="button"
          className={cn(keyClass, 'text-muted-foreground')}
          onClick={onBackspace}
          disabled={disabled}
          aria-label={t('login.backspace')}
        >
          <Delete className="h-6 w-6" aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
