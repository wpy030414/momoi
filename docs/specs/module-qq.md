# Spec — QQ 绑定与聊天（QQ Bot Binding & Chat）

## 概述

QQ 绑定系统让用户把自己在 [QQ 开放平台](https://q.qq.com)（q.qq.com）创建的个人机器人的 **AppID + AppSecret** 填入 Momoi，实现「在 QQ 里私聊 / 群聊机器人继续和 AI 对话」。核心链路为：网页端填写凭证 → 服务端校验（获取 access_token）→ 为该用户建立 WebSocket 网关长连接（出站连接，无需公网 IP）→ C2C 私聊 / 群 @机器人消息推送到达 → 桥接到 AI 对话引擎生成回复 → 统一一次性发送回复（无流式）。群聊需用户在绑定时或绑定后手动开启 `group_enabled` 开关。

与微信渠道同构：**单表 `qq_bindings`**、`user_id` 主键、1 用户 : 1 机器人 : 1 会话。**两渠道完全正交**——同一会话可同时绑定微信与 QQ，各自独立路由、互不干扰；跨渠道经共享的 per-user 锁串行化（见 `src/server/im/locks.ts`）。

**无认领模型**：QQ 个人机器人在未发布状态下只有创建者本人能私聊，发送消息者必然是用户本人，因此**不存储 / 不校验 openid 归属**（openid 仅在收到消息时从事件中取出用于回复）。

**手写最小协议客户端**：不引入 `@tencent-connect/qqbot-nodejs` SDK（完整框架过重），协议事实逆向自其 v1.0.4 源码，仅实现所需子集（token、C2C/群发送、WS 网关）。唯一新增依赖为 `ws`（发送网关 WS；自定义 User-Agent 头所需，且已在依赖树中）。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/server/schema.ts` / `schema.pg.ts` | `qqBindings` 表定义（Drizzle ORM，双方言） |
| `src/server/db.ts` | `qq_bindings` 迁移 SQL（SQLite / PostgreSQL 双方言） |
| `src/server/routes/qq.ts` | QQ 绑定 REST API（查询、绑定/换绑、解绑） |
| `src/server/qq/api.ts` | QQ 开放平台 REST 协议纯函数客户端（token 缓存、发 C2C 文本、发群文本、网关地址） |
| `src/server/qq/gateway.ts` | WS 网关连接状态机（心跳、IDENTIFY/RESUME、关闭码策略重连；处理 C2C_MESSAGE_CREATE 与 GROUP_AT_MESSAGE_CREATE） |
| `src/server/qq/manager.ts` | per-user 连接注册表（启停/重启/启动恢复；连线 onGroupMessage 回调） |
| `src/server/qq/chat.ts` | QQ 消息处理核心（去重、跨渠道锁、C2C 路由 + 群聊懒创建会话、统一单次回发） |
| `src/server/im/locks.ts` | 跨渠道共享 per-user 锁（微信/QQ 消息串行化） |
| `src/server/index.ts` | 服务启动时挂载路由并调用 `initQqBots()` 恢复连接 |
| `src/server/routes/conversations.ts` | 软删会话时调用 `unbindConversationQq()` 清除路由（保留凭证） |
| `src/server/routes/user.ts` / `admin.ts` | 改名换 key 重启连接 / 删用户停连接 |
| `src/client/components/chat/ImBindDialog.tsx` | 「在 IM 上继续」渠道选择外壳（微信 / QQ 两卡片） |
| `src/client/components/chat/WechatBindPanel.tsx` | 微信绑定面板（原 WechatBindDialog 去 Dialog 壳） |
| `src/client/components/chat/QqBindPanel.tsx` | QQ 绑定面板（凭证表单 / 已绑定视图） |

## 数据模型

### qq_bindings

```sql
CREATE TABLE IF NOT EXISTS qq_bindings (
  user_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL DEFAULT '',
  app_secret TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'connected',  -- 'connected' | 'error'
  error TEXT NOT NULL DEFAULT '',
  group_enabled INTEGER NOT NULL DEFAULT 0,   -- boolean: 是否启用群聊支持
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

| 列 | 类型 | 说明 |
|---|---|---|
| `user_id` | TEXT PK | Momoi 用户 ID，一个用户最多一条绑定记录 |
| `app_id` | TEXT | QQ 开放平台机器人 AppID |
| `app_secret` | TEXT | 机器人 AppSecret（明文存储，与 `wechat_bindings.bot_token` 同威胁模型；**API 永不回显、日志不打**） |
| `conversation_id` | TEXT | C2C 私聊路由目标会话 ID，**路由权威**——C2C 消息到达后发往该会话；空 = 未锚定（消息回「尚未绑定会话」提示） |
| `status` | TEXT | `'connected'` / `'error'`——仅由凭证校验失败 / 启动失败 / 致命关闭码触发；瞬时 WS 错误自动重连，不落库（防抖动） |
| `error` | TEXT | 最近一次错误信息（连接恢复后清除） |
| `group_enabled` | INTEGER | **boolean**：是否启用群聊支持（opt-in）。开启后群内 @机器人 消息才被处理；运行时开关，即时生效无需重启连接 |
| `created_at` / `updated_at` | INTEGER | Unix 秒级时间戳 |

**设计要点**：

- **凭证保留式解绑**：软删会话时仅清空 `conversation_id`，**不删行**——AppSecret 离开机主页面即不可再查（需在 q.qq.com 重新生成），保留凭证让用户换会话零成本。这与微信删整行不同（微信重绑 = 重新扫码，零成本）。
- **无 `updates_buf` / `session_expired`**：WS 推送无游标；token 过期由 api.ts 的 TokenManager 语义（缓存 + 提前刷新 + 4004 强制刷新）自动处理。
- **换凭证即换行内容**：`app_id` 变更时 open_id 空间随之改变，chat.ts 的新鲜度守卫保证旧连接在飞消息不污染新绑定。

### qq_group_conversations

QQ 群路由映射表。一个机器人可加入多个 QQ 群，因此独立于 `qq_bindings`。

```sql
CREATE TABLE IF NOT EXISTS qq_group_conversations (
  app_id TEXT NOT NULL,
  group_openid TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (app_id, group_openid)
);

CREATE INDEX IF NOT EXISTS idx_qq_group_conv_app ON qq_group_conversations(app_id);
```

| 列 | 类型 | 说明 |
|---|---|---|
| `app_id` | TEXT | 机器人 AppID，与 `qq_bindings.app_id` 对应 |
| `group_openid` | TEXT | QQ 群唯一标识（来自 `GROUP_AT_MESSAGE_CREATE` 事件） |
| `conversation_id` | TEXT FK | 对应的 Momoi 群组会话；ON DELETE CASCADE：会话硬删时自动清除映射 |
| `created_at` | INTEGER | Unix 秒级时间戳 |

**行为**：
- **懒创建**：首次收到群消息时自动创建 `type:'group'` 会话 + 注册默认 Agent 为唯一成员 + 写入映射行
- **软删自愈**：若映射指向的会话已被软删，下次消息到达时清理旧映射并重新创建会话
- **群独立路由**：C2C 私聊走 `qqBindings.conversation_id`，群聊走 `qq_group_conversations`——两者路由完全隔离

## API 契约

所有端点均需 `userAuthMiddleware`（用户 JWT 认证）。

### GET /api/qq/bind -- 查询绑定状态

**响应**：

```json
// 未绑定
{ "bound": false }

// 已绑定
{
  "bound": true,
  "app_id": "102345678",
  "bound_at": 1726123456,
  "conversation_id": "目标会话 UUID（未锚定时省略）",
  "status": "connected",
  "error": "最近错误（无则省略）",
  "group_enabled": false,
  "ws_connected": true
}
```

`ws_connected` 来自 manager 内存态（连接是否 READY/RESUMED）；DB 是绑定权威，服务重启后 WS 态自动重建。

### POST /api/qq/bind -- 绑定 / 换绑

**请求**：

```json
{
  "conv_id": "可选 - 目标会话 ID",
  "app_id": "可选 - 机器人 AppID",
  "app_secret": "可选 - 机器人 AppSecret",
  "group_enabled": "可选 - 是否启用群聊支持（boolean）"
}
```

**行为**（per-user `withNamedLock('qq-bind:'+userId)` 串行化）：

1. `conv_id` 校验同微信：归属当前用户、未软删（否则 404；不再拒绝 group 类型）。
2. **携带凭证**（`app_id` 与 `app_secret` 必须成对，缺一 400）：
   - 调 `getAccessToken()` 校验凭证（fail-fast，失败返回 400 带原因，不落库不起连接）；
   - upsert 绑定行：写凭证、`conversation_id = conv_id || 既有值`、`group_enabled`、`status='connected'`、清 `error`；
   - `restartBotForUser(userId)` 重建 WS 连接（旧连接停止）。
3. **不携带凭证**：
   - 有 `conv_id`：仅更新 `conversation_id`（换绑会话，无需动连接）；
   - 仅 `group_enabled`（无 `conv_id` 无凭证）：仅更新 `group_enabled` toggle（即时生效，无需重启连接）。

**响应**：`{ "success": true }`（凭证校验失败：400 `{ "error": "AppID 或 AppSecret 无效：..." }`）

### DELETE /api/qq/bind -- 解绑

**行为**：`stopBotForUser(userId)` 断开 WS 连接 + 删除绑定行。

**响应**：`{ "success": true }`

## 消息处理流程

### C2C 私聊

```
QQ 用户私聊机器人
    │
    ▼
┌──────────────────────────────────────────────────┐
│  gateway.ts: QQGatewayConnection（per-user）       │
│  - WS 出站连接（GET /gateway 取 wss 地址）          │
│  - HELLO → 心跳（op 1, d=lastSeq）                 │
│  - IDENTIFY（op 2, intents=1<<25）/ RESUME（op 6）  │
│  - DISPATCH: C2C_MESSAGE_CREATE → onMessage；      │
│    GROUP_AT_MESSAGE_CREATE → onGroupMessage         │
│  - 关闭码策略重连（见下）；4914/4915 致命停连        │
└──────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────┐
│  chat.ts: handleQqMessage()                       │
│  1. 去重检查（messageId 5 分钟缓存）               │
│  2. 跨渠道 per-user 锁（withUserImLock）           │
│  3. 新鲜度守卫：重读绑定行，app_id 不符即静默丢弃    │
│  4. 路由权威 conversation_id（空 → 提示未绑定）     │
│  5. 内部命令：/clear /new /reset ／clear           │
│  6. 校验目标会话仍存活                             │
│  7. 保存用户消息 + broadcastStream（网页端 SSE）    │
│  8. runPiAgentLoop（send 回调广播 SSE，不回发 QQ）  │
│  9. 保存 AI 回复 + broadcastConversationChanged    │
│ 10. sendTextWithRetry 全文一次性发送（3 次退避 +    │
│     超 4000 字符自动分片）                         │
│ 11. 最终失败写入 system 消息到对话                  │
└──────────────────────────────────────────────────┘
```

### 群聊

```
QQ 群成员 @机器人
    │
    ▼
┌──────────────────────────────────────────────────┐
│  gateway.ts: GROUP_AT_MESSAGE_CREATE               │
│  → onGroupMessage({ groupOpenid, authorOpenid,     │
│    authorUsername, content, messageId })            │
└──────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────┐
│  chat.ts: handleQqGroupMessage()                   │
│  1. 去重检查 + per-user 锁                         │
│  2. 新鲜度守卫：binding 存在 + app_id 匹配 +        │
│     group_enabled === true（否则静默丢弃）           │
│  3. resolveGroupConversation() — 懒创建             │
│     - 查 qq_group_conversations 映射               │
│     - 无 → 创建 group-type 会话 + 单 Agent          │
│     - 软删 → 清理旧映射 + 重建                      │
│  4. 内置命令 /clear 等（回复到群）                  │
│  5. 写用户消息：[昵称]: 内容（agent_id=null）        │
│  6. runPiAgentLoop({ isGroup:true, isQqGroup:true })│
│  7. 保存 AI 回复（agent_id=默认 Agent）              │
│  8. sendGroupTextWithRetry 一次性回发到群            │
│     （3 次退避 + msgId 超时主动推送降级）             │
│  9. 失败写入 system 消息 [QQ群推送失败]              │
└──────────────────────────────────────────────────┘
```

### 回发方式

**C2C 与群聊统一为单次发送**（D45 决策——放弃流式）。`sendTextWithRetry` / `sendGroupTextWithRetry` 逻辑：

- 超 4000 字符 → 自动分片（每片独立 `sendC2CText` / `sendGroupText`）
- 瞬时错误（HTTP 5xx / fetch failed / timeout / ECONNRESET）→ 3 次指数退避（1s/2s/4s）
- 群消息被动回复窗口仅 5 分钟 → 彻底失败前不带 `msg_id` 再尝试一次主动推送
- 全部失败 → 写 system 消息标记 `[QQ推送失败]` / `[QQ群推送失败]`

### 被动回复配额

始终透传入站消息的 `id` 作为回复的 `msg_id` / `event_id`（被动回复配额高于主动推送）。

### WS 关闭码策略

| 关闭码 | 行为 |
|---|---|
| 4914 / 4915 | **致命**：机器人未上线或仅在沙箱可用 / 被封禁 → 停连 + DB `status='error'` |
| 4004 | 刷新 token 后重连 |
| 4008 | 等 60s 重连 |
| 4006 / 4007 / 4009 | 清 session + 刷 token + 重连 |
| 4900–4913 | 清 session + 刷 token + 重连 |
| 1000 | 不重连（主动 stop 的正常关闭） |
| 其他 | 退避重连 `[1s,2s,5s,10s,30s,60s]`（连接成功归零，上限 100 次） |

附加保护：连续 3 次 <5s 快断 → 强制冷却 60s。op 9 INVALID_SESSION：`d`=false 时清 session + 刷 token，3s 后重连。

## 行为约束

1. **C2C + 群聊**：处理 `C2C_MESSAGE_CREATE`（始终）与 `GROUP_AT_MESSAGE_CREATE`（仅 `group_enabled` 开启时）。频道事件静默忽略。
2. **无 sender 校验（C2C）**：个人机器人未发布态私聊者必然是用户本人（1:1:1 模型），不存储不校验 openid 归属。
3. **群聊无 sender 校验**：群内任何成员 @机器人 均可触发回复（方案 B —— 单 Agent 对多真人）。消息以 `[昵称]: 内容` 格式写入，AI 通过系统提示词区分不同说话者。
4. **群聊 opt-in**：`group_enabled` 默认 false；绑定时或绑定后可在面板切换；仅影响路由层（不改变 WS intent 订阅），即时生效无需重启连接。
5. **群聊懒创建会话**：首次收到群消息 → `resolveGroupConversation()` 自动创建 `type:'group'` 会话 + 单默认 Agent
6. **跨渠道锁**：`withUserImLock(userId)` 与微信共享同一进程级锁 Map——微信与 QQ 可绑同一会话，锁 key 为裸 userId 保证三渠道消息串行处理（含 AI 调用全程），防历史交叉与乱序。
7. **新鲜度守卫**：消息处理时重读绑定行，行不存在或 `app_id` 与接收连接不符 → 静默丢弃（换凭证后在飞消息不污染新绑定）。
8. **连接幂等与串行化**：`startBotForUser` 幂等（同 appId 跳过）；`restartBotForUser` 经 `withNamedLock('qq-restart:'+userId)` 串行化，防并发绑定造成双连接双事件。
9. **凭证校验 fail-fast**：POST /bind 携带凭证时先取 access_token 验证，失败 400 内联反馈，不落库不起连接。
10. **凭证保留式解绑**：软删会话仅清 `conversation_id`（`unbindConversationQq`）；未锚定时消息回「尚未绑定会话」提示，连接保持。
11. **显式解绑断连**：DELETE /bind 停连接 + 删行。
12. **改名 / 删用户级联**：改名 `update qq_bindings.user_id` + 连接换 key 重启；删用户删行 + 停连接（防幽灵连接）。
13. **状态落库阈值**：DB `status='error'` 仅由凭证校验失败 / 启动失败 / 致命关闭码触发；瞬时 WS 错误仅日志 + 自动重连（防状态抖动），连接恢复（READY/RESUMED）自动清除 error 态。
14. **消息去重**：基于 QQ `message_id` 的 5 分钟内存缓存（RESUME 边界可能重复投递），去重在获取锁之前。
15. **服务重启语义**：sessionId/lastSeq 仅内存，重启后放弃 RESUME 直接 IDENTIFY——停机期间消息丢失（与微信轮询停机同级）；`initQqBots()` 启动时自动恢复全部连接。
16. **secret 永不回显**：GET /bind 仅返回 `app_id`；日志不打印 secret。
17. **超长回复**：降级路径按 ~4000 字符分片（QQ 单条上限约 5000）。
18. **群聊不启用跨会话记忆**：群聊的 `userId` 是机器人绑定者而非群内发言者，注入会把绑定者的私人记忆投放到群里（多真人均可见、无法撤回），写入会把群成员的事记到绑定者名下——因此 QQ 群聊**既不注入也不写入**（`save_memory` 工具不暴露，工具执行层另有兜底拒绝，见 `module-memory.md` D-M06）；C2C 私聊照常启用记忆。

## 内部命令

与微信完全一致：`/clear`、`/new`、`/reset`、`／clear` → 回复「会话已重置。」，不触发 AI 调用。

## 验收标准

1. 网页端「在 IM 上继续」→ 渠道选择页展示微信 / QQ 两卡片；微信扫码流程回归无损。
2. 错误凭证提交 → 表单内联报错（400），不落库不起连接。
3. 正确凭证 → 绑定成功，`GET /api/qq/bind` 返回 `ws_connected: true`，`group_enabled: false`，服务端日志见 READY。
4. QQ 私聊机器人 → 网页端该会话 SSE 实时镜像（user/assistant 消息同步出现）。
5. AI 回复一次性全文送达 QQ 私聊（超长自动分片）；发送失败 → 会话内 system 消息标记 `[QQ推送失败]`。
6. 连发多条消息 → 串行处理，无上下文交叉（同渠道与跨渠道皆然）。
7. 群聊（group_enabled 未开启）→ @机器人无任何响应。
8. 群聊（group_enabled 开启）→ 首次 @机器人自动创建「QQ群聊」群组会话；消息格式 `[昵称]: 内容`；AI 回复一次性送达群聊。
9. 群聊多成员交替发言 → 网页端 SSE 实时镜像，不同昵称的消息各自独立。
10. 群聊 /clear 命令 → 回复「会话已重置。」到群。
11. 关闭 group_enabled toggle → 群消息不再响应（即时生效，无需重启）。
12. 软删绑定会话 → C2C 消息回「尚未绑定会话」提示，凭证保留；在另一会话「绑定到此会话」→ 路由转移。
13. 软删群组会话 → 下次群消息自动清理旧映射并重建新会话。
14. 更换凭证 → 旧连接停止、新连接 READY；换绑瞬间的在飞消息被新鲜度守卫丢弃。
15. 显式解绑 → 行删除、WS 断开。
16. 重启服务 → `initQqBots()` 自动恢复连接，QQ 消息恢复响应。
17. 双渠道正交：微信与 QQ 同时绑定同一会话，两边交替发消息全部串行有序路由。
18. 改名 / 删用户 → 连接 key 更换 / 停止，无幽灵连接。

## 附录：协议速查表（逆向自 qqbot-nodejs@1.0.4）

- **Token**：`POST https://bots.qq.com/app/getAppAccessToken`，body `{appId, clientSecret}` → `{access_token, expires_in≈7200}`；缓存提前刷新 `min(5min, ttl/3)`。
- **REST**：base `https://api.sgroup.qq.com`，头 `Authorization: QQBot <token>`；C2C 文本 `POST /v2/users/{openid}/messages` `{content, msg_type:0, msg_seq, msg_id}`；群文本 `POST /v2/groups/{group_openid}/messages`；网关 `GET /gateway`。
- **msg_seq**：`(Date.now()%1e8 ^ rand(65536)) % 65536`。
- **WS**：op 0/1/2/6/7/9/10/11；IDENTIFY `{token:"QQBot <token>", intents:1<<25, shard:[0,1]}`；RESUME `{token, session_id, seq}`；心跳 `d=lastSeq`。
- **C2C_MESSAGE_CREATE 载荷**：`{id, content, author.user_openid, timestamp}`。
- **GROUP_AT_MESSAGE_CREATE 载荷**：`{id, content, author: {member_openid, username}, group_openid, timestamp}`。content 已由平台自动剥离 @bot 前缀。
