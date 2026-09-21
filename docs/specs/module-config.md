# Spec — 配置系统（Config）

## 概述

配置系统采用双层架构：**.env 环境变量**作为启动时的默认值，**SQLite settings 表**作为运行时可热更新的覆盖层。管理员通过管理面板修改配置后立即生效，无需重启服务。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `apps/server/src/config.ts` | 环境变量读取 + DB 配置读写（`getConfig` / `updateConfig`） |
| `packages/shared/src/constants.ts` | 默认值常量 |
| `apps/server/src/routes/admin.ts` | 管理员 API 端点（`GET/PUT /api/admin/config`） |
| `apps/server/src/routes/app.ts` | 公开端点（`GET /api/app-name`，对外暴露品牌信息与 Agent 列表） |
| `apps/web/src/components/settings/AgentManager.tsx` | 管理面板中的 Agent 管理界面 |
| `apps/web/src/components/settings/GatewaySettings.tsx` | 管理面板中的网关配置界面 |
| `apps/web/src/components/admin/tabs/ExperienceSettings.tsx` | 体验配置界面（应用外观 + 首页推荐问题 + 聊天常用追问） |

## 配置层级

```
优先级（高 → 低）：
  1. SQLite settings 表（运行时可修改，立即生效）
  2. .env 环境变量（启动时读取，不可热更新）
  3. 代码中的默认值（shared/constants.ts）
```

### 读取流程

```typescript
async function getSetting(key: string, fallback: string): Promise<string> {
  const row = await db.select().from(settings).where(eq(settings.key, key)).get()
  return row?.value ?? fallback
}
```

- 每次调用 `getConfig()` 都从 DB 读取，确保热更新
- DB 中无对应行 → 回退到环境变量（`env` 对象）
- 环境变量未设置 → 回退到 `constants.ts` 的默认值

## 配置字段

| 字段名 | 类型 | 环境变量 | 代码默认值 | 说明 |
|---|---|---|---|---|
| `app_name` | string | — | `Momoi` | 应用名称（白标） |
| `app_favicon` | string | — | `""`（空=默认） | Favicon，base64 data URL |
| `app_background` | string | — | `""`（空=无背景） | 聊天背景图，base64 data URL |
| `api_endpoint` | string | `OPENAI_BASE_URL` | `https://api.openai.com/v1` | API 地址 |
| `api_key` | string | `OPENAI_API_KEY` | `""` | API 密钥 |
| `support_attachments` | boolean | — | `false` | 全局附件开关 |
| `show_github` | boolean | — | `true` | 是否在界面中显示 GitHub 链接 |
| `recommended_questions` | string[]（JSON） | — | `[]` | 首页推荐问题（空对话展示，最多 3 条） |
| `followup_questions` | string[]（JSON） | — | `[]` | 聊天常用追问（非空对话输入框上方气泡，最多 5 条） |
| `support_infinite_mode` | boolean | — | `false` | 无限演算模式开关 |
| `use_external_image_hosting` | boolean | — | `false` | 外部图床开关 |
| `oauth_providers` | JSON | — | `[]` | OAuth2 提供商配置 |
| `tts_api_endpoint` | string | — | `""` | TTS 服务地址 |
| `tts_provider` | string | — | `gpt-sovits` | TTS Provider（`gpt-sovits` / `cosyvoice`） |
| `direct_registration_open` | boolean | — | `true` | PIN 直接注册开关 |
| `oauth_registration_open` | boolean | — | `true` | OAuth 新用户注册开关 |

## 环境变量层（env 对象）

```typescript
export const env = {
  ADMIN: (process.env.ADMIN || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean),
  JWT_SECRET: process.env.JWT_SECRET || '',
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || DEFAULT_API_ENDPOINT,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || DEFAULT_MODEL,
  PORT: parseInt(process.env.PORT || '11408', 10),
}
```

- `dotenv/config` 在 `lib/env.ts` 中一次性加载，`config.ts` 和 `index.ts` 均通过 `import './env.js'` 引入
- `env` 对象在启动时初始化，运行时不可变（`ADMIN` 名单因此全程固定，改名单须停机重启）
- 只包含无 DB 回退的配置（`ADMIN`、`JWT_SECRET`、`PORT`）和 DB 回退的默认值（`api_endpoint`、`api_key`）

### 环境变量（完整列表）

| 变量名 | 说明 |
|---|---|
| `ADMIN` | 管理员用户名名单（逗号分隔，支持中英文逗号；留空 = 无管理员） |
| `JWT_SECRET` | JWT 签名密钥（可选；缺省时自动生成并持久化到 DB） |
| `OPENAI_BASE_URL` | API 地址 |
| `OPENAI_API_KEY` | API 密钥 |
| `OPENAI_MODEL` | 模型名称（可选；缺省时使用 `shared/constants.ts` 中的默认值） |
| `PORT` | 服务端口（默认 11408） |
| `DATABASE_URL` | PostgreSQL 连接 URL（可选；不设则用 sql.js） |
| `DATABASE_USER` | PostgreSQL 用户名（可选） |
| `DATABASE_SECRET` | PostgreSQL 密码（可选） |

## 运行时 DB 层

### 读取

```typescript
export async function getConfig(): Promise<AppConfig> {
  return {
    app_name: await getSetting('app_name', DEFAULT_APP_NAME),
    app_favicon: await getSetting('app_favicon', ''),
    app_background: await getSetting('app_background', ''),
    api_endpoint: await getSetting('api_endpoint', env.OPENAI_BASE_URL),
    api_key: await getSetting('api_key', env.OPENAI_API_KEY),
    support_attachments: (await getSetting('support_attachments', 'false')) === 'true',
    show_github: (await getSetting('show_github', 'true')) === 'true',
  }
}
```

### 写入

```typescript
export async function updateConfig(partial: Partial<AppConfig>): Promise<AppConfig> {
  for (const [key, value] of Object.entries(partial)) {
    if (value !== undefined) {
      const boolKeys = ['support_attachments', 'show_github']
      const stored = boolKeys.includes(key) ? (value ? 'true' : 'false') : value
      await setSetting(key, stored as string)
    }
  }
  return getConfig()
}
```

### 布尔值序列化

| 字段 | DB 存储值 | 读取逻辑 |
|---|---|---|
| `support_attachments` | `'true'` / `'false'` | `=== 'true'` |
| `show_github` | `'true'` / `'false'` | `=== 'true'` |

- 写入时：布尔值 → 字符串（`'true'` / `'false'`）
- 读取时：字符串 → 布尔值（`=== 'true'`）
- 旧库无此键时：默认值字符串（`'false'` / `'true'`）

### 写入辅助函数

```typescript
async function setSetting(key: string, value: string): Promise<void> {
  const existing = await db.select().from(settings).where(eq(settings.key, key)).get()
  if (existing) {
    await db.update(settings).set({ value }).where(eq(settings.key, key)).run()
  } else {
    await db.insert(settings).values({ key, value }).run()
  }
}
```

- 存在则 `UPDATE`，不存在则 `INSERT`（UPSERT 语义，但用两步实现）

## Agent 管理

Agent 是独立配置的 AI 角色，每个 Agent 拥有独立的模型和系统提示词。存储于 `agents` 表。

### Agent CRUD

| 函数 | 说明 |
|---|---|
| `listAgents()` | 列出所有 Agent（按 created_at 排序） |
| `getAgent(id)` | 获取单个 Agent，不存在返回 null |
| `createAgent(name, model, systemPrompt, avatar?, role?)` | 创建 Agent，中立 Agent 使用固定 ID |
| `updateAgent(id, partial)` | 部分更新 Agent 字段 |
| `deleteAgent(id)` | 删除 Agent（中立 Agent 不可删除） |
| `bootstrapAgents()` | 首次启动确保：中立 Agent 和默认 Agent 至少各存在一个 |

### 迁移/引导逻辑

`bootstrapAgents()` 在 `index.ts` 启动时调用，若 `agents` 表中缺失中立 Agent 或默认 Agent 则自动补建：

1. 检查中立 Agent（`NEUTRAL_AGENT_ID`）是否存在 → 不存在则使用 `env.OPENAI_MODEL` 创建
2. 检查是否存在非中立 Agent → 不存在则使用 `env.OPENAI_MODEL` 创建默认 Agent（名称 `Momoi`）

## 接口契约

### GET /api/admin/config（需管理员 JWT）

获取完整配置。**API Key 以明文返回**（见已知缺陷）。

**响应**：
```json
{
  "app_name": "Momoi",
  "app_favicon": "",
  "app_background": "",
  "api_endpoint": "https://api.openai.com/v1",
  "api_key": "sk-....abcd",
  "support_attachments": false,
  "show_github": true
}
```

### PUT /api/admin/config（需管理员 JWT）

部分更新配置，只更新请求中提供的字段。

**请求**：
```json
{
  "app_name": "我的助手",
  "support_attachments": true
}
```

**响应**：更新后的完整配置对象。

### GET /api/app-name（公开）

返回公开的品牌信息（无密钥/模型等敏感数据），供前端初始化时读取。

**响应**：
```json
{
  "app_name": "Momoi",
  "app_favicon": "",
  "app_background": "",
  "support_attachments": false,
  "show_github": true
}
```

**前端调用时机**：
- 应用启动时（`App.tsx` 的 `useEffect`）
- 管理面板关闭时（`settingsOpen` 变为 `false` 时重新拉取）

## 客户端应用

### 前端读取配置

```typescript
// App.tsx
api.getAppName().then((r) => {
  setAppName(r.app_name)
  // 更新 Favicon
  const link = document.getElementById('favicon') as HTMLLinkElement | null
  if (link) link.href = r.app_favicon
  setBackgroundImage(r.app_background || '')
  setSupportAttachments(!!r.support_attachments)
  setShowGithub(r.show_github !== false)
})
```

### 管理面板修改配置

`AdminScreen` 复用登录用户的 JWT（`lib/api.ts` 请求层自动附加 `Authorization`），服务端由 `adminAuthMiddleware` 校验 `ADMIN` 名单后放行。

## ⚠️ 已知缺陷

### API Key 未脱敏

`getConfig()` 直接回传 `api_key` 明文。`GET /api/admin/config` 返回完整密钥字符串。

**影响**：任何拿到管理员 JWT 的人即可获取上游 API 密钥明文。

**修复方向**：
- 管理员面板读取时返回 `***` + 后 4 位
- `updateConfig()` 需识别脱敏占位值，避免把 `***abcd` 回写入库
- 不能只在 GET 侧打补丁，必须同时改动写入路径

### 配置项命名不一致

DB 键名与 `AppConfig` 字段名一一对应，但前端 `getAppName()` 返回的字段名与 `getConfig()` 一致，前端直接用相同的字段名消费。目前无额外的映射层。

## 验收标准

1. 无 `.env` 文件时使用默认值启动 ✅
2. 管理员修改配置后立即生效，无需重启 ✅
3. 布尔值序列化/反序列化一致（`true` ↔ `'true'`）✅
4. 公开端点不暴露密钥等敏感信息 ✅
5. 前端在启动和管理面板关闭时重新读取配置 ✅
6. 部分更新只修改指定字段，不覆盖其他字段 ✅