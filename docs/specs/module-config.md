# Spec — 配置系统（Config）

## 概述

配置系统采用双层架构：**.env 环境变量**作为启动时的默认值，**SQLite settings 表**作为运行时可热更新的覆盖层。管理员通过管理面板修改配置后立即生效，无需重启服务。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/server/config.ts` | 环境变量读取 + DB 配置读写（`getConfig` / `updateConfig`） |
| `src/server/shared/constants.ts` | 默认值常量 |
| `src/server/routes/admin.ts` | 管理员 API 端点（`GET/PUT /api/admin/config`） |
| `src/server/routes/app.ts` | 公开端点（`GET /api/app-name`，对外暴露品牌信息与 Agent 列表） |
| `src/client/components/settings/AgentManager.tsx` | 管理面板中的 Agent 管理界面 |
| `src/client/components/settings/GatewaySettings.tsx` | 管理面板中的网关配置界面 |
| `src/client/components/settings/BrandingTab.tsx` | 品牌配置界面 |

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

## 环境变量层（env 对象）

```typescript
export const env = {
  ADMIN_KEY: process.env.ADMIN_KEY || '',
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL || DEFAULT_API_ENDPOINT,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  PORT: parseInt(process.env.PORT || '3001', 10),
}
```

- `dotenv/config` 在 `server/index.ts` 和 `config.ts` 中分别加载
- `env` 对象在启动时初始化，运行时不可变
- 只包含无 DB 回退的配置（`ADMIN_KEY`、`PORT`）和 DB 回退的默认值（`api_endpoint`、`api_key`）

### 环境变量（完整列表）

| 变量名 | 说明 |
|---|---|
| `ADMIN_KEY` | 管理员密钥 |
| `OPENAI_BASE_URL` | API 地址 |
| `OPENAI_API_KEY` | API 密钥 |
| `PORT` | 服务端口（默认 3001） |

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
| `migrateDefaultAgent()` | 首次启动迁移：从旧全局配置创建默认 Agent 和中立 Agent |

### 迁移逻辑

`migrateDefaultAgent()` 在 `index.ts` 启动时调用，若 `agents` 表为空则：
1. 从 settings 表读取旧 `model` 和 `system_prompt`（兼容旧版本数据）
2. 创建默认 Agent（名称 `Momoi`，使用旧配置或默认值）
3. 创建中立 Agent（名称 `中立 Agent`，固定 ID `neutral-agent`，复用默认 Agent 的模型）

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

`SettingsDialog` 使用管理员 JWT 通过 `useAdmin` hook 调用 `api.updateConfig()`，API 调用时显式传入 `Authorization` 头，避免被用户 token 覆盖。

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