# Spec — Agent 系统（Agent）

## 概述

Agent 是独立配置的 AI 角色，每个 Agent 拥有独立的模型、系统提示词、头像和角色。系统内置默认 Agent 和中立 Agent，管理员可增删自定义 Agent。对话通过 `agent_id` 关联 Agent，群聊通过 `group_conversation_agents` 关联多个 Agent。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `packages/shared/src/types.ts` | Agent 类型定义 |
| `packages/shared/src/constants.ts` | 默认 Agent 常量（名称、ID、模型、提示词） |
| `apps/server/src/schema.ts` | agents 表 Drizzle 定义 + group_conversation_agents 关联表 |
| `apps/server/src/lib/config.ts` | Agent CRUD 函数 + `bootstrapAgents()` 引导逻辑 |
| `apps/server/src/routes/admin.ts` | Agent 管理 API 端点 |
| `apps/server/src/ai/models.ts` | 上游模型目录聚合（custom / workbuddy） |
| `apps/server/src/ai/workbuddy/models.ts` | WorkBuddy 云端模型目录拉取 |
| `apps/web/src/components/admin/tabs/AgentManager.tsx` | Agent 管理面板前端组件 |
| `apps/web/src/components/admin/tabs/ModelPicker.tsx` | 模型下拉（目录 + 自定义输入） |

## 数据模型

### Agent 接口

```typescript
interface Agent {
  id: string           // UUID，中立 Agent 固定为 "neutral-agent"
  name: string         // 显示名称
  model: string        // 模型名称（如 gpt-4o、deepseek-v4-flash）
  system_prompt: string // 系统提示词
  avatar: string       // 头像（base64 data URL 或空字符串）
  standing_art: string // 立绘（base64 data URL 或 URL；空串 = 未配置，聊天布局不变）
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
  standing_art TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'default',
  voice_enabled INTEGER NOT NULL DEFAULT 0,
  voice_sample_url TEXT NOT NULL DEFAULT '',
  voice_settings TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
```

Drizzle 定义（`apps/server/src/schema.ts`）：

```typescript
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  name: text('name').notNull().default(''),
  model: text('model').notNull().default(''),
  system_prompt: text('system_prompt').notNull().default(''),
  avatar: text('avatar').notNull().default(''),
  standing_art: text('standing_art').notNull().default(''),
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

- 首次启动时由 `bootstrapAgents()` 自动创建
- 名称默认 `DEFAULT_AGENT_NAME`（"Momoi"），模型默认 `DEFAULT_AGENT_MODEL`（"gpt-4o"）
- 可编辑、可删除
- 单 Agent 对话（`type: 'direct'`）的默认选择

### 中立 Agent（role: 'neutral'）

- 固定 ID：`NEUTRAL_AGENT_ID`（`"neutral-agent"`）
- 名称：`NEUTRAL_AGENT_NAME`（`"中立 Agent"`）
- 首次启动时由 `bootstrapAgents()` 自动创建，复用默认 Agent 的模型
- 创建时 system_prompt、avatar、standing_art 均为空字符串
- 特殊约束：
  - **不可删除**：路由层直接检查 `NEUTRAL_AGENT_ID`，返回 403
  - **不可改名/换头像/换立绘**：PUT 请求中 `name`、`avatar`、`standing_art` 字段被路由层静默剥离（`delete body.name; delete body.avatar; delete body.standing_art`）
  - 仅可修改 `model` 和 `system_prompt`
- 用途：无限演算模式中生成追问（`follow_up` 事件）、每轮回复完成后的追问建议（`suggestions` 事件，单聊与群聊通用，无限模式除外）及群聊每轮开始前的参与成员裁决（静默，无 SSE 事件）；中立 Agent 本身不在群成员名册内

## 引导逻辑

`bootstrapAgents()` 在服务启动时（`index.ts`）调用，执行流程：

```
bootstrapAgents()
  → listAgents() 获取已有 Agent
  → 中立 Agent 缺失？→ createAgent({ name: NEUTRAL_AGENT_NAME, model: env.OPENAI_MODEL, role: 'neutral' })
  → 无任何非中立 Agent？→ createAgent({ name: 'Momoi', model: env.OPENAI_MODEL })
```

关键细节：
- `bootstrapAgents()` 仅补建缺失的 Agent，已有数据跳过（幂等）
- 中立 Agent 的 system_prompt、avatar、standing_art 为空，复用默认 Agent 的模型
- 引导仅执行一次（所需 Agent 均存在时跳过），后续管理员通过 CRUD 管理

## Agent CRUD

所有函数位于 `apps/server/src/config.ts`，均返回 `Promise`。

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

### createAgent(opts)

创建新 Agent。参数为单一对象（原先 9 个位置参数在扩展立绘时已达可读性上限，改为对象传递——新增字段不再打乱既有顺序，调用点只写关心的字段）。

```typescript
export interface CreateAgentOptions {
  name: string
  model: string
  systemPrompt?: string   // 默认 ''
  avatar?: string         // 默认 ''
  role?: Agent['role']    // 默认 'default'
  voiceEnabled?: boolean  // 默认 false
  voiceSampleUrl?: string // 默认 ''
  voiceSettings?: string  // 默认 '{}'
  standingArt?: string    // 默认 ''
  idOverride?: string     // 配置导入按原 ID 重建（保持跨实例 agent_id 引用）
}
export async function createAgent(opts: CreateAgentOptions): Promise<Agent>
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
  partial: Partial<Pick<Agent, 'name' | 'model' | 'system_prompt' | 'avatar' | 'standing_art'>>
): Promise<Agent | null>
```

- 先 `getAgent(id)` 检查存在性，不存在返回 `null`
- 仅更新 `partial` 中非 `undefined` 的字段
- 更新后重新读取并返回完整 Agent
- 中立 Agent 的 name/avatar/standing_art 保护在路由层实现（`updateAgent` 函数本身不区分角色）

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

所有端点挂载于 `/api/admin/agents`，需管理员权限（用户 JWT + `ADMIN` 名单校验，`adminAuthMiddleware`）。

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
  "avatar": "data:image/png;base64,...",
  "standing_art": "data:image/png;base64,..."
}
```

- `name` 必填，空白字符串 → 400
- `model`、`system_prompt`、`avatar`、`standing_art` 可选，缺失时为空字符串
- `avatar` / `standing_art` 为 data URL 且图床开关开启时，会先转 CDN 再落库（失败保留原值，不阻塞保存）

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
  "avatar": "data:image/png;base64,...",
  "standing_art": "data:image/png;base64,..."
}
```

- 所有字段均为可选，仅更新提供的字段
- `standing_art: ""` 表示清除立绘
- 中立 Agent（`id === NEUTRAL_AGENT_ID`）：`name`、`avatar`、`standing_art` 在路由层被 `delete` 移除，不被传入 `updateAgent()`

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

## 立绘（standing_art）

除头像外，每个非中立 Agent 可配置一张**立绘**——用于单聊聊天区上半部分展示的角色大图。

### 字段语义

- `standing_art`: `string`，空串表示未配置。取值与 `avatar` 同构：base64 data URL 或 http(s) URL。
- 图床开关（`use_external_image_hosting`，默认开）开启时，保存阶段的 data URL 会转 CDN，只存短 URL。
- **中立 Agent 不可配置**：路由层 `delete body.standing_art`，配置导入层也会忽略（warning）。
- 配置导入导出：`standing_art` 在 `AGENT_KEYS` 白名单内，随 Agent 段导出/导入；非法值（非 data:image / 非 http(s)）拒绝并报 `CONFIG_IMPORT_BAD_IMAGE_URL`（`params.field = 'standing_art'`）。

### 展示规则

| 条件 | 行为 |
|---|---|
| 单聊 + 当前 Agent 有立绘 + **已有对话** | 立绘排版区贯穿 top-bar 底到视窗底，**只显示上部 40%** 并在下缘渐隐；消息区从 40% 处开始滚动 |
| 单聊 + **新会话（空态）** | 不显示立绘，保持原有居中布局 |
| 单聊 + 未配置立绘 | 完全走原有全屏滚动布局（零差异） |
| 群聊 / 世界模拟 | 不展示立绘（无唯一「当前角色」） |

- 立绘**独立占据空间**：消息气泡不可能浮于立绘之上（消息滚动区的顶部被硬性约束在分割线以下）。
- 按 **cover** 渲染：自动扫描图片 alpha 通道，求出非空像素团的包围盒，把它的**上沿对齐 top-bar 底部（60px）、下沿对齐视窗底**——图片自带的透明留白会被裁掉，人物从头顶到脚底贯穿整段排版区（见下方「渲染算法」）。
- 排版区 = 从 top-bar 底到视窗底；但**只显示这块区域的上部 40%**，且下缘带**渐隐**（`mask-image` 渐变，终点精确落在 40% 线上，与消息区顶对齐）。
- 不加柔边遮罩：cover 填充后已无非空留白，遮罩只会让边缘发虚、削掉头顶。
- 小屏（`isMobile`，即视口宽 < 768）高度为 `min(40%, max(180px, calc(100% - 420px)))`——保证下方消息区不少于 ~420px；桌面为 `clamp(220px, 40%, 520px)`。
- 立绘加载失败时仅不渲染图片，占位空间保留，避免布局跳变。

### 渲染算法（`StandingArt.tsx`）

1. 用 canvas 采样图片（长边缩到 512px），逐行扫描 alpha > 16 的像素，得到内容包围盒 `top/bottom`；
2. 缩放比 `scale = 排版区高 / 内容高` —— 内容上沿贴 top-bar 底部、下沿贴视窗底；宽度溢出由 `overflow: hidden` 左右裁切，不足则两侧留空；
3. 水平居中内容，垂直方向 `y = -内容顶 × scale`。

**边界情况**：
- **跨域污染**：图床（`cloudflareimg.cdn.sn`）不返回 CORS 头，因此**不能**设 `crossOrigin='anonymous'`（会导致图片直接加载失败）。不设时图片正常显示，但跨域画布被污染、`getImageData` 抛 `SecurityError` —— 此时降级为标准 cover（取宽高缩放比更大者铺满容器并居中）。
- 整张图全透明、解码失败：同样走整图 cover 降级。
- 加载失败（404 等）：只隐藏图片，占位空间保留，不引起布局跳变。

> 注意：看到的构图取决于立绘图本身。图里画的是全身，就会完整显示全身；只画上半身，则上半身撑满立绘区。

布局实现细节见 `docs/specs/module-chat.md` 的「单聊立绘布局」章节。

## 模型目录与选择

Agent 表单的「模型」是下拉框，打开表单时调用 `GET /api/admin/gateway/models`（`adminAuthMiddleware`）获取**当前上游派发**的模型目录：

| 上游类型 | 目录来源 |
|---|---|
| `custom` | `GET {api_endpoint}/models`（OpenAI 兼容；`api_key` 非空时带 `Authorization: Bearer …`） |
| `workbuddy` | WorkBuddy 云端目录 `GET {WORKBUDDY_BASE_URL}/v2/enterprises/personal/models`（需已登录，401/403 强制续期后重试一次） |

**响应**：
```json
{
  "source": "workbuddy",
  "models": [
    { "id": "glm-5.3", "name": "GLM-5.3", "vendor": "GLM" }
  ],
  "warning": "not_logged_in",
  "detail": "目录拉取失败时的上游原始错误摘要（排查用）"
}
```

- 归一化：去重、丢弃空 id、过滤 `tags` 含 `text-to-image` 的模型；`name` 与 `id` 相同时省略
- **失败不报错**：目录拉取异常一律返回 `models: []` + `warning`（`not_logged_in` / `upstream_error`），下拉回退为手动输入——模型选择不能成为保存 Agent 的前置条件
- 前端 `ModelPicker`：目录为空、或当前模型不在目录内时自动切到「自定义」输入框；当前值命中目录则显示为选中项；右上角刷新按钮重新拉取
- 保存仍只提交 `agent.model` 字符串，服务端不校验模型是否在目录内（上游可能随时增删模型，历史 Agent 必须始终可编辑）

## 行为约束

1. 默认 Agent 由 `bootstrapAgents()` 在首次启动时自动创建，无需手动配置
2. 中立 Agent 不可删除、不可改名/换头像 —— 由路由层在 handler 内强制，而非 CRUD 函数层
3. 中立 Agent 的 name/avatar/standing_art 保护逻辑：路由层先 `delete body.name; delete body.avatar; delete body.standing_art`，再调用 `updateAgent()`，因此 CRUD 函数本身不感知角色差异
4. 每个 Agent 独立配置，互不干扰
5. 对话通过 `conversations.agent_id` 关联 Agent（单 Agent 对话）
6. 群聊对话通过 `group_conversation_agents` 关联多个 Agent，`sort_order` 控制排序
7. 删除 Agent 时，`group_conversation_agents` 中的关联记录通过外键 `ON DELETE CASCADE` 自动清理
8. Agent 删除后不影响已有对话历史（对话记录存储在 `messages` 表中，通过 `conversation_id` 关联，不直接依赖 Agent）

## 验收标准

1. 首次启动自动创建默认 Agent（名称 "Momoi"）和中立 Agent（名称 "中立 Agent"），`bootstrapAgents()` 幂等
2. 管理员可创建/编辑/删除自定义 Agent
3. 中立 Agent 不可删除（DELETE 返回 403）
4. 中立 Agent 不可改名（PUT 中 name 被静默剥离，更新后名称不变）
5. 中立 Agent 不可换头像/立绘（PUT 中 avatar、standing_art 被静默剥离，更新后不变）
6. 立绘仅单聊生效；群聊与世界模拟不展示，且未配置立绘时聊天布局与改动前完全一致
6. 中立 Agent 的 model 和 system_prompt 可正常修改
7. Agent 删除后不影响已有对话历史
8. 旧版本全局配置（settings 表中的 model/system_prompt）自动迁移到默认 Agent
9. 编辑/创建 Agent 时模型为下拉框，选项来自当前上游派发的目录；选中即写入 `model`
10. 目录拉取失败或需要目录外的模型名时，选「自定义」可手动填写并正常保存
11. 已保存但不在当前目录内的模型（上游已下线 / 切换了上游）在编辑时仍可见、不被清空