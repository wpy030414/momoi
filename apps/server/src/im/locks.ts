/**
 * 进程内 per-key Promise 链锁 — 串行化同 key 的异步临界区。
 *
 * 与微信/QQ 渠道均无关；IM 渠道消息处理（含 AI 调用全程）必须经由
 * withUserImLock(userId) 串行化：微信与 QQ 绑定正交、可指向同一会话，
 * 若各渠道各持独立锁，两渠道消息可并发跑 runPiAgentLoop 写同一会话，
 * 造成历史交叉与回复错序。因此锁 key 必须是裸 userId 且 Map 全进程唯一。
 */

const locks = new Map<string, Promise<void>>()

export async function withNamedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  while (locks.has(key)) {
    await locks.get(key)
  }
  const promise = fn()
  locks.set(key, promise.then(
    () => { locks.delete(key) },
    () => { locks.delete(key) },
  ) as unknown as Promise<void>)
  return promise
}

/** Per-user 跨渠道锁：同一用户的微信/QQ 消息处理串行化（含 AI 调用全程） */
export function withUserImLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return withNamedLock(userId, fn)
}
