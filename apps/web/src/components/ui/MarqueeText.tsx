import { useRef, useCallback, useEffect } from 'react'

/**
 * 文本溢出处理：默认严格限长、溢出省略；光标悬停且确实溢出时循环滚动展示全文——
 * 悬停即以每秒 2 个中文字符的速度匀速滚到末尾，停 3 秒，瞬间回到开头再停 1 秒，循环。
 *
 * 省略号必须画在内层自身的文本上（Chromium 的 text-overflow 不作用于不限宽的
 * inline-block 原子盒溢出），故内层 idle 时 max-w-full + ellipsis，悬停测量/滚动时
 * 才放开 max-width。滚动距离/时长按实测溢出量计算，用 WAAPI 驱动（各段占比随
 * 距离变化，CSS 关键帧无法参数化）。
 */
export function MarqueeText({ text }: { text: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLSpanElement>(null)
  const animRef = useRef<Animation | null>(null)

  const stopMarquee = useCallback(() => {
    animRef.current?.cancel()
    animRef.current = null
    if (innerRef.current) innerRef.current.style.maxWidth = ''
  }, [])

  const startMarquee = useCallback(() => {
    const container = containerRef.current
    const inner = innerRef.current
    if (!container || !inner) return
    inner.style.maxWidth = 'none'
    const dist = inner.offsetWidth - container.clientWidth
    if (dist <= 1) {
      inner.style.maxWidth = ''
      return
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      inner.style.maxWidth = ''
      return
    }
    const speed = 2 * parseFloat(getComputedStyle(inner).fontSize)
    const travelMs = (dist / speed) * 1000
    const endHoldMs = 3000
    const startHoldMs = 1000
    const totalMs = travelMs + endHoldMs + startHoldMs
    animRef.current = inner.animate(
      [
        { transform: 'translateX(0)' },
        { transform: `translateX(${-dist}px)`, offset: travelMs / totalMs },
        { transform: `translateX(${-dist}px)`, offset: (travelMs + endHoldMs) / totalMs },
        { transform: 'translateX(0)', offset: (travelMs + endHoldMs) / totalMs },
        { transform: 'translateX(0)' },
      ],
      { duration: totalMs, easing: 'linear', iterations: Infinity },
    )
  }, [])

  useEffect(() => stopMarquee, [stopMarquee])

  return (
    <div
      ref={containerRef}
      className="flex-1 min-w-0 overflow-hidden whitespace-nowrap text-sm"
      onMouseEnter={startMarquee}
      onMouseLeave={stopMarquee}
    >
      <span ref={innerRef} className="inline-block align-top max-w-full overflow-hidden text-ellipsis">{text}</span>
    </div>
  )
}
