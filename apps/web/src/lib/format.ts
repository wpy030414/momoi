/** token 数格式化为可读字符串：<1000 → 精确；<10K → x.xK；<1M → xK；≥1M → x.xM；
 *  M 级带一位小数（会话累计消耗常达百万，`1200K` 这种写法不可读）。 */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const k = n / 1000
    return k < 10 ? `${k.toFixed(1).replace(/\.0$/, '')}K` : `${Math.round(k)}K`
  }
  const m = n / 1_000_000
  return m < 10 ? `${m.toFixed(1).replace(/\.0$/, '')}M` : `${Math.round(m)}M`
}

/** 耗时格式化为可读字符串（状态条「本轮耗时」）：
 *  <1s → 整数毫秒（640ms）；<10s → 一位小数秒（3.4s）；≥10s → 整数秒（12s）。
 *  秒级以下保留毫秒是为了让「快到看不见」与「真的等了」区分得开。 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 10000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.round(ms / 1000)}s`
}