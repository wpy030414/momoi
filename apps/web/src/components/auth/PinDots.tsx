import { useEffect, useRef } from 'react'
import { cn } from '../../lib/utils'

interface PinDotsProps {
  length: number
  /** 显示圆点数量（PIN_MAX） */
  maxLength: number
  /** 递增计数器：每次 +1 触发一轮「变红 + 剧烈摇晃 → 渐变回灰」 */
  errorTick?: number
  /** 动画结束（或兜底超时）后回调；由调用方负责清空输入并复位 errorTick */
  onErrorAnimEnd?: () => void
}

/** 与 tailwind.config.js 中 animate-pin-shake 的时长保持一致 */
const SHAKE_MS = 1100

/**
 * iOS 锁屏样式的 PIN 指示。
 *
 * 输错时（`errorTick` 递增）：
 * 1. 所有圆点**瞬间**变红（即使长度为 0 也铺满整排红色，让「错」本身可见）；
 * 2. `pin-shake` 动画驱动剧烈左右摇晃，颜色在动画后段渐变回常规色；
 * 3. 动画结束后回调 `onErrorAnimEnd`，调用方此时才清空输入。
 *
 * 为什么不在 catch 里直接 clear：清空会让圆点立刻失去填充，动画刚起第一帧就
 * 没东西可看。改为「先播完动画，再清空」。
 *
 * 兜底：若 `animationend` 因标签页隐藏、`prefers-reduced-motion` 或元素被重挂
 * 而错过，计时器保证 `onErrorAnimEnd` 仍会被调用，不会卡在错误态。
 */
export function PinDots({ length, maxLength, errorTick = 0, onErrorAnimEnd }: PinDotsProps) {
  const endRef = useRef(onErrorAnimEnd)
  endRef.current = onErrorAnimEnd
  const firedRef = useRef(0)

  useEffect(() => {
    if (!errorTick) return
    const id = window.setTimeout(() => {
      if (firedRef.current === errorTick) return
      firedRef.current = errorTick
      endRef.current?.()
    }, SHAKE_MS + 100)
    return () => window.clearTimeout(id)
  }, [errorTick])

  // 出错时整排都点亮为红点（即使尚未输入任何位）
  const shown = errorTick > 0 ? maxLength : length

  return (
    <div
      className="flex items-center justify-center gap-3"
      role="status"
      aria-live="polite"
      aria-label={`${length} / ${maxLength}`}
    >
      {Array.from({ length: maxLength }, (_, i) => {
        const filled = i < shown
        return (
          <span
            key={`${i}-${errorTick}`}
            className={cn(
              'pin-dot h-3 w-3 rounded-full border',
              filled ? 'pin-dot--filled' : 'pin-dot--empty',
              errorTick > 0 && 'animate-pin-shake',
            )}
            onAnimationEnd={() => {
              // 只让最后一个圆点的结束事件生效，避免 8 次重复回调
              if (i !== maxLength - 1) return
              if (firedRef.current === errorTick) return
              firedRef.current = errorTick
              endRef.current?.()
            }}
          />
        )
      })}
    </div>
  )
}