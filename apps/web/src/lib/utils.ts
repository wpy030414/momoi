import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** RFC 4122 v4 格式化：把 16 字节转成 8-4-4-4-12 */
function formatUuid(bytes: Uint8Array): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * 生成 UUID v4。
 *
 * 浏览器只在**安全上下文**（https / localhost）提供 `crypto.randomUUID`；
 * 局域网 http://10.x.x.x 访问时该 API 不存在，直接调用会抛
 * 「crypto.randomUUID is not a function」。这里按可用能力降级：
 * `crypto.randomUUID` → `crypto.getRandomValues` → `Math.random`。
 * 用途仅为前端本地标识（表单行 key、设备 ID），不参与任何安全校验。
 */
export function uuid(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  if (typeof c?.getRandomValues === 'function') {
    return formatUuid(c.getRandomValues(new Uint8Array(16)))
  }
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  return formatUuid(bytes)
}
