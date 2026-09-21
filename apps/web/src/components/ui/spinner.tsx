import { cn } from '@/lib/utils'

/**
 * 圆环加载动画（ring spinner），颜色跟随 currentColor。
 * 用于行内嵌入或自定义容器；区域占位请统一使用 <Loading />。
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin',
        className,
      )}
    />
  )
}

/**
 * 懒加载 / 数据加载的统一占位：水平 + 垂直居中的圆环动画。
 *
 * - size：sm = 16px，md = 24px（默认），lg = 32px
 * - className 追加到容器上，用于撑开占位区域（如 flex-1、h-full、py-8），
 *   使圆环在 allotted 区域内水平 + 垂直居中
 */
export function Loading({
  className,
  size = 'md',
}: {
  className?: string
  size?: 'sm' | 'md' | 'lg'
}) {
  const ring = size === 'sm' ? 'h-4 w-4' : size === 'lg' ? 'h-8 w-8' : 'h-6 w-6'
  return (
    <div className={cn('flex items-center justify-center text-muted-foreground', className)}>
      <Spinner className={ring} />
    </div>
  )
}
