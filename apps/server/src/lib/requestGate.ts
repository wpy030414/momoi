// ============================================================
// Request Gate — 请求级限流（分桶 · 滑动窗口 · 内存态）
// ============================================================
//
// 与 lib/rateLimiter.ts 的分工：
//   · rateLimiter.ts  = PIN 登录失败封禁（安全性质，按 IP）
//   · requestGate.ts  = 接口速率限制（防滥用/防账单，按 user + IP 双维度）
//
// 分桶：
//   generate  生成桶 —— 真正会产生上游开销的请求（聊天及其编排副产品）
//   rest      普通桶 —— 其余 REST；/api/events 长连接**不计数**（一次连接挂一分钟，
//             计入就等于每分钟扣一次额度，重连风暴下会误伤正常用户）
//
// 窗口：滑动窗口（记录时间戳队列），不是固定窗口——固定窗口在边界处会放行
// 2 倍突发（上一窗口末尾 + 下一窗口开头）。
//
// 维度：**命中任一维度即拒绝**（userId 与 IP 各存一份）。
//   · 按 userId：同一 NAT 下多人不互相拖累
//   · 按 IP：限制未登录/共享账号在单机上的爆破
//
// 内存态：单实例部署（见 docs/DECISIONS.md D73）。多实例需换成共享存储。
// ============================================================

export type GateBucket = 'generate' | 'rest'

interface WindowEntry {
  /** 窗口内请求的时间戳（epoch ms，升序） */
  hits: number[]
  lastSeen: number
}

const WINDOW_MS = 60_000
const CLEANUP_INTERVAL_MS = 60_000
/** 空闲多久后清理该 key（超过一个窗口即可回收） */
const IDLE_TTL_MS = 2 * WINDOW_MS

const buckets: Record<GateBucket, Map<string, WindowEntry>> = {
  generate: new Map(),
  rest: new Map(),
}

const cleanupTimer = setInterval(() => {
  const now = Date.now()
  for (const map of Object.values(buckets)) {
    for (const [key, entry] of map) {
      if (now - entry.lastSeen > IDLE_TTL_MS) map.delete(key)
    }
  }
}, CLEANUP_INTERVAL_MS)
// 不阻止进程退出（测试 / CLI 场景）
cleanupTimer.unref?.()

export interface GateCheckResult {
  allowed: boolean
  /** 被拒时建议的重试秒数（窗口内最早一条滑出所需的秒数） */
  retryAfterSec: number
}

/**
 * 检查并记录一次请求。
 *
 * @param bucket     分桶
 * @param identities 维度键（如 [`u:alice`, `ip:1.2.3.4`]）——**任一**超限即拒绝
 * @param limitPerMin 每分钟上限；<= 0 视为不限制
 */
export function checkAndRecord(
  bucket: GateBucket,
  identities: string[],
  limitPerMin: number,
): GateCheckResult {
  if (!Number.isFinite(limitPerMin) || limitPerMin <= 0) {
    return { allowed: true, retryAfterSec: 0 }
  }

  const now = Date.now()
  const map = buckets[bucket]

  // 先整体检查（避免部分 key 已记账、部分被拒造成计数偏差）
  let worstRetryMs = 0
  for (const id of identities) {
    const entry = map.get(id)
    if (!entry) continue
    const hits = entry.hits
    // 滑出窗口的条目不再计入（惰性清理）
    while (hits.length > 0 && hits[0] <= now - WINDOW_MS) hits.shift()
    if (hits.length >= limitPerMin) {
      // 最早一条滑出即可再放行一个
      const retryMs = hits[0] + WINDOW_MS - now
      worstRetryMs = Math.max(worstRetryMs, retryMs)
    }
  }

  if (worstRetryMs > 0) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(worstRetryMs / 1000)) }
  }

  // 全部通过：记一次
  for (const id of identities) {
    let entry = map.get(id)
    if (!entry) {
      entry = { hits: [], lastSeen: now }
      map.set(id, entry)
    }
    entry.hits.push(now)
    entry.lastSeen = now
  }
  return { allowed: true, retryAfterSec: 0 }
}

/** 清空全部限流状态（测试 / 管理员手动重置） */
export function resetGate(): void {
  for (const map of Object.values(buckets)) map.clear()
}
