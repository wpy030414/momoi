// ============================================================
// Process State — 进程级状态的单一声明处
// ============================================================
//
// 本项目的部署形态是**一个组织一个实例**：单进程 + 本地 SQLite。
// 这个形态带来一个必须显式承认的约束：
//
//   **任何跨请求、跨连接的共享状态都只存在于当前进程内存里。**
//
// 这意味着：
//   · 起两个进程指向同一个 SQLite 文件会互相踩（写锁、缓存不一致）；
//   · 反向代理后面的多实例负载均衡会让限流、IM 长连接、事件总线各自为政。
//
// 这不是「将来要修的 bug」，而是**刻意的架构取舍**（见 docs/DECISIONS.md D73）：
// 自托管的单人/小组织场景里，引入 Redis 做分布式状态，代价远大于收益。
//
// 本文件的作用不是「迁移状态」，而是把散落各处的进程内状态**登记在一处**，
// 让「只能跑一个实例」变成可发现的事实，而不是埋在每个文件里的隐形坑：
//
//   · lib/requestGate.ts        限流窗口
//   · lib/rateLimiter.ts        PIN 失败封禁
//   · lib/config.ts             配置缓存（CONFIG_TTL_MS）
//   · lib/realtime.ts           同账号多设备事件总线
//   · im/locks.ts               IM 会话锁
//   · im/qq/gateway.ts          QQ WS 网关连接
//   · im/wechat/poller.ts       微信消息轮询器
//   · routes/chat.ts            infiniteState（无限模式开关）
//   · ai/provider.ts            endpointsWithoutThinkingParams（端点能力记忆）
//   · lib/oidc-discovery.ts     discovery 文档缓存
//
// 新增进程内共享状态时，请一并登记到这里。
// ============================================================

/** 本实例是否具备多实例部署能力。恒为 false —— 见文件头。 */
export const MULTI_INSTANCE_CAPABLE = false

/** 论证依据的文档锚点（便于审查时对照） */
export const SINGLE_INSTANCE_RATIONALE = 'docs/DECISIONS.md D73'

/**
 * 启动自检：如果检测到明显的多实例信号，打一条显式告警。
 * 不做强制退出——自托管场景下误伤比放过更糟。
 */
export function warnIfMultiInstanceSuspected(): void {
  // 常见的多实例编排信号：同一 SQLite 库被多进程打开时，
  // 运维通常会设 PT Cluster 的相关环境变量，或直接用 NODE_APP_INSTANCE。
  const signals = ['NODE_APP_INSTANCE', 'PM2_INSTANCE_ID', 'PM_ID']
  const found = signals.filter((k) => process.env[k] !== undefined && process.env[k] !== '0')
  if (found.length > 0) {
    console.warn(
      `[process-state] 检测到多实例信号 (${found.join(', ')})，但 Momoi 只支持单实例部署——` +
      `限流/IM 连接/事件总线均为进程内状态。详见 ${SINGLE_INSTANCE_RATIONALE}`,
    )
  }
}