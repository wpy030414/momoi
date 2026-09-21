# Spec — 微信绑定与聊天（WeChat Binding & Chat）

## 概述

微信绑定系统让用户通过扫码将微信与 Momoi 账号绑定，实现「在微信里和 AI 聊天」。核心链路为：网页端发起绑定（生成二维码 / 轮询扫码状态）→ 微信扫码确认 → 微信消息到达后经过轮询器拉取 → 桥接到 AI 对话引擎生成回复 → 通过 iLink API 将回复发回微信。

系统基于**单表 `wechat_bindings`**（合并设计，非双表），以 `user_id` 为主键，一行承载：Bot 通道凭证（`bot_token`）、微信身份（`wechat_user_id`）、路由目标（`conversation_id`）、轮询游标（`updates_buf`）、会话健康状态（`session_expired`）以及绑定锚点意图（`pending_conversation_id`）。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `apps/server/src/schema.ts` | `wechatBindings` 表定义（Drizzle ORM schema） |
| `apps/server/src/db.ts` | `wechat_bindings` 迁移 SQL（SQLite / PostgreSQL 双方言） |
| `apps/server/src/routes/wechat.ts` | 微信绑定 REST API（绑定、状态轮询、解绑） |
| `apps/server/src/wechat/ilink.ts` | iLink Bot 协议客户端（轮询消息、发送回复、解析入站消息） |
| `apps/server/src/wechat/poller.ts` | 微信消息轮询器（setInterval 定时遍历所有已绑定用户） |
| `apps/server/src/wechat/chat.ts` | 微信消息处理核心（路由到 AI、去重、并发锁、内部命令） |
| `apps/server/src/index.ts` | 服务启动时调用 `startWechatPoller()` |
| `apps/server/src/routes/conversations.ts` | 软删/硬删会话时调用 `unbindConversationWechat()` 自动解绑 |

## 数据模型

### wechat_bindings

```sql
CREATE TABLE IF NOT EXISTS wechat_bindings (
  user_id TEXT PRIMARY KEY,
  bot_token TEXT NOT NULL DEFAULT '',
  wechat_user_id TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  pending_conversation_id TEXT NOT NULL DEFAULT '',
  updates_buf TEXT NOT NULL DEFAULT '',
  session_expired INTEGER NOT NULL DEFAULT 0,    -- SQLite: INTEGER; PG: BOOLEAN
  created_at INTEGER NOT NULL
);
```

| 列 | 类型 | 说明 |
|---|---|---|
| `user_id` | TEXT PK | Momoi 用户 ID，一个用户最多一条绑定记录 |
| `bot_token` | TEXT | iLink Bot token，扫码确认后由 iLink 下发；空值表示未扫码（占位行） |
| `wechat_user_id` | TEXT | 微信用户的 iLink ID，扫码确认后由 iLink 下发；用于 sender 合法性校验 |
| `conversation_id` | TEXT | 绑定的目标会话 ID，**路由权威**——微信消息到达后发往该会话 |
| `pending_conversation_id` | TEXT | 绑定意图锚点：POST /bind 时写入期望绑定的会话 ID；扫码确认后写入 `conversation_id` 并清空 |
| `updates_buf` | TEXT | iLink 长轮询游标，保存上一次 `getupdates` 返回的 `get_updates_buf` |
| `session_expired` | INTEGER/BOOLEAN | Bot token 是否已过期（errcode=-14）；过期后轮询器跳过该用户 |
| `created_at` | INTEGER | Unix 秒级时间戳，绑定/换绑时刷新 |

**设计要点**：

- 单表合一：不再拆分为"令牌表 + 状态表"，一行承载绑定全生命周期（扫描 → 确认 → 消息路由 → 过期/换绑）。
- `pending_conversation_id` 是临时意图：POST /bind 写入，扫码确认后转移到 `conversation_id` 并清空。若中间目标会话被删除，确认时校验失败返回 "expired"。
- `conversation_id` 是路由权威：消息到达时直接读取该列定位目标会话；换绑时覆盖该列即完成路由转移。

## API 契约

所有端点均需 `userAuthMiddleware`（用户 JWT 认证）。

### GET /api/wechat/bind -- 查询绑定状态

**请求**：无 body。

**响应**：

```json
// 已绑定（bot_token 非空）
{
  "bound": true,
  "wechat_user_id": "微信用户 iLink ID",
  "bound_at": 1726123456,
  "conversation_id": "目标会话 UUID 或 null",
  "session_expired": false
}

// 未绑定（无绑定行或 bot_token 为空）
{
  "bound": false
}
```

**逻辑**：若绑定行不存在或 `bot_token` 为空（占位行），返回 `bound: false`。

### POST /api/wechat/bind -- 发起绑定

**请求**：

```json
{
  "conv_id": "可选 - 目标会话 ID"
}
```

**行为**：

1. 若 `conv_id` 存在，校验会话属于当前用户、未被软删除、类型非 `group`（群聊不可绑定微信）。不满足返回 404/400。
2. 调用 iLink `/ilink/bot/get_bot_qrcode?bot_type=3` 获取二维码。
3. 若已有绑定行：更新 `pending_conversation_id` 为 `targetConvId`（换绑意图）。
4. 若无绑定行：插入占位行（`bot_token=''`, `wechat_user_id=''`, `conversation_id=''`），`pending_conversation_id` 写入目标会话 ID。
5. 服务端用 `qrcode_img_content`（liteapp URL）生成 QR Code Data URI 返回前端。

**响应**：

```json
{
  "qrcode_id": "iLink qrcode 标识",
  "qrcode_page_url": "liteapp URL（微信扫码跳转）",
  "qrcode_data_uri": "data:image/png;base64,...",
  "expires_at": 1726123456789
}
```

### GET /api/wechat/bind/status -- 轮询扫码状态

**请求**：`?qrcode_id=xxx`

**响应**：

```json
// 等待扫码
{ "status": "wait" }

// 扫码已确认
{ "status": "confirmed" }

// 二维码已过期
{ "status": "expired" }

// 目标会话已被删除（绑定失败）
{ "status": "expired", "error": "目标会话已删除，请重新选择会话并绑定。" }
```

**确认逻辑**（`status === 'confirmed'` 且含 `bot_token`）：

1. **Per-user 锁**（`withBindingLock`）：串行化同一用户的并发确认，防止 bot_token / conversation_id 被交叉覆盖。
2. 查询当前绑定行。
3. 若行存在：
   - `targetConvId` = `pending_conversation_id || conversation_id`（优先意图锚点，回退到已有目标）。
   - 校验目标会话仍存活且属于当前用户；不满足则返回 `expired`。
   - 更新绑定行：写入 `bot_token`、`wechat_user_id`、`conversation_id`（覆盖转移）、清空 `updates_buf` / `session_expired` / `pending_conversation_id`、刷新 `created_at`。
4. 若行不存在（目标会话被删导致占位行被 `unbindConversationWechat` 清理）：拒绝确认，返回 `expired`。

**覆盖转移**：路由权威是 `conversation_id` 本身。换绑时直接写入新的 `conversation_id`，旧会话不再收到微信消息。无需额外的"转移"步骤。

### DELETE /api/wechat/bind -- 解绑

**行为**：删除 `wechat_bindings` 中该用户的绑定行。`bot_token` 一并清除，重新绑定需重新扫码。

**响应**：

```json
{ "success": true }
```

### 绑定锁（bindingLocks）

```typescript
const bindingLocks = new Map<string, Promise<void>>()

async function withBindingLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  while (bindingLocks.has(key)) {
    await bindingLocks.get(key)
  }
  const promise = fn()
  bindingLocks.set(key, promise.then(
    () => { bindingLocks.delete(key) },
    () => { bindingLocks.delete(key) },
  ) as unknown as Promise<void>)
  return promise
}
```

Per-user Promise 链，防止两个并发的扫码确认交叉覆盖对方的 `bot_token` / `conversation_id`。

### 会话删除联动（unbindConversationWechat）

```typescript
// apps/server/src/routes/conversations.ts
export async function unbindConversationWechat(userId: string, conversationId: string): Promise<void> {
  const binding = await db.select().from(wechatBindings)
    .where(eq(wechatBindings.user_id, userId)).get()
  if (binding && binding.conversation_id === conversationId) {
    await db.delete(wechatBindings).where(eq(wechatBindings.user_id, userId)).run()
  }
}
```

软删或硬删会话时调用：若绑定目标正好是该会话，删除整条绑定行。轮询器亦有自愈逻辑——若发现绑定指向已删除的会话，同样清理绑定行。

## 微信消息处理流程

```
微信用户发消息
    │
    ▼
┌──────────────────────────────────────────────────┐
│  poller.ts: setInterval 定时轮询                   │
│  - 遍历 wechat_bindings 中非 expired、有 bot_token  │
│    且绑定会话未软删除的行                            │
│  - Per-user busyUsers Set 防重叠轮询               │
│  - 调用 getUpdates(creds, updates_buf)             │
│  - 解析每条消息 → handleWechatMessage()             │
│  - 保存 updates_buf 游标（消息处理后）              │
│  - writeGuard: UPDATE 限定 bot_token 防止污染新绑定  │
└──────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────┐
│  chat.ts: handleWechatMessage()                   │
│  1. 去重检查（message_id 5 分钟缓存）              │
│  2. 获取 per-user 并发锁（withLock）               │
│  3. 查 wechat_bindings → 路由权威 conversation_id  │
│  4. Sender 校验：wechat_user_id 匹配               │
│  5. 内部命令解析：/clear /new /reset               │
│  6. 校验目标会话仍存活                              │
│  7. 保存用户消息到 messages 表                     │
│  8. 加载历史 → runPiAgentLoop()                    │
│  9. 保存 AI 回复到 messages 表                     │
│  10. sendMessage() 发回微信（3 次重试）             │
│  11. session_expired 标记（errcode=-14）            │
│  12. 推送失败写入 system 消息到对话                 │
└──────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────┐
│  ilink.ts: iLink Bot 协议                         │
│  getUpdates(creds, updatesBuf) → WechatPollResult │
│  sendMessage(creds, toUserId, text, ctxToken)     │
│  parseIncoming(msg) → ParsedIncoming              │
└──────────────────────────────────────────────────┘
```

### 轮询器详细行为

- **启动**：`startWechatPoller()` 在 `apps/server/src/index.ts` 服务启动时调用，默认间隔 5000ms。
- **递归调度**：`setTimeout` 递归（非 `setInterval`），每次 poll 完成后再排下一次，防止堆积。
- **Per-user guard**：`busyUsers` Set 防止同一用户的上一次轮询未完成时再次进入。
- **writeGuard**：pollUser 闭包持有绑定行快照，UPDATE 时限定 `bot_token` 等于快照值。防止：用户换绑后 bot_token 变更，但仍在飞行中的旧轮询返回 errcode=-14 污染新绑定的 `session_expired` 或游标。
- **自愈**：轮询时发现绑定指向的会话已被软删除，删除绑定行（`(B3) self-heal`）。
- **errCode=-14**：标记 `session_expired = true`，停止后续轮询该用户。
- **游标保存时机**：消息处理成功后才保存 `updates_buf`，防止处理失败导致消息丢失。

### 消息去重（Dedup）

```typescript
const dedupCache = new Map<number, number>()  // message_id → timestamp
const DEDUP_WINDOW_MS = 5 * 60_000            // 5 分钟窗口

function isDuplicate(messageId: number | undefined, now: number): boolean {
  if (messageId === undefined) return false   // 无 message_id 的消息放行
  // Evict stale entries
  for (const [id, ts] of dedupCache) {
    if (now - ts > DEDUP_WINDOW_MS) dedupCache.delete(id)
  }
  if (dedupCache.has(messageId)) return true
  dedupCache.set(messageId, now)
  return false
}
```

- 基于 iLink 返回的 `message_id` 去重，同一消息可能被重复投递。
- 窗口 5 分钟，过期条目惰性回收。
- 去重在获取并发锁**之前**执行，避免因重复消息排队等待 AI 调用。

### 并发锁（Per-user Promise Chain）

```typescript
const locks = new Map<string, Promise<void>>()

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
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
```

同一用户的微信消息串行处理：后到的消息等待前一条完成（包括 AI 生成 + 推送），防止消息乱序、上下文交叉。

### 消息发送与重试

```typescript
const MAX_RETRIES = 3
// 重试策略：指数退避 1s, 2s, 4s
const delay = Math.pow(2, attempt) * 1000
```

**重试触发条件**（瞬时性错误）：

- HTTP 5xx
- `fetch failed`
- `timeout` / `ETIMEDOUT`
- `ECONNRESET`

**不重试条件**：

- `errcode=-14` 或 `session timeout`：标记 `session_expired = true`，立即停止。
- 其他不可重试错误：记录日志，写入 system 消息到对话提示用户。

**推送失败标记**：

若 3 次重试后仍未成功，在对话中插入一条 `role: 'system'` 消息：

```
[WeChat推送失败] 回复已生成但未能发送到微信。请尝试重新绑定微信。
```

### iLink API 客户端

| 函数 | 说明 |
|---|---|
| `getUpdates(creds, updatesBuf, timeoutMs)` | POST `/ilink/bot/getupdates`，长轮询（默认 35s 超时），返回 `WechatPollResult { errcode, ret, msgs, updatesBuf }` |
| `sendMessage(creds, toUserId, text, contextToken?)` | POST `/ilink/bot/sendmessage`，15s 超时，`message_state=2`（FINISH），失败抛异常 |
| `parseIncoming(msg)` | 解析 `WeixinMessage`，过滤非文本（`message_type !== 1`），提取 `senderId`、`content`、`contextToken`、`messageId` |
| `buildHeaders(token?)` | 构造 iLink 请求头（Content-Type、ClientVersion、AuthorizationType、随机 X-WECHAT-UIN、可选 Bearer token） |

`sendMessage` 关键字段：

- `message_type: 2`（非文本类型，用于 bot 发送）
- `message_state: 2`（FINISH -- 缺失会导致服务端不投递）
- `client_id`：随机 16 进制字符串（截取自 UUID v4 的前 16 个 hex 字符）

## 行为约束

1. **会话锚定**：POST /bind 时可通过 `conv_id` 指定目标会话；扫码确认后消息路由到该会话。未指定时复用已有 `conversation_id`（换绑不改变目标）。
2. **覆盖转移**：路由权威是 `conversation_id` 列。换绑时写入新目标即完成转移，旧会话不再收到消息。无需额外转移步骤。
3. **Sender 校验**：扫码生成的 bot 通道是用户专属 1v1 通道，合法 sender 即 `wechat_user_id` 本身。非匹配 sender 的消息静默忽略（不回复 "未绑定" 提示）。
4. **群聊不可绑定**：POST /bind 时拒绝 `type='group'` 的会话（返回 400）。
5. **占位行语义**：`bot_token` 为空 = 占位行（POST /bind 创建，尚未扫码）。GET /bind 返回 `bound: false`。
6. **Per-user 锁（绑定确认）**：`withBindingLock` 串行化扫码确认，防止 bot_token / conversation_id 交叉覆盖。
7. **Per-user 锁（消息处理）**：`withLock` 串行化同用户的消息处理，防止乱序和上下文交叉。
8. **消息去重**：基于 `message_id` 的 5 分钟内存缓存，去重在获取锁之前执行。
9. **轮询 writeGuard**：UPDATE 限定 `bot_token` 等于 pollUser 闭包快照值，防止旧轮询污染新绑定的游标或 session_expired 标记。
10. **会话过期（session_expired）**：errcode=-14 时标记，轮询器跳过该用户；前端 GET /bind 返回 `session_expired: true` 提示用户重新绑定。
11. **会话删除联动**：软删/硬删会话时自动解绑（`unbindConversationWechat`）；轮询器亦自愈——发现绑定指向已删会话时清理绑定行。
12. **目标会话删除守卫**：扫码确认时二次校验目标会话仍存活；占位行被清理后扫码确认返回 `expired`。
13. **sendMessage 发送 3 次重试**：瞬时性错误指数退避重试；session 过期不重试；最终失败写入 system 消息。
14. **内部命令静默处理**：`/clear`、`/new`、`/reset`（及全角 `／clear`）回复 "会话已重置。"，不触发 AI 调用。当前实现为纯提示，不实际修改数据库——因为路由权威是 `conversation_id`，消息始终在同一会话，下次消息会自动基于现有历史上下文生成。
15. **轮询间隔 5 秒**：setTimeout 递归调度，每次 poll 完成后再排下一次。
16. **Per-user busyUsers Set**：防止同一用户的 pollUser 重叠执行。
17. **游标保存时机**：消息全部处理成功后才保存 `updates_buf`，防止处理失败丢消息。
18. **服务端生成 QR Code**：`qrcode_img_content`（liteapp URL）由服务端用 `qrcode` 库生成 Data URI，浏览器无需直接访问 liteapp.weixin.qq.com。

## 内部命令

| 命令 | 别名 | 行为 |
|---|---|---|
| `/clear` | -- | 回复 "会话已重置。" |
| `/new` | -- | 回复 "会话已重置。" |
| `/reset` | -- | 回复 "会话已重置。" |
| `／clear` | 全角斜杠 | 回复 "会话已重置。" |

命令在消息到达后、AI 调用前解析。当前实现为纯提示回复，不重置数据库状态——路由权威是 binding 行的 `conversation_id`，用户在微信端无法切换会话。若需在微信内真正重置上下文，需在网页端解除绑定后重新绑定新会话。

## 验收标准

1. 网页端 POST /api/wechat/bind 返回有效二维码，前端可渲染。
2. 微信扫码后 GET /api/wechat/bind/status 返回 `confirmed`，bot_token 写入数据库。
3. 微信发送消息后，轮询器拉取到消息并触发 AI 回复。
4. AI 回复通过 iLink sendmessage 成功发回微信。
5. 消息去重生效：同一 message_id 在 5 分钟内仅处理一次。
6. 并发锁生效：同一用户的连续多条消息串行处理，无上下文交叉或乱序。
7. 会话锚定：POST /bind 指定 conv_id 后扫码，消息路由到目标会话。
8. 覆盖转移：解除绑定后重新绑定到新会话，旧会话不再收到消息。
9. Sender 校验：非绑定微信用户的消息被静默忽略。
10. 群聊会话拒绝绑定（返回 400）。
11. 会话过期：errcode=-14 后 session_expired 标记为 true，轮询器停止轮询该用户。
12. 会话删除联动：删除已绑定会话后，wechat_bindings 行被清理；轮询器自愈逻辑亦能清理。
13. 目标会话在扫码期间被删除：确认返回 `expired`，不创建僵尸绑定。
14. sendMessage 瞬时错误 3 次重试；session 过期不重试。
15. 推送最终失败：对话中插入 system 消息提示用户。
16. `/clear` / `/new` / `/reset` 命令回复提示文案，不触发 AI 调用。
17. 轮询 writeGuard：换绑后旧轮询结果不污染新绑定的游标或 session_expired。
18. 服务启动后轮询器自动运行，无需手动启动。
19. 服务端生成 QR Code Data URI，前端无需直连 liteapp 域名。
20. 换绑后旧会话消息队列中排队的消息不会路由到新会话（binding 行的 conversation_id 已变更，旧队列中的消息自然路由到新目标）。