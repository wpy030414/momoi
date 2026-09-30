# Spec — 配置系统（Config）

## 概述

配置系统采用双层架构：**.env 环境变量**作为启动时的默认值，**SQLite settings 表**作为运行时可热更新的覆盖层。管理员通过管理面板修改配置后立即生效，无需重启服务。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `apps/server/src/lib/config.ts` | 环境变量读取 + DB 配置读写（`getConfig` / `updateConfig`） |
| `apps/server/src/lib/config-transfer.ts` | 配置导入导出（bundle 构建 / YAML 序列化 / 白名单校验 / upsert 应用） |
| `packages/shared/src/constants.ts` | 默认值常量 |
| `apps/server/src/routes/admin.ts` | 管理员 API 端点（`GET/PUT /api/admin/config`、`POST /config/export`、`POST /config/import`、PIN 二次校验 `requirePin`） |
| `apps/server/src/routes/app.ts` | 公开端点（`GET /api/app-name`，对外暴露品牌信息与 Agent 列表） |
| `apps/web/src/components/admin/tabs/AgentManager.tsx` | 管理面板中的 Agent 管理界面 |
| `apps/web/src/components/admin/tabs/GatewaySettings.tsx` | 管理面板中的网关配置界面 |
| `apps/web/src/components/admin/tabs/ExperienceSettings.tsx` | 体验配置界面（应用外观 + 首页推荐问题 + 聊天常用追问） |
| `apps/web/src/components/admin/tabs/ConfigTransfer.tsx` | 配置导入导出界面（导出按钮 + 预检/确认导入对话框） |

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
| `api_key` | string | `OPENAI_API_KEY` | `""` | API 密钥（明文存 `settings` 表） |
| `context_window` | number | — | `128000` | 模型上下文窗口（tokens）；状态条「上下文（已用）%」的分母，非法值读取时夹回 128000 |
| `support_attachments` | boolean | — | `true` | 全局附件开关 |
| `show_github` | boolean | — | `true` | 是否在界面中显示 GitHub 链接 |
| `recommended_questions` | string[]（JSON） | — | `[]` | 首页推荐问题（空对话展示，最多 3 条） |
| `followup_questions` | string[]（JSON） | — | `[]` | 聊天常用追问（非空对话输入框上方气泡，最多 5 条） |
| `support_infinite_mode` | boolean | — | `true` | 无限演算模式开关 |
| `allow_im_conversations` | boolean | — | `true` | 是否允许在 IM（QQ/微信）上对话 |
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

## 配置导入导出（Config Transfer）

后台「配置」页（侧边栏首项，位于「网关」之上）提供设置数据的 YAML 导出/导入，用于跨实例迁移与备份。核心逻辑在 `lib/config-transfer.ts`（校验规则的事实来源，含 48 项单测 `test/config-transfer.test.ts`）。

### 导出范围

| 段 | 内容 | 说明 |
|---|---|---|
| `gateway` | `api_endpoint`、`api_key`、`context_window`、`support_attachments`、`support_infinite_mode`、`use_external_image_hosting`、`allow_im_conversations` | 与网关页的 7 项一一对应；**含 `api_key` 明文** |
| `experience` | `app_name`、`app_favicon`、`app_background`、`show_github`、`recommended_questions`、`followup_questions` | 与体验页一致；图片为 base64 data URL 或 http(s) 链接 |
| `agents` | `id`、`role`、`name`、`model`、`system_prompt`、`avatar` | **不含** voice 三字段与 `created_at` |
| `users` | `direct_registration_open`、`oauth_registration_open`、`oauth_providers` | 含 `client_secret` 明文 |

**仍不导出**：JWT 密钥、VAPID、TTS（`tts_*`）等不与网关页对应的运行时配置（bundle 由 `buildExportBundle` 手工挑白名单字段构建，绝不整体序列化 `AppConfig`）。

**导出的是「生效值」**（`map.get(key) || env.*`）：`api_key`/`api_endpoint` 可能来自 `.env` 而从未被管理员在界面上输入过——导出文件会把这份 `.env` 密钥一并带走，反向导入则会让目标实例的该值「钉」在 `settings` 表里，此后改目标实例的 `.env` 不再生效。**这一点只记录在本节**：导出页的警示文案保持简短（「导出文件含 API 和 OAuth2 密钥，请谨慎保管该文件。」），不展开 `.env` 继承与钉住效应。

> 这不是新增的暴露面：`GET /api/admin/config` 早已返回完整 `AppConfig`（含 `api_key`），见本文末「API Key 未脱敏」。新增的 PIN 门控（下节）是对这条既有事实的补偿。

### YAML 结构（version 1）

```yaml
version: 1
exported_at: "2026-09-30T12:00:00.000Z"
gateway:
  api_endpoint: https://api.openai.com/v1
  api_key: sk-...                 # 明文，且可能继承自 .env
  context_window: 128000
  support_attachments: true
  support_infinite_mode: true
  use_external_image_hosting: false
  allow_im_conversations: true
experience:
  app_name: Momoi
  app_favicon: ""          # 空串 | data:image/* | http(s) URL
  app_background: ""
  show_github: true
  recommended_questions: ["你好"]
  followup_questions: []
agents:
  - id: neutral-agent       # 中立 Agent 固定 ID
    role: neutral
    name: 中立 Agent
    model: gpt-4o
    system_prompt: ""
    avatar: ""
  - id: 3f2c1b8e-9a7d-4c1e-8f2a-1b2c3d4e5f60
    role: default
    name: Momoi
    model: gpt-4o
    system_prompt: |
      多行提示词
    avatar: ""
users:
  direct_registration_open: true
  oauth_registration_open: true
  oauth_providers:
    - { id: github, name: GitHub, client_id: "...", client_secret: "...",
        authorize_url: https://..., token_url: https://..., userinfo_url: https://..., scopes: "read:user" }
```

`version` 保持 1：新增的 `gateway` 段是可选增量，旧文件（无该段）照常通过校验；若升到 2，`validateImportBundle` 的 `version !== BUNDLE_VERSION` 会直接拒收所有既存文件。

### 导入语义

- **字段级可选**：任何段、任何键都可省略——省略 = 不更新该键（绝非置空），手写只含目标字段的最小文件即可导入；`version` 缺省视为 1
- **`api_key: ""` 的特殊含义**：空串合法，但要理解成「清掉 `settings` 行、读取时回落 `.env`」，而不是「把密钥设为空」
- **Agent 按 id upsert**：带 id（UUID 格式校验）→ 存在则更新（只更新文件中出现的字段）、不存在则按原 id 新建；**省略 id → 一律视为新增**（生成新 UUID，重复导入同一文件会产生副本，dry-run 摘要提示）；本地已有但文件中不存在的 Agent **一律保留**（保护 `conversations`/`messages` 等表的 agent_id 引用）
- **OAuth 供应商按 id 合并**：同 id 字段级覆盖（省略字段保留原值）、新 id 追加、本地多余保留
- **中立 Agent**：`name` 与库中现值不同 → **整包拒绝**；`avatar` → warning 并忽略；仅 `model`/`system_prompt` 可更新

### 校验规则（白名单 + 报错拒绝）

- 顶层键 ∈ {version, exported_at, gateway, experience, agents, users}；四段至少一段存在；文本 ≤ 10MB
- YAML 解析：`maxAliasCount: 100`（防锚点引用爆炸）+ `merge: false`（禁 merge key 绕过白名单）
- `api_endpoint` trim 后 1-500 字符（**不**校验 URL 形态——`PUT /api/admin/config` 本身零校验，且 `.env` 里 `localhost:11434/v1` 这类无 scheme 写法很常见，强求 http(s) 会让自家导出的文件被自家拒收）；`api_key` ≤500 字符、允许空串、不 trim；`context_window` 须为 1..10000000 的整数（比读取路径更严：`parseContextWindow` 会把非法值静默夹成 128000）；gateway 的四个开关须严格为 boolean
- `app_name` trim 后 1-50 字符；图片字段仅允许 空串 / `data:image/*` / `http(s)://`（拒 `javascript:` 注入）
- 推荐问题 ≤3 条、追问 ≤5 条、每条 trim 后 1-20 字符；Agent ≤50 个、名称 1-30 字符、`system_prompt` ≤100000 字符
- OAuth 供应商 ≤10 个；`id` 须匹配 `^[A-Za-z0-9_-]{1,64}$`（会进入 URL 路径与 cookie）；三个 URL 非空时必须 http(s)
- 校验错误结构化为 `{ path, code, params? }`（如 `agents[2].name`）；前端按 `errors.<code>` 直查三语 locale 渲染（契约见 `module-errors.md`）。**`CONFIG_IMPORT_BAD_API_KEY` 刻意不带 params**——模板里任何插值位都可能把密钥值回显进错误消息
- `ImportSummary` 只承载**字段名**（`{changed: string[], unchanged: string[]}`），不承载字段值，因此 dry-run 响应不会泄露任何密钥

### 二次校验（PIN 门控）

导出与导入都是搬运密钥的动作，因此都要过 `requirePin(c, pin)`（`routes/admin.ts`，骨架同 `POST /api/user/change-pin`）：

- **导出**：每次导出都要重新输 PIN——由输入框旁的小弹窗收集，随 `POST /config/export` 的 `{pin}` 体送出（**不放 URL**，避免进访问日志/referrer）
- **导入**：只在**正式导入**（落库）那一步校验；dry-run 不校验（它不写库，摘要也只含字段名，拿它当门禁只会让反复预检变得难受）
- 失败返回 401 `AUTH_INVALID_PIN`，计入 IP 失败计数（`lib/rateLimiter.ts`），连错触发 429 `USER_RATE_LIMITED`
- 前端 `lib/api.ts` 的 `CREDENTIALS_ENDPOINTS` 必须包含这两个端点：否则一次 PIN 打错会被通用 401 路径当成会话过期而**清会话登出**
- standAlone 模式下 `requirePin` 直接返回（该模式没有 PIN 概念，`adminAuthMiddleware` 本身也短路）
- 日志安全：`hono/logger` 只记 method/path/status/耗时，不记请求体；`updateConfig`/`setSetting` 也不打日志。后续若有人加请求体日志，会把密钥写进日志

### 接口契约

| 端点 | 说明 |
|---|---|
| `POST /api/admin/config/export` | 体 `{pin}`（PIN 门控）→ 返回 YAML 文本，`Content-Disposition: attachment; filename="config-output-${Date.now()}.yml"`，`Cache-Control: no-store` |
| `POST /api/admin/config/import?dry_run=1` | 只校验（**无需 PIN**），返回 `{ok, errors, warnings, summary}`（变更摘要） |
| `POST /api/admin/config/import` | 体 `{content, pin}` → 校验 → PIN → 重跑校验（并发窗口）→ 应用，返回 `{ok, applied}` |

**校验失败也返回 HTTP 200**（携带完整错误列表）——客户端通用错误路径会把非 2xx 折叠成单条消息。正式导入前重跑完整校验：dry-run 与确认之间服务端状态可能被并发修改（如中立 Agent 已被改名），fail-fast 而非应用过期数据。

### 应用顺序与副作用

`gateway → experience → users → agents`（无事务，fail-fast）。

**gateway 必须最先落库**，且**不能与 experience 合并成同一次 `updateConfig`**：`use_external_image_hosting` 决定后面 favicon/background/avatar 的 base64 是否转 CDN，而 `maybeUploadDataUrl` 实时调 `isExternalImageHostingEnabled()`（直读 `settings` 表，不走 config 缓存）。上传判定发生在写入之前——合并写入会让"同一份文件既开图床又带 base64 图片"的场景失效。

其余副作用：外部图床开启时导入的 base64 图片先转 CDN 再落库，CDN 失败保留原值（与 `PUT /config` 行为一致）。导入成功无需手动刷新——管理面板关闭时 `useAdminPanel` 自动重拉 `getAppName`。

### 已知限制

- `apply` 无事务（sql.js 各语句独立提交）；中途 DB 异常会留下部分应用（概率极低，双重校验缓解）
- 超大 background 可能使导出文件超过 10MB 导入上限（导出文案提示）
- 导出文件等同凭证（含 `api_key` 与 `client_secret` 明文），UI 有黄色警示 + PIN 门控
- 导入会把 `gateway` 段的值钉进目标实例的 `settings` 表，覆盖其 `.env` 配置
- 跨实例导入时 CDN URL 指向原实例图床，目标实例需可访问
- DB 中历史遗留的超长（>20 字符）推荐/追问问题导出后再导入会被拒，需先在体验页修复
- standAlone 模式下「配置」页不隐藏；users 段照常导入导出（注册开关在该模式不生效），导出/导入不做 PIN 校验




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