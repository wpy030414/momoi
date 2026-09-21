// ============================================================
// Realtime — 同账号多设备实时事件总线（进程内内存态）
// ============================================================
// 每个已登录用户会在每台设备上保持一条 GET /api/events 的 SSE 长连接。
// 服务端把聊天流事件 / 会话列表变更 / 群成员变更实时推送给同一账号的
// 其他设备，实现「A 设备对话，B 设备实时看到 Agent 思考中 / 流式内容」，
// 无需手动刷新页面。
//
// 仅限单实例部署：多实例 / 横向扩容需把总线替换为 Redis pub/sub（超出当前范围）。
//
// 来源设备自跳过：聊天流事件携带发起方 deviceId，源设备自己的事件通道
// 不重复推送（源设备已通过 POST /api/chat 的 fetch 流直接渲染）。

interface RealtimeSubscriber {
  deviceId: string
  aborted: boolean
  writeChain: Promise<void>
  onEvent: (dataString: string) => Promise<void> | void
  pendingCount: number
}

const subscribers = new Map<string, Set<RealtimeSubscriber>>()

/**
 * 订阅当前用户的事件通道。
 * 同一 deviceId 重复订阅（React StrictMode 双挂载 / 网络重连）时，
 * 先移除旧订阅，避免事件双发。返回取消订阅函数。
 */
export function subscribeRealtime(
  userId: string,
  deviceId: string,
  onEvent: (dataString: string) => void,
): () => void {
  let set = subscribers.get(userId)
  if (!set) {
    set = new Set()
    subscribers.set(userId, set)
  }
  if (deviceId) {
    for (const existing of [...set]) {
      if (existing.deviceId === deviceId) {
        existing.aborted = true
        set.delete(existing)
      }
    }
  }
  const sub: RealtimeSubscriber = {
    deviceId,
    aborted: false,
    writeChain: Promise.resolve(),
    onEvent,
    pendingCount: 0,
  }
  set.add(sub)
  return () => {
    set.delete(sub)
    if (set.size === 0) subscribers.delete(userId)
  }
}

function publish(userId: string, skipDeviceId: string | undefined, data: unknown) {
  const set = subscribers.get(userId)
  if (!set || set.size === 0) return
  const dataString = JSON.stringify(data)
  // 惰性清理：广播时顺带移除已失效订阅，防止异常断线时订阅泄漏
  for (const sub of set) {
    if (sub.aborted) {
      set.delete(sub)
      continue
    }
    if (skipDeviceId && sub.deviceId && sub.deviceId === skipDeviceId) continue
    // Backpressure: if a subscriber has >50 pending events, mark it stale
    // so it reconnects cleanly rather than accumulating unbounded writes.
    sub.pendingCount++
    if (sub.pendingCount > 50) {
      sub.aborted = true
      set.delete(sub)
      continue
    }
    sub.writeChain = sub.writeChain
      .then(() => { sub.pendingCount--; return sub.onEvent(dataString) })
      .catch(() => { sub.aborted = true })
  }
  if (set.size === 0) subscribers.delete(userId)
}

/** 聊天流事件实时中继（跳过来源设备本身） */
export function broadcastStream(
  userId: string,
  originDeviceId: string,
  data: { conversation_id: string; event: unknown },
) {
  publish(userId, originDeviceId, { type: 'stream', ...data })
}

/** 会话列表变更 —— 侧边栏刷新信号 */
export function broadcastConversationSync(userId: string) {
  publish(userId, undefined, { type: 'conv_sync' })
}

/** 会话内容变更（如回退消息）—— 正在查看该会话的设备重新拉取消息 */
export function broadcastConversationChanged(userId: string, conversationId: string) {
  publish(userId, undefined, { type: 'conv_changed', conversation_id: conversationId })
}

/** 群成员变更 */
export function broadcastGroupMembers(userId: string, conversationId: string) {
  publish(userId, undefined, { type: 'group_members', conversation_id: conversationId })
}

/** 查询用户当前活跃设备数 */
export function getActiveDeviceCount(userId: string): number {
  const set = subscribers.get(userId)
  if (!set) return 0
  let count = 0
  for (const sub of set) {
    if (!sub.aborted) count++
  }
  return count
}
