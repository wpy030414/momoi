# Spec — 对话管理（Conversation）

## 概述

对话管理模块负责对话的 CRUD 操作，按用户隔离对话数据，支持对话的创建、列表、详情查看、重命名、删除，以及从任意消息处回退。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/server/routes/conversations.ts` | REST API 路由 |
| `src/server/db.ts` | 数据库连接和迁移 |
| `src/server/schema.ts` | Drizzle ORM 表定义 |
| `src/server/middleware/userAuth.ts` | 用户 JWT 认证中间件（从 HttpOnly Cookie `momoi_token` 提取 JWT） |

## 接口契约

### 通用要求

所有端点均挂载 `userAuthMiddleware`：必须携带有效 JWT（经 HttpOnly Cookie `momoi_token`），缺失 → 401，无效 → 401。

### GET /api/conversations

列出当前用户的所有对话（按 `updated_at` 降序）。

**响应**：
```json
{
  "conversations": [
    {
      "id": "uuid",
      "title": "对话标题",
      "agent_id": "agent-uuid",
      "type": "direct",
      "agent_count": 0,
      "created_at": 1700000000,
      "updated_at": 1700000100
    }
  ]
}
```

> 响应中不含 `user_id`（由 `Conversation` 类型约定），但 DB 行本身有该列。群聊对话的 `type` 为 `group`，`agent_count` 为群组成员数。

### GET /api/conversations/:id

获取对话详情及其所有消息。

**响应**：
```json
{
  "conversation": { "id": "...", "title": "...", "user_id": "...", "agent_id": "", "type": "direct", "created_at": ..., "updated_at": ..., "deleted_at": null },
  "messages": [
    {
      "id": 1,
      "role": "user",
      "content": "消息内容",
      "thinking": null,
      "tool_calls": null,
      "tool_call_id": null,
      "suggestions": null,
      "attachments": null,
      "agent_id": null,
      "created_at": 1700000000
    }
  ],
  "agents": null
}
```

**反序列化**：`tool_calls`、`suggestions`、`attachments` 三列从 JSON 字符串解析为对象/数组，为 null 时返回 null。群聊对话额外返回 `agents` 字段（群组成员列表）。

**权限**：查询条件为 `id` **且** `user_id`，不属于当前用户或不存在均返回 404（不区分，避免探测资源存在性）。

### POST /api/conversations

创建新对话。

**请求**：
```json
{ "title": "可选标题", "agent_id": "可选-Agent ID", "type": "direct | group", "agent_ids": ["可选-群聊Agent ID列表"] }
```

**响应**（状态码 **201**）：
```json
{ "conversation": { "id": "生成的UUID", "title": "...", "user_id": "...", "agent_id": "", "type": "direct", "created_at": ..., "updated_at": ..., "deleted_at": null } }
```

**默认标题**：未提供或为空时，直接对话使用 `New Chat`，群聊使用 `群组对话`。

### PATCH /api/conversations/:id

重命名对话。

**请求**：`{ "title": "新标题" }`
**响应**：`{ "conversation": { ... } }`（更新后的对话对象）
**权限**：需为当前用户的对话，否则不更新（查询条件含 `user_id`）。

> ✅ **已修复（信息泄露）**：曾存在缺陷 —— `PATCH` 的 update 带 `user_id` 条件（越权改不动数据），但操作后不校验影响行数、末尾 `SELECT` 回显**只按 `id` 查未带 `user_id`**，导致 bob 对 alice 的对话发 PATCH 会拿到 200 + alice 的完整对话对象（写失败却回显他人资源）。现已将回显 `SELECT` 补上 `user_id` 条件并在查不到时返回 404。实测：bob PATCH alice 对话 → `404 {"error":"Not found"}`；owner 改自己 → `200` 且标题确实更新。

### DELETE /api/conversations/:id

删除对话（级联删除所有消息）。

**响应**：`{ "success": true }`
**权限**：删除条件含 `user_id`，越权删除不生效。

### DELETE /api/conversations/:id/messages/:messageId

**消息回退**：删除指定消息及其之后的所有消息。

**行为**：
1. 校验对话属于当前用户 → 否则 404 `Not found`
2. 校验消息属于该对话 → 否则 404 `Message not found`
3. 删除条件：`conversation_id = :id AND id >= :messageId`
4. 刷新 `conversations.updated_at`

**响应**：`{ "success": true }`

**依据**：`messages.id` 为自增主键，故 `id >= messageId` 等价于「该条及其后所有消息」。**不使用 `created_at >= X` 比较** —— Unix 秒级时间戳在同一秒内写入的多条消息无法区分顺序，用自增 ID 才可靠。

**客户端配合**（`useChat.revertMessage`）：回退成功后返回被删消息的 `content`，供前端把文本填回输入框以便编辑重发；本地状态同步截断为 `prev.slice(0, index)`。UI 需二次确认。

## 数据库 Schema

```sql
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,                    -- UUID
  user_id TEXT NOT NULL DEFAULT '',       -- 用户名
  title TEXT NOT NULL DEFAULT '新对话',    -- 对话标题
  agent_id TEXT NOT NULL DEFAULT '',      -- 关联的 Agent ID
  type TEXT NOT NULL DEFAULT 'direct',    -- 对话类型：'direct' 或 'group'
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER                     -- 软删除时间戳，null 表示未删除
);
CREATE INDEX idx_conversations_user ON conversations(user_id, updated_at);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
  content TEXT NOT NULL DEFAULT '',
  thinking TEXT,
  tool_calls TEXT,
  tool_call_id TEXT,
  suggestions TEXT,
  attachments TEXT,
  agent_id TEXT,                         -- 发送消息的 Agent ID（群聊中区分发言人）
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, created_at);
```

## 行为约束

1. **用户隔离**：所有查询都带 `user_id` 过滤条件
2. **软删除**：`DELETE` 操作设置 `deleted_at` 时间戳，不物理删除记录。查询时附加 `deleted_at IS NULL` 条件
3. **更新时间**：每次发送消息时更新 `updated_at`（在 `chat.ts` 中处理）
4. **默认标题**：Schema 默认为 `新对话`；但 `chat.ts` 与 `conversations.ts` 的创建路径实际写入消息前 40 字符或 `New Chat`（群聊为 `群组对话`）
5. **排序**：列表按 `updated_at` 降序，消息按 `created_at` 升序
6. **群聊创建**：`POST /api/conversations` 支持 `type: 'group'` 和 `agent_ids` 参数，创建对话后写入 `group_conversation_agents` 关联表

## 验收标准

1. 用户 A 无法通过任何端点读取或修改用户 B 的对话
2. 删除对话后其消息仍保留在库中（软删除），查询时被过滤
3. 回退后再次 `GET` 该对话，被删消息及其后续均不存在，时间戳早于回退点的消息保持原顺序
4. 迁移对已存在的旧库能补齐新列（`agent_id`、`type`、`deleted_at`、`agent_id` on messages）
