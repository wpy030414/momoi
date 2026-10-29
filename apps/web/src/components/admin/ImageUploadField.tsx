import { useRef, useState, type ChangeEvent } from 'react'
import { ImageIcon } from 'lucide-react'
import { Button } from '../ui/button'

export interface ImageUploadFieldProps {
  /** 当前值（'' = 未设置）：base64 data URL 或 http(s) URL */
  value: string
  onChange: (value: string) => void
  label: string
  uploadLabel: string
  removeLabel: string
  /** 预览图的无障碍名称 */
  alt: string
  /** 辅助说明（如「仅单聊显示」） */
  hint?: string
  /** circle = 头像（正方形圆形裁切）；standing = 立绘（竖图完整显示） */
  variant?: 'circle' | 'standing'
  disabled?: boolean
}

/** 只接受位图格式：SVG 作为外部图床上传有安全面，GIF 动图在立绘场景无意义 */
const ACCEPT = 'image/png,image/jpeg,image/webp'

const PREVIEW_CLASS: Record<NonNullable<ImageUploadFieldProps['variant']>, string> = {
  circle: 'h-10 w-10 rounded-full object-cover',
  standing: 'h-24 w-16 rounded object-contain object-bottom bg-muted/40',
}

/**
 * 管理端图片字段（上传 / 预览 / 移除）。上传文件经 FileReader 转为 base64 data URL，
 * 服务端在保存时按图床开关决定是否转 CDN——与头像的既有链路一致。
 */
export function ImageUploadField({
  value, onChange, label, uploadLabel, removeLabel, alt, hint, variant = 'circle', disabled,
}: ImageUploadFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false)

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // 允许重复选择同一文件：否则第二次选同一张图不会触发 change
    e.target.value = ''
    if (!file) return
    setReading(true)
    const reader = new FileReader()
    reader.onload = () => {
      onChange(reader.result as string)
      setReading(false)
    }
    reader.onerror = () => setReading(false)
    reader.readAsDataURL(file)
  }

  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      <div className="flex items-center gap-3 mt-1">
        {value ? (
          <img src={value} alt={alt} className={PREVIEW_CLASS[variant]} />
        ) : (
          <div className={`${PREVIEW_CLASS[variant]} flex items-center justify-center bg-muted`}>
            <ImageIcon className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
        <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" onChange={handleChange} />
        <Button variant="outline" size="sm" disabled={disabled || reading} onClick={() => inputRef.current?.click()}>
          {uploadLabel}
        </Button>
        {value && (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={() => onChange('')}>
            {removeLabel}
          </Button>
        )}
      </div>
    </div>
  )
}