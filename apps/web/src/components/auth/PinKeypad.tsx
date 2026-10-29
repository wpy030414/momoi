import { Delete, ArrowLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'

interface PinKeypadProps {
  onDigit: (digit: string) => void
  onBackspace: () => void
  /** 无输入时左下角的行为：返回上一步 */
  onBack?: () => void
  backLabel?: string
  /** 是否有可删除的输入——决定左下角显示「删除」还是「返回」 */
  hasInput: boolean
  /** 提交键是否可用——少于 PIN_MIN 位时为禁用态 */
  canSubmit: boolean
  submitLabel: string
  onSubmit: () => void
  disabled?: boolean
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

/**
 * iOS 锁屏样式的 3×4 拨号键盘。
 *
 * 布局：3 列 × 4 行等宽等高的网格，每个按键占据相同的格子（`aspect-square` +
 * `place-items-center`），因此行距与列距天然一致，不随文字长度变化。
 *
 * 按键语义：
 * - 数字 1-9 / 0 固定在网格上，触屏时手指不必重新定位；
 * - 左下角「返回 / 删除」合一：有输入时退格一位，无输入时回到上一步；
 * - 右下角「提交」，位数不足 PIN_MIN 时为禁用态；
 * - 全部使用 button，天然获得 Tab 焦点与 Enter/Space 激活。
 */
export function PinKeypad({
  onDigit,
  onBackspace,
  onBack,
  backLabel,
  hasInput,
  canSubmit,
  submitLabel,
  onSubmit,
  disabled,
}: PinKeypadProps) {
  const { t } = useTranslation()

  // 单元格等分：外层网格三列等宽，内层按键撑满单元格并保持正方形
  const cell = 'flex aspect-square w-full items-center justify-center'
  const key = cn(
    cell,
    'rounded-full text-2xl font-light tabular-nums',
    'transition-colors duration-150 active:bg-accent/60',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'disabled:text-muted-foreground/50 disabled:active:bg-transparent',
  )

  return (
    <div
      className="mx-auto grid w-full max-w-[320px] auto-rows-fr grid-cols-3 grid-rows-4 gap-4"
      role="group"
      aria-label={t('login.keypad')}
    >
      {KEYS.map((k) => (
        <button key={k} type="button" className={key} onClick={() => onDigit(k)} disabled={disabled}>
          {k}
        </button>
      ))}

      {/* 左下：有输入时退格，无输入时返回 */}
      {hasInput ? (
        <button
          type="button"
          className={cn(key, 'text-muted-foreground')}
          onClick={onBackspace}
          disabled={disabled}
          aria-label={t('login.backspace')}
        >
          <Delete className="h-6 w-6" aria-hidden="true" />
        </button>
      ) : (
        <button
          type="button"
          className={cn(key, 'text-muted-foreground')}
          onClick={onBack}
          disabled={disabled || !onBack}
          aria-label={backLabel ?? t('login.back')}
        >
          <ArrowLeft className="h-6 w-6" aria-hidden="true" />
        </button>
      )}

      {/* 中下：0 */}
      <button type="button" className={key} onClick={() => onDigit('0')} disabled={disabled}>
        0
      </button>

      {/* 右下：提交（位数不足时禁用） */}
      <button
        type="button"
        className={cn(key, 'bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90')}
        onClick={onSubmit}
        disabled={disabled || !canSubmit}
      >
        {submitLabel}
      </button>
    </div>
  )
}