# Spec -- 数据库与数据层（Database & Data Layer）

## 概述

数据层支持两种模式：

- **本地模式（默认）**：SQLite 单文件数据库，通过 `sql.js`（WebAssembly 编译的 SQLite）在 Node.js 进程中直接操作，无需原生模块编译。Drizzle ORM 提供类型安全的查询构建。
- **远程模式**：PostgreSQL，当同时设置环境变量 `DATABASE_URL`、`DATABASE_USER`、`DATABASE_SECRET` 时自动启用，连接池上限 5。

所有对话历史、配置、PIN 哈希、Agent 信息、用户账号、OAuth 绑定、微信绑定、MCP 服务器配置等均持久化存储。迁移策略采用 `CREATE TABLE IF NOT EXISTS` 建表 + `ALTER TABLE ADD COLUMN`（try/catch 安全）做增量列迁移，不引入外部迁移工具。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/server/db.ts` | 数据库客户端初始化 + 方言选择 + 迁移逻辑 |
| `src/server/schema.ts` | Drizzle ORM SQLite 表定义（9 张表） |
| `src/server/schema.pg.ts` | Drizzle ORM PostgreSQL 表定义（9 张表） |
| `src/server/routes/*.ts` | 各路由通过 `db` 查询数据 |

## 数据库位置与初始化

### 本地 SQLite 模式

- **路径**：`data/momoi.db`（相对于项目根目录）
- **创建时机**：`db.ts` 导入时自动创建 `data/` 目录，若 `.db` 文件不存在则新建内存数据库并持久化
- **引擎**：`sql.js`（WebAssembly SQLite，无原生依赖）

```typescript
const initSqlJs = (await import('sql.js')).default
const { drizzle } = await import('drizzle-orm/sql-js')

const dataDir = path.resolve('data')
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
const dbPath = path.join(dataDir, 'momoi.db')

const SQL = await initSqlJs()
let sqlDb: any
if (fs.existsSync(dbPath)) {
  sqlDb = new SQL.Database(fs.readFileSync(dbPath))  // 加载已有库
} else {
  sqlDb = new SQL.Database()  // 新建
}
```

- **持久化**：每 30 秒自动 `fs.writeFileSync(dbPath, Buffer.from(sqlDb.export()))`；`SIGINT`/`SIGTERM` 时立即落盘
- **外键**：sql.js 默认不强制外键——删表由路由层手动级联处理

### 远程 PostgreSQL 模式

通过以下三个环境变量**同时**存在且 `DATABASE_URL` 以 `postgres://` 或 `postgresql://` 开头时触发：

| 环境变量 | 说明 |
|---|---|
| `DATABASE_URL` | PostgreSQL 连接地址（scheme 仅支持 `postgres://` / `postgresql://`） |
| `DATABASE_USER` | 用户名（若 URL 未含则注入） |
| `DATABASE_SECRET` | 密码（若 URL 未含则注入） |

- **引擎**：`pg`（`node-postgres`）+ `drizzle-orm/node-postgres`
- **连接池**：`max: 5`
- **Schema 表结构**：使用独立的 `schema.pg.ts`（类型：`boolean` 替代 INTEGER 0/1，`SERIAL` 替代 AUTOINCREMENT，`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` 替代 try/catch）

> 注意：PostgreSQL 驱动需手动安装 `pnpm add pg`，不内置在依赖中。

## 表结构

### conversations — 对话

| 列名 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | UUID v4 |
| `user_id` | TEXT | NOT NULL, DEFAULT '' | 用户名（JWT sub） |
| `title` | TEXT | NOT NULL, DEFAULT '新对话' | 对话标题（默认取消息前 40 字符） |
| `agent_id` | TEXT | NOT NULL, DEFAULT '' | 关联的 Agent ID |
| `type` | TEXT | NOT NULL, DEFAULT 'direct' | 对话类型：`direct` 或 `group` |
| `created_at` | INTEGER | NOT NULL, DEFAULT (unixepoch()) | Unix epoch 秒（SQLite 端有默认值；Drizzle 端无默认值，由代码写入） |
| `updated_at` | INTEGER | NOT NULL, DEFAULT (unixepoch()) | Unix epoch 秒 |
| `deleted_at` | INTEGER | nullable | 软删除时间戳（Unix epoch 秒），null 表示未删除 |

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
| `agent_id` | TEXT | nullable | 发送消息的 Agent ID（群聊中区分发言人） |
| `created_at` | INTEGER | NOT NULL, DEFAULT (unixepoch()) | Unix epoch 秒（SQLite 端有默认值；Drizzle 端无默认值，由代码写入） |

**索引**：`idx_messages_conv` ON `(conversation_id, created_at)` — 按对话排序查询

> 注：PostgreSQL 模式下 `id` 为 `SERIAL`（自增整数），`role` 无 `CHECK` 约束，`created_at` 无默认值。

### settings — 配置（键值存储）

| 列名 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `key` | TEXT | PRIMARY KEY | 配置键，如 `app_name`、`direct_registration_open`、`jwt_secret` |
| `value` | TEXT | NOT NULL, DEFAULT '' | 配置值 |

**用途**：存储运行时配置（`app_name`、`api_endpoint`、`api_key`、`support_attachments`、`show_github`、`use_external_image_hosting`、`recommended_questions`、`oauth_providers`、`tts_api_endpoint`、`tts_provider`、`direct_registration_open`、`oauth_registration_open`）和 JWT 签名密钥（`jwt_secret`）。

> 注意：用户 PIN 哈希已从 `settings` 表（键 `pin:{username}`）迁移至独立的 `users` 表（`pin_hash` 列），见下方 `users` 表。

### agents — Agent 定义

| 列名 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | Agent 唯一 ID（中立 Agent 固定为 `neutral-agent`） |
| `name` | TEXT | NOT NULL, DEFAULT '' | Agent 名称 |
| `model` | TEXT | NOT NULL, DEFAULT '' | 使用的模型 |
| `system_prompt` | TEXT | NOT NULL, DEFAULT '' | 系统提示词 |
| `avatar` | TEXT | NOT NULL, DEFAULT '' | 头像（base64 data URL） |
| `role` | TEXT | NOT NULL, DEFAULT 'default' | 角色：`default` 或 `neutral` |
| `created_at` | INTEGER | NOT NULL, DEFAULT (unixepoch()) | Unix epoch 秒 |
| `voice_enabled` | INTEGER (SQLite) / BOOLEAN (PG) | NOT NULL, DEFAULT 0 / FALSE | 是否启用语音 |
| `voice_sample_url` | TEXT | NOT NULL, DEFAULT '' | 语音样本 URL |
| `voice_settings` | TEXT | NOT NULL, DEFAULT '{}' | JSON 序列化的语音参数（VoiceSettings） |

### group_conversation_agents — 群聊 Agent 关联

| 列名 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `conversation_id` | TEXT | NOT NULL, FK → conversations(id) ON DELETE CASCADE | 群聊对话 ID |
| `agent_id` | TEXT | NOT NULL, FK → agents(id) ON DELETE CASCADE | Agent ID |
| `sort_order` | INTEGER | NOT NULL, DEFAULT 0 | 排序序号 |

**主键**：`(conversation_id, agent_id)` 复合主键

**索引**：`idx_group_conv_agents_conv` ON `(conversation_id)` — 按对话查询群组成员

### users — 用户账号

| 列名 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `username` | TEXT | PRIMARY KEY | 用户名（全局唯一） |
| `pin_hash` | TEXT | NOT NULL, DEFAULT '' | PBKDF2 哈希串（格式 `{salt}:{hash}`），空字符串 = 未设置 PIN |
| `first_login_at` | INTEGER | NOT NULL | 首次登录 Unix epoch 秒 |
| `last_login_at` | INTEGER | NOT NULL | 最近登录 Unix epoch 秒 |
| `banned` | INTEGER (SQLite) / BOOLEAN (PG) | NOT NULL, DEFAULT 0 / FALSE | 是否被封禁 |

> 此表替代了此前 `settings` 表中 `pin:{username}` 键的设计，将用户身份数据集中管理。

### user_oauth_bindings — OAuth 绑定

| 列名 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | 绑定记录 UUID |
| `user_id` | TEXT | NOT NULL | 关联的本地用户名 |
| `provider_id` | TEXT | NOT NULL | OAuth 提供商标识 |
| `provider_user_id` | TEXT | NOT NULL | 在 OAuth 提供商端的用户 ID |
| `created_at` | INTEGER | NOT NULL | 绑定创建时间 Unix epoch 秒 |

**唯一约束**：`UNIQUE(provider_id, provider_user_id)` — 同一提供商下的同一外部账号只能绑定一个本地用户。

### wechat_bindings — 微信绑定

| 列名 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `user_id` | TEXT | PRIMARY KEY | 本地用户名 |
| `bot_token` | TEXT | NOT NULL, DEFAULT '' | 微信 Bot token |
| `wechat_user_id` | TEXT | NOT NULL, DEFAULT '' | 微信用户 ID |
| `conversation_id` | TEXT | NOT NULL, DEFAULT '' | 绑定的对话 ID |
| `pending_conversation_id` | TEXT | NOT NULL, DEFAULT '' | 待确认的对话 ID（会话转移协议） |
| `updates_buf` | TEXT | NOT NULL, DEFAULT '' | 更新缓冲区（消息积压） |
| `session_expired` | INTEGER (SQLite) / BOOLEAN (PG) | NOT NULL, DEFAULT 0 / FALSE | 会话是否过期 |
| `created_at` | INTEGER | NOT NULL, DEFAULT (unixepoch()) | 绑定创建时间 Unix epoch 秒 |

### mcp_servers — MCP 服务器配置

| 列名 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | TEXT | PRIMARY KEY | MCP 服务器 UUID |
| `name` | TEXT | NOT NULL, DEFAULT '' | 服务器名称 |
| `url` | TEXT | NOT NULL, DEFAULT '' | 服务器 URL |
| `enabled` | INTEGER (SQLite) / BOOLEAN (PG) | NOT NULL, DEFAULT 1 / TRUE | 是否启用 |
| `created_at` | INTEGER | NOT NULL, DEFAULT (unixepoch()) | 创建时间 Unix epoch 秒 |

## Drizzle Schema 定义

```typescript
// ---- SQLite (schema.ts) ----

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull().default(''),
  title: text('title').notNull().default('新对话'),
  agent_id: text('agent_id').notNull().default(''),
  type: text('type').notNull().default('direct'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
  deleted_at: integer('deleted_at'),
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
  agent_id: text('agent_id'),
  created_at: integer('created_at').notNull(),
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull().default(''),
})

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull().default(''),
  model: text('model').notNull().default(''),
  system_prompt: text('system_prompt').notNull().default(''),
  avatar: text('avatar').notNull().default(''),
  role: text('role').notNull().default('default'),
  created_at: integer('created_at').notNull(),
  voice_enabled: integer('voice_enabled', { mode: 'boolean' }).notNull().default(false),
  voice_sample_url: text('voice_sample_url').notNull().default(''),
  voice_settings: text('voice_settings').notNull().default('{}'),
})

export const groupConversationAgents = sqliteTable('group_conversation_agents', {
  conversation_id: text('conversation_id').notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  agent_id: text('agent_id').notNull()
    .references(() => agents.id, { onDelete: 'cascade' }),
  sort_order: integer('sort_order').notNull().default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.conversation_id, table.agent_id] }),
}))

export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull().default(''),
  url: text('url').notNull().default(''),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  created_at: integer('created_at').notNull(),
})

export const users = sqliteTable('users', {
  username: text('username').primaryKey(),
  pin_hash: text('pin_hash').notNull().default(''),
  first_login_at: integer('first_login_at').notNull(),
  last_login_at: integer('last_login_at').notNull(),
  banned: integer('banned', { mode: 'boolean' }).notNull().default(false),
})

export const userOauthBindings = sqliteTable('user_oauth_bindings', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull(),
  provider_id: text('provider_id').notNull(),
  provider_user_id: text('provider_user_id').notNull(),
  created_at: integer('created_at').notNull(),
})

export const wechatBindings = sqliteTable('wechat_bindings', {
  user_id: text('user_id').primaryKey(),
  bot_token: text('bot_token').notNull().default(''),
  wechat_user_id: text('wechat_user_id').notNull().default(''),
  conversation_id: text('conversation_id').notNull().default(''),
  pending_conversation_id: text('pending_conversation_id').notNull().default(''),
  updates_buf: text('updates_buf').notNull().default(''),
  session_expired: integer('session_expired', { mode: 'boolean' }).notNull().default(false),
  created_at: integer('created_at').notNull(),
})
```

PostgreSQL 版本（`schema.pg.ts`）与上面对应，差异点：
- `INTEGER AUTOINCREMENT` → `serial('id').primaryKey()`
- `integer(..., { mode: 'boolean' })` → `boolean(...)`
- Drizzle 类型从 `sqliteTable` → `pgTable`

## 迁移策略

**设计原则**：零外部迁移工具。DDL 全部写在 `db.ts` 内，`CREATE TABLE IF NOT EXISTS` 建表 + `ALTER TABLE ADD COLUMN`（try/catch 容忍已存在列）做增量列迁移。

### 迁移流程（`db.ts`）

**SQLite 路径**：

1. 加载或创建 `sql.js` 数据库
2. `sqlDb.run(MIGRATION_SQL)` 执行全部 DDL（9 张表 + 3 个索引），`IF NOT EXISTS` 保证幂等
3. `ADDITIVE_MIGRATIONS` 数组：逐条 `ALTER TABLE agents ADD COLUMN ...`，外层 `try/catch` 吞掉 "column already exists" 错误——sql.js 不支持 `IF NOT EXISTS` 的 `ALTER` 语法，只能用 try/catch
4. 立即 `persist()` 落盘

**PostgreSQL 路径**：

1. 创建连接池
2. `pool.query(...)` 执行全部 DDL（9 张表 + 3 个索引 + 增量列迁移），PostgreSQL 原生支持 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`

**不提供跨方言兼容**：SQLite 和 PostgreSQL 的 Schema 文件独立维护（`schema.ts` / `schema.pg.ts`），无运行时方言转换。

**不提供旧库兼容**：无 PRAGMA 预检、无 ALTER TABLE 回填。旧库缺列直接运行时出错，删库重建即可。

### 增量列迁移清单

当前 `ADDITIVE_MIGRATIONS`（SQLite 侧）包含以下 `ALTER TABLE agents ADD COLUMN`：

| 列 | 类型 | 默认值 |
|---|---|---|
| `voice_enabled` | INTEGER | 0 |
| `voice_sample_url` | TEXT | '' |
| `voice_settings` | TEXT | '{}' |

PostgreSQL 侧使用 `ADD COLUMN IF NOT EXISTS`，相同列定义但类型为 `BOOLEAN` / `TEXT`。

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

### 软删除

`conversations` 表使用 `deleted_at` 字段实现软删除。查询时需附加 `deleted_at IS NULL` 条件：

```typescript
db.select().from(conversations)
  .where(and(eq(conversations.user_id, userId), sql`${conversations.deleted_at} IS NULL`))
```

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

### 用户创建与登录追踪

`users` 表通过 `trackUserLogin()` 维护首次/最近登录时间：

- 用户首次出现时 INSERT（`pin_hash` 为空，表示未设置 PIN）
- 用户已有记录时 UPDATE `last_login_at`
- PIN 设置/修改通过 UPDATE `pin_hash` 完成

### 用户名重命名

`POST /api/user/rename` 级联更新 4 张表的 `user_id`/`username` 字段：

| 表 | 字段 |
|---|---|
| `users` | `username` (PK) |
| `conversations` | `user_id` |
| `user_oauth_bindings` | `user_id` |
| `wechat_bindings` | `user_id` |

## 工作区清理

删除对话时不再清理工作区目录（软删除保留数据）：

```typescript
// routes/conversations.ts — soft delete
await db.update(conversations)
  .set({ deleted_at: now, updated_at: now })
  .where(and(eq(conversations.id, id), eq(conversations.user_id, userId)))
  .run()
```

## 外部依赖

| 包 | 说明 |
|---|---|
| `sql.js` | SQLite WebAssembly 引擎（纯 JS，无需编译；本地模式必须） |
| `drizzle-orm` + `drizzle-orm/sql-js` | TypeScript ORM（SQLite 方言） |
| `pg` + `drizzle-orm/node-postgres` | PostgreSQL 驱动 + ORM 方言（远程模式可选，需手动安装） |
| `drizzle-kit`（devDependency） | 仅用于生成类型定义，不用于迁移 |

## 验收标准

1. 首次启动自动创建 `data/` 目录和 `.db` 文件
2. 重复启动不报错（`IF NOT EXISTS` 保护）
3. 删除对话软删除标记 `deleted_at`，不物理删除数据
4. 用户 A 无法访问用户 B 的数据（404 而非 403）
5. 消息回退后序消息正确删除
6. JSON 列读写一致（序列化/反序列化无数据丢失）
7. Agent 和群聊关联表正确建表
8. 设置 `DATABASE_URL` + `DATABASE_USER` + `DATABASE_SECRET` 后自动切换到 PostgreSQL
9. 旧 SQLite 数据库启动时，增量列迁移（`ALTER TABLE agents ADD COLUMN voice_*`）不报错
10. 用户名重命名级联更新所有关联表