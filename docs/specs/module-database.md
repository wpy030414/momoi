# Spec — 数据库与数据层（Database & Data Layer）

## 概述

数据层使用 SQLite 单文件数据库，通过 `@libsql/client` 连接、Drizzle ORM 操作。所有对话历史、配置、PIN 哈希等都存储在 `data/momoi.db` 中。迁移策略采用轻量级 PRAGMA 预检 + `CREATE IF NOT EXISTS`，避免引入外部迁移工具。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/server/db.ts` | 数据库客户端初始化 + 迁移逻辑 |
| `src/server/schema.ts` | Drizzle ORM 表定义（conversations / messages / settings） |
| `src/server/routes/*.ts` | 各路由通过 `db` 查询数据 |

## 数据库位置与初始化

- **路径**：`data/momoi.db`（相对于项目根目录）
- **创建时机**：`db.ts` 导入时自动创建 `data/` 目录和数据库文件
- **连接方式**：`file:` 协议本地文件，无需网络

```typescript
const dataDir = path.resolve('data')
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
const dbPath = path.join(dataDir, 'momoi.db')
const client = createClient({ url: `file:${dbPath}` })
```

## 表结构

### conversations — 对话

| 列名 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID v4 |
| `user_id` | TEXT | NOT NULL, DEFAULT '' | 用户名（JWT sub） |
| `title` | TEXT | NOT NULL, DEFAULT '新对话' | 对话标题（默认取消息前 40 字符） |
| `created_at` | INTEGER | NOT NULL | Unix epoch 秒 |
| `updated_at` | INTEGER | NOT NULL | Unix epoch 秒 |

**索引**：`idx_conversations_user` ON `(user_id, updated_at)` — 按用户排序查询

### messages — 消息

| 列名 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | INTEGER | PRIMARY KEY, AUTOINCREMENT | 自增主键 |
| `conversation_id` | TEXT | NOT NULL, FK → conversations(id) ON DELETE CASCADE | 所属对话 |
| `role` | TEXT | NOT NULL, CHECK(role IN ('user','assistant','system','tool')) | 消息角色 |
| `content` | TEXT | NOT NULL, DEFAULT '' | 消息正文 |
| `thinking` | TEXT | — | AI 思考过程（可选） |
| `tool_calls` | TEXT | — | JSON 序列化的工具调用数组 |
| `tool_call_id` | TEXT | — | 工具响应关联的调用 ID |
| `suggestions` | TEXT | — | JSON 序列化的建议数组 |
| `attachments` | TEXT | — | JSON 序列化的附件/产物数组 |
| `created_at` | INTEGER | NOT NULL | Unix epoch 秒 |

**索引**：`idx_messages_conv` ON `(conversation_id, created_at)` — 按对话排序查询

**外键约束**：`ON DELETE CASCADE` 确保删除对话时自动清理消息。`@libsql/client` 默认启用外键（`PRAGMA foreign_keys = ON`）。

### settings — 配置（键值存储）

| 列名 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `key` | TEXT | PRIMARY KEY | 配置键，如 `app_name`、`pin:{username}` |
| `value` | TEXT | NOT NULL, DEFAULT '' | 配置值 |

**用途**：存储运行时配置（`app_name`、`api_endpoint`、`api_key`、`model`、`system_prompt`、`support_attachments`、`show_github`）和用户 PIN 哈希（`pin:{username}`）。

## Drizzle Schema 定义

```typescript
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull().default(''),
  title: text('title').notNull().default('新对话'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
})

export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  conversation_id: text('conversation_id').notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['user', 'assistant', 'system', 'tool'] }).notNull(),
  content: text('content').notNull().default(''),
  thinking: text('thinking'),
  tool_calls: text('tool_calls'),
  tool_call_id: text('tool_call_id'),
  suggestions: text('suggestions'),
  attachments: text('attachments'),
  created_at: integer('created_at').notNull(),
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull().default(''),
})
```

## 迁移策略

**设计原则**：零外部迁移工具，`CREATE TABLE IF NOT EXISTS` 一步到位，不兼容旧库。

### 迁移流程（`db.ts:migrate()`）

```
1. CREATE TABLE IF NOT EXISTS（含全部当前列）
   → conversations（id, user_id, title, agent_id, type, created_at, updated_at）
   → messages（id, conversation_id, role, content, thinking, tool_calls, tool_call_id, suggestions, attachments, agent_id, created_at）
   → settings（key, value）
   → agents（id, name, model, system_prompt, avatar, created_at）
   → group_conversation_agents（conversation_id, agent_id, sort_order）

2. CREATE INDEX IF NOT EXISTS
   → idx_messages_conv
   → idx_conversations_user
   → idx_group_conv_agents_conv
```

**不提供旧库兼容**：无 PRAGMA 预检、无 ALTER TABLE 回填。旧库缺列直接运行时出错，删库重建即可。

## 查询模式

### 用户隔离（认证 ≠ 授权）

所有对话相关查询必须同时校验 `user_id`，防止越权：

```typescript
// 正确：查询条件同时包含 id 和 user_id
db.select().from(conversations)
  .where(and(eq(conversations.id, id), eq(conversations.user_id, userId)))
  .get()

// 错误：只查 id 不查 user_id（会泄露他人数据）
db.select().from(conversations).where(eq(conversations.id, id)).get()
```

### 越权处理

- 不匹配 `user_id` → 一律返回 `404 Not found`（不区分「不存在」和「无权访问」）
- 该原则适用于 `GET /:id`、`PATCH /:id`、`DELETE /:id`、`DELETE /:id/messages/:messageId`

### 消息回退

```typescript
// 利用自增 ID 的顺序性，删除目标消息及其之后所有消息
db.delete(messages).where(and(
  eq(messages.conversation_id, convId),
  gte(messages.id, messageId),
)).run()
```

**不使用 `created_at >= X` 的原因**：Unix 秒级时间戳在同一秒内写入的多条消息无法区分顺序，自增 ID 才可靠。

### JSON 列反序列化

`tool_calls`、`suggestions`、`attachments` 三列以 JSON 字符串存储，查询时按需解析：

```typescript
const msg = {
  ...raw,
  tool_calls: raw.tool_calls ? JSON.parse(raw.tool_calls) : null,
  suggestions: raw.suggestions ? JSON.parse(raw.suggestions) : null,
  attachments: raw.attachments ? JSON.parse(raw.attachments) : null,
}
```

## 工作区清理

删除对话时同步清理对应的工作区目录：

```typescript
// routes/conversations.ts
await db.delete(conversations).where(and(eq(conversations.id, id), eq(conversations.user_id, userId))).run()

const wsPath = path.resolve('data', 'workspaces', id)
if (fs.existsSync(wsPath)) {
  fs.rmSync(wsPath, { recursive: true, force: true })
}
```

## 外部依赖

- **`@libsql/client`**：SQLite 数据库客户端（原生模块，无需编译）
- **`drizzle-orm`**：TypeScript ORM（类型安全的查询构建器）
- **`drizzle-kit`**（devDependency）：仅用于生成类型定义，不用于迁移

## 验收标准

1. 首次启动自动创建 `data/` 目录和 `.db` 文件 ✅
2. 重复启动不报错（`IF NOT EXISTS` 保护）✅
3. 删除对话级联删除消息 ✅
4. 删除对话同步清理工作区 ✅
5. 用户 A 无法访问用户 B 的数据（404 而非 403）✅
6. 消息回退后序消息正确删除 ✅
7. JSON 列读写一致（序列化/反序列化无数据丢失）✅