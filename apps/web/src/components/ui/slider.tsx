import * as React from 'react'
import { cn } from '../../lib/utils'

interface SliderProps {
  className?: string
  min?: number
  max?: number
  step?: number
  value?: number
  defaultValue?: number
  onValueChange?: (value: number) => void
  disabled?: boolean
}

const Slider = React.forwardRef<HTMLDivElement, SliderProps>(
  ({ className, min = 0, max = 100, step = 1, value, defaultValue, onValueChange, disabled, ...props }, ref) => {
    const [internalValue, setInternalValue] = React.useState(defaultValue ?? min)
    const isControlled = value !== undefined
    const currentValue = isControlled ? value : internalValue

    const percentage = ((currentValue - min) / (max - min)) * 100

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = Number(e.target.value)
      if (!isControlled) setInternalValue(newValue)
      onValueChange?.(newValue)
    }

    return (
      <div
        ref={ref}
        className={cn(
          'relative flex w-full touch-none select-none items-center',
          disabled && 'opacity-50 pointer-events-none',
          className,
        )}
        {...props}
      >
        <div className="relative h-1.5 w-full grow overflow-hidden rounded-full bg-primary/20">
          <div
            className="absolute h-full bg-primary transition-all"
            style={{ width: `${percentage}%` }}
          />
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={currentValue}
          onChange={handleChange}
          disabled={disabled}
          className="absolute inset-0 w-full h-1.5 cursor-pointer opacity-0"
          style={{ margin: 0 }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 h-4 w-4 rounded-full border border-primary/50 bg-background shadow-sm transition-colors hover:border-primary pointer-events-none"
          style={{ left: `calc(${percentage}% - ${percentage === 0 ? 0 : percentage === 100 ? 1 : 0.5}rem)` }}
        />
      </div>
    )
  },
)
Slider.displayName = 'Slider'

export { Slider }