import { cn } from '../../lib/utils'

interface PinDotsProps {
  length: number
  /** 显示圆点数量（PIN_MAX） */
  maxLength: number
  /** 递增计数器：每次 PIN 输错 +1，触发一轮「变红 + 剧烈摇晃 + 淡回灰色」 */
  errorTick?: number
}

/**
 * iOS 锁屏样式的 PIN 指示：已输入位为实心点，其余为空心圆环。
 *
 * 输错时整排标记：
 * 1. 瞬间切成红色（第 0 帧即红，不做颜色插值）；
 * 2. 剧烈左右摇晃约 0.7s；
 * 3. 摇晃结束后在余下时间内渐变回原本的灰 / 前景色。
 *
 * 颜色变化与位移都写在同一个 `pin-shake` keyframes 里，动画结束后
 * `animation-fill-mode: both` 让元素停在「原本颜色」，无需 JavaScript 复位。
 * `errorTick` 只用于换 key 重启动画，保证连续输错也能反复播放。
 */
export function PinDots({ length, maxLength, errorTick = 0 }: PinDotsProps) {
  return (
    <div
      className="flex items-center justify-center gap-3"
      role="status"
      aria-live="polite"
      aria-label={`${length} / ${maxLength}`}
    >
      {Array.from({ length: maxLength }, (_, i) => {
        const filled = i < length
        return (
          <span
            key={`${i}-${errorTick}`}
            className={cn(
              'pin-dot h-3 w-3 rounded-full border',
              filled ? 'pin-dot--filled' : 'pin-dot--empty',
              errorTick > 0 && 'animate-pin-shake',
            )}
          />
        )
      })}
    </div>
  )
}