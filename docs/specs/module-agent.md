# Spec — Agent 系统（Agent）

## 概述

Agent 是独立配置的 AI 角色，每个 Agent 拥有独立的模型、系统提示词、头像和角色。系统内置默认 Agent 和中立 Agent，管理员可增删自定义 Agent。对话通过 `agent_id` 关联 Agent，群聊通过 `group_conversation_agents` 关联多个 Agent。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/shared/types.ts` | Agent 类型定义 |
| `src/shared/constants.ts` | 默认 Agent 常量（名称、ID、模型、提示词） |
| `src/server/schema.ts` | agents 表 Drizzle 定义 + group_conversation_agents 关联表 |
| `src/server/config.ts` | Agent CRUD 函数 + `migrateDefaultAgent()` 迁移逻辑 |
| `src/server/routes/admin.ts` | Agent 管理 API 端点 |
| `src/client/components/admin/tabs/AgentManager.tsx` | Agent 管理面板前端组件 |

## 数据模型

### Agent 接口

```typescript
interface Agent {
  id: string           // UUID，中立 Agent 固定为 "neutral-agent"
  name: string         // 显示名称
  model: string        // 模型名称（如 gpt-4o、deepseek-v4-flash）
  system_prompt: string // 系统提示词
  avatar: string       // 头像（base64 data URL 或空字符串）
  role: 'default' | 'neutral'  // 角色类型
  created_at: number   // Unix epoch 秒
}
```

### 数据库 Schema

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER NOT NULL
);
```

Drizzle 定义（`src/server/schema.ts`）：

```typescript
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull().default(''),
  model: text('model').notNull().default(''),
  system_prompt: text('system_prompt').notNull().default(''),
  avatar: text('avatar').notNull().default(''),
  role: text('role').notNull().default('default'),
  created_at: integer('created_at').notNull(),
})
```

### 群聊关联表

```typescript
export const groupConversationAgents = sqliteTable('group_conversation_agents', {
  conversation_id: text('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  agent_id: text('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  sort_order: integer('sort_order').notNull().default(0),
}, (table) => ({
  pk: primaryKey({ columns: [table.conversation_id, table.agent_id] }),
}))
```

- `conversation_id` + `agent_id` 联合主键
- 外键级联删除：删除对话或 Agent 时自动清理关联记录
- `sort_order` 控制 Agent 在群聊中的排序

## 常量定义

| 常量 | 值 | 说明 |
|---|---|---|
| `DEFAULT_AGENT_NAME` | `'Momoi'` | 默认 Agent 显示名称 |
| `DEFAULT_AGENT_MODEL` | `'gpt-4o'` | 默认 Agent 模型 |
| `DEFAULT_AGENT_SYSTEM_PROMPT` | `''`（空字符串） | 默认系统提示词（空；追问建议由中立 Agent 在回复完成后单独生成，不注入普通 Agent 提示词） |
| `NEUTRAL_AGENT_NAME` | `'中立 Agent'` | 中立 Agent 显示名称 |
| `NEUTRAL_AGENT_ID` | `'neutral-agent'` | 中立 Agent 固定 ID |

## Agent 角色

### 默认 Agent（role: 'default'）

- 首次启动时由 `migrateDefaultAgent()` 自动创建
- 名称默认 `DEFAULT_AGENT_NAME`（"Momoi"），模型默认 `DEFAULT_AGENT_MODEL`（"gpt-4o"）
- 可编辑、可删除
- 单 Agent 对话（`type: 'direct'`）的默认选择

### 中立 Agent（role: 'neutral'）

- 固定 ID：`NEUTRAL_AGENT_ID`（`"neutral-agent"`）
- 名称：`NEUTRAL_AGENT_NAME`（`"中立 Agent"`）
- 首次启动时由 `migrateDefaultAgent()` 自动创建，复用默认 Agent 的模型
- 创建时 system_prompt 和 avatar 均为空字符串
- 特殊约束：
  - **不可删除**：路由层直接检查 `NEUTRAL_AGENT_ID`，返回 403
  - **不可改名/换头像**：PUT 请求中 `name` 和 `avatar` 字段被路由层静默剥离（`delete body.name; delete body.avatar`）
  - 仅可修改 `model` 和 `system_prompt`
- 用途：无限演算模式中生成追问（`follow_up` 事件）及每轮回复完成后的追问建议（`suggestions` 事件，单聊与群聊通用，无限模式除外）

## 迁移逻辑

`migrateDefaultAgent()` 在服务启动时（`index.ts`）调用，执行流程：

```
migrateDefaultAgent()
  → listAgents() 获取已有 Agent
  → 已有数据？→ 跳过（幂等）
  → 无数据：
    1. 从旧 settings 表读取 model 和 system_prompt（兼容旧版本全局配置）
       - model: getSetting('model', env.OPENAI_MODEL || DEFAULT_AGENT_MODEL)
       - prompt: getSetting('system_prompt', DEFAULT_AGENT_SYSTEM_PROMPT)
    2. createAgent(DEFAULT_AGENT_NAME, oldModel, oldPrompt)  → 创建默认 Agent
    3. createAgent(NEUTRAL_AGENT_NAME, oldModel, '', '', 'neutral')  → 创建中立 Agent
```

关键细节：
- 旧版本将 model 和 system_prompt 作为全局配置存储在 settings 表中，迁移时读取这些旧值创建默认 Agent，确保升级后行为一致
- 中立 Agent 的 system_prompt 和 avatar 为空，仅复用默认 Agent 的模型
- 迁移仅执行一次（`existingAgents.length > 0` 时跳过），后续管理员通过 CRUD 管理

## Agent CRUD

所有函数位于 `src/server/config.ts`，均返回 `Promise`。

### listAgents()

列出所有 Agent，按 `created_at` 升序排列。

```typescript
export async function listAgents(): Promise<Agent[]>
```

- 从 `agents` 表全量查询，`orderBy(agents.created_at)`
- 返回 `Agent[]`（空数组表示无 Agent）

### getAgent(id: string)

获取单个 Agent。

```typescript
export async function getAgent(id: string): Promise<Agent | null>
```

- 按 `id` 查询
- 不存在返回 `null`

### createAgent(name, model, systemPrompt, avatar?, role?)

创建新 Agent。

```typescript
export async function createAgent(
  name: string,
  model: string,
  systemPrompt: string,
  avatar?: string,       // 默认 ''
  role?: Agent['role']   // 默认 'default'
): Promise<Agent>
```

- `role === 'neutral'` → 使用固定 ID `NEUTRAL_AGENT_ID`
- 其他 → 使用 `randomUUID()` 生成 ID
- `created_at` 设为当前 Unix epoch 秒（`Math.floor(Date.now() / 1000)`）
- 返回完整 `Agent` 对象

### updateAgent(id, partial)

部分更新 Agent 字段。

```typescript
export async function updateAgent(
  id: string,
  partial: Partial<Pick<Agent, 'name' | 'model' | 'system_prompt' | 'avatar'>>
): Promise<Agent | null>
```

- 先 `getAgent(id)` 检查存在性，不存在返回 `null`
- 仅更新 `partial` 中非 `undefined` 的字段
- 更新后重新读取并返回完整 Agent
- 中立 Agent 的 name/avatar 保护在路由层实现（`updateAgent` 函数本身不区分角色）

### deleteAgent(id)

删除 Agent。

```typescript
export async function deleteAgent(id: string): Promise<boolean>
```

- 先 `getAgent(id)` 检查存在性，不存在返回 `false`
- 存在则 `db.delete(agents)` 删除
- 中立 Agent 删除保护在路由层实现（`deleteAgent` 函数本身不区分角色）
- 删除成功返回 `true`

## API 端点

所有端点挂载于 `/api/admin/agents`，需管理员 JWT（`adminAuthMiddleware`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/agents` | 列出所有 Agent |
| POST | `/api/admin/agents` | 创建 Agent |
| PUT | `/api/admin/agents/:id` | 更新 Agent |
| DELETE | `/api/admin/agents/:id` | 删除 Agent |

### GET /api/admin/agents

列出所有 Agent。

**响应**：
```json
{
  "agents": [
    {
      "id": "uuid-string",
      "name": "Momoi",
      "model": "gpt-4o",
      "system_prompt": "",
      "avatar": "",
      "role": "default",
      "created_at": 1700000000
    }
  ]
}
```

### POST /api/admin/agents

创建新 Agent。请求体字段与 `createAgent()` 参数对应。

**请求**：
```json
{
  "name": "Agent名",
  "model": "deepseek-v4-flash",
  "system_prompt": "你是一个有帮助的助手",
  "avatar": "data:image/png;base64,..."
}
```

- `name` 必填，空白字符串 → 400
- `model`、`system_prompt`、`avatar` 可选，缺失时为空字符串

**响应**：`{ "agent": { ... } }`（完整 Agent 对象）

**错误**：

| 情况 | 状态码 |
|---|---|
| `name` 为空或纯空白 | 400 `Agent name is required` |

### PUT /api/admin/agents/:id

部分更新 Agent。

**请求**：
```json
{
  "name": "新名称",
  "model": "gpt-4o",
  "system_prompt": "新提示词",
  "avatar": "data:image/png;base64,..."
}
```

- 所有字段均为可选，仅更新提供的字段
- 中立 Agent（`id === NEUTRAL_AGENT_ID`）：`name` 和 `avatar` 在路由层被 `delete` 移除，不被传入 `updateAgent()`

**响应**：`{ "agent": { ... } }`（更新后的完整 Agent 对象）

**错误**：

| 情况 | 状态码 |
|---|---|
| Agent 不存在 | 404 `Agent not found` |

### DELETE /api/admin/agents/:id

删除 Agent。

**错误**：

| 情况 | 状态码 |
|---|---|
| 中立 Agent（`id === NEUTRAL_AGENT_ID`） | 403 `Neutral agent cannot be deleted` |
| 其他 Agent 不存在 | 404 `Agent not found` |

**响应**：`{ "success": true }`

## 行为约束

1. 默认 Agent 由 `migrateDefaultAgent()` 在首次启动时自动创建，无需手动配置
2. 中立 Agent 不可删除、不可改名/换头像 —— 由路由层在 handler 内强制，而非 CRUD 函数层
3. 中立 Agent 的 name/avatar 保护逻辑：路由层先 `delete body.name; delete body.avatar`，再调用 `updateAgent()`，因此 CRUD 函数本身不感知角色差异
4. 每个 Agent 独立配置，互不干扰
5. 对话通过 `conversations.agent_id` 关联 Agent（单 Agent 对话）
6. 群聊对话通过 `group_conversation_agents` 关联多个 Agent，`sort_order` 控制排序
7. 删除 Agent 时，`group_conversation_agents` 中的关联记录通过外键 `ON DELETE CASCADE` 自动清理
8. Agent 删除后不影响已有对话历史（对话记录存储在 `messages` 表中，通过 `conversation_id` 关联，不直接依赖 Agent）

## 验收标准

1. 首次启动自动创建默认 Agent（名称 "Momoi"）和中立 Agent（名称 "中立 Agent"），`migrateDefaultAgent()` 幂等
2. 管理员可创建/编辑/删除自定义 Agent
3. 中立 Agent 不可删除（DELETE 返回 403）
4. 中立 Agent 不可改名（PUT 中 name 被静默剥离，更新后名称不变）
5. 中立 Agent 不可换头像（PUT 中 avatar 被静默剥离，更新后头像不变）
6. 中立 Agent 的 model 和 system_prompt 可正常修改
7. Agent 删除后不影响已有对话历史
8. 旧版本全局配置（settings 表中的 model/system_prompt）自动迁移到默认 Agent