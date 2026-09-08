/**
 * 内存级 IP 速率限制器 — 仅用于 PIN 登录
 *
 * 规则：同一 IP 连续 5 次 PIN 错误 → 封禁 5 分钟
 * 状态仅存于内存，重启服务即全部清除
 */

interface IpEntry {
  failures: number
  blockedUntil: number | null // epoch ms, null = 未封禁但已有失败记录
}

const MAX_FAILURES = 5
const BLOCK_DURATION_MS = 5 * 60 * 1000 // 5 分钟

const ipMap = new Map<string, IpEntry>()

// 定时清理过期条目（每分钟跑一次，防止内存泄漏）
const CLEANUP_INTERVAL_MS = 60_000
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of ipMap) {
    // 已封禁且封禁期已过的条目可以清理
    if (entry.blockedUntil !== null && entry.blockedUntil <= now) {
      ipMap.delete(ip)
    }
  }
}, CLEANUP_INTERVAL_MS)

/**
 * 从请求中提取客户端 IP
 */
export function getClientIp(c: any): string {
  // 优先取反向代理转发的真实 IP
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) {
    return forwarded.split(',')[0].trim()
  }
  // 兜底：Node.js raw request 的 socket 地址
  try {
    const raw = c.req.raw as Request & { socket?: { remoteAddress?: string } }
    if (raw?.socket?.remoteAddress) {
      return raw.socket.remoteAddress
    }
  } catch {
    // ignore
  }
  return '127.0.0.1'
}

/**
 * 检查 IP 是否处于封禁状态。
 * 返回 null 表示放行，返回字符串表示封禁原因（含剩余秒数）。
 */
export function checkIpBlocked(ip: string): string | null {
  const entry = ipMap.get(ip)
  if (!entry) return null

  if (entry.blockedUntil === null) return null

  const now = Date.now()
  if (now >= entry.blockedUntil) {
    // 封禁已过期，清理
    ipMap.delete(ip)
    return null
  }

  const remaining = Math.ceil((entry.blockedUntil - now) / 1000)
  return `Too many failed attempts. Please try again in ${remaining} seconds.`
}

/**
 * 记录一次 PIN 验证失败。
 * 若达到阈值则封禁该 IP。
 */
export function recordPinFailure(ip: string): void {
  const entry = ipMap.get(ip)
  if (!entry) {
    ipMap.set(ip, { failures: 1, blockedUntil: null })
    return
  }

  // 已封禁中不再累加
  if (entry.blockedUntil !== null && entry.blockedUntil > Date.now()) {
    return
  }

  entry.failures += 1

  if (entry.failures >= MAX_FAILURES) {
    entry.blockedUntil = Date.now() + BLOCK_DURATION_MS
  }
}

/**
 * PIN 验证成功后清除该 IP 的失败记录
 */
export function clearPinFailures(ip: string): void {
  ipMap.delete(ip)
}