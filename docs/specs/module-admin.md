# Spec — 管理员系统（Admin）

## 概述

管理员由 `.env` 的 `ADMIN` 环境变量指定（逗号分隔的用户名名单，如 `ADMIN=xrl,咕咕,k3p0`），进程生命周期内固定，修改需停机改 `.env` 重启；留空或缺省即无管理员，不影响运行。管理员系统提供全局配置管理能力与数据统计面板，所有配置变更通过管理员 API 持久化到 SQLite。用户认证（PIN）另见 `module-auth.md`。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/server/auth.ts` | `isAdmin()` 名单判定 + `adminAuthMiddleware`（用户 JWT + 名单校验） |
| `src/server/config.ts` | 环境变量读取（含 `ADMIN` 名单解析）+ DB 配置读写 |
| `src/server/routes/admin.ts` | 管理员 REST API（含统计、技能上传/卸载） |
| `src/client/components/admin/AdminScreen.tsx` | 管理面板（6 标签页：Agent/Gateway/Branding/MCP/Skills/Stats） |

## 认证流程

```
管理员登录（普通用户 PIN 流程）
  → 获得用户 JWT（14 天，role:'user'；剩余不足一半时客户端自动续期）

访问管理端点
  → Authorization: Bearer <用户 JWT>
  → adminAuthMiddleware 验证 JWT 签名
  → isAdmin(username) 检查 env.ADMIN 名单
  → 通过则继续处理；无效 token → 401；有效用户但不在名单 → 403

客户端入口
  → GET /api/user/me → { username, is_admin }
  → is_admin=true：侧边栏设置显示「后台设置」入口，#/settings 直接进入
  → 其他用户：无入口；直输 #/settings 被路由守卫遣返首页
```

> 中间件按路径挂载（`adminRoute.use('/config', ...)` 等），覆盖全部管理端点。

## 接口契约

> 以下所有端点均需用户 JWT，且用户名在 `ADMIN` 名单内（否则 401/403）。无独立的密钥认证端点。

### GET /api/admin/config

获取当前配置。

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

> ⚠️ **API Key 目前以完整明文返回，脱敏尚未实现。** 早期文档所述「`***` + 后 4 位」在代码中并不存在——`config.ts:getConfig()` 直接回传 `api_key`，本条已实测确认（返回体含完整密钥字符串）。修复见下方「安全约束」。响应示例中的值为占位示意，非真实密钥。

### PUT /api/admin/config（需 JWT）

更新配置（部分更新）。

**请求**（示例）：
```json
{
  "app_name": "我的助手",
  "app_background": "data:image/png;base64,...",
  "support_attachments": true
}
```

**响应**：更新后的完整配置对象。

**行为**：只更新请求中提供的字段（`undefined` 值跳过）；`support_attachments` 布尔值以 `'true'/'false'` 字符串入库。

### Agent CRUD 端点（需 JWT）

#### GET /api/admin/agents

列出所有 Agent。

**响应**：`{ "agents": [{ "id", "name", "model", "system_prompt", "avatar", "role", "created_at" }] }`

#### POST /api/admin/agents

创建 Agent。

**请求**：`{ "name": "Agent名称", "model": "模型", "system_prompt": "提示词", "avatar?": "base64" }`

**响应**：`{ "agent": { ... } }`（状态码 201）

**错误**：`name` 为空 → 400

#### PUT /api/admin/agents/:id

更新 Agent。

**请求**：`{ "name?": "...", "model?": "...", "system_prompt?": "...", "avatar?": "..." }`

**中立 Agent 规则**：中立 Agent（`id === 'neutral-agent'`）只能修改 `model` 和 `system_prompt`，`name` 和 `avatar` 会被静默剥离。

**响应**：`{ "agent": { ... } }`

**错误**：Agent 不存在 → 404

#### DELETE /api/admin/agents/:id

删除 Agent。

**中立 Agent 规则**：中立 Agent 不可删除 → 403 `{ "error": "Neutral agent cannot be deleted" }`

**响应**：`{ "success": true }`

**错误**：Agent 不存在 → 404

### GET /api/admin/stats（需 JWT）

整体统计。

**响应**：
```json
{ "total_users": 3, "total_conversations": 42, "total_messages": 187 }
```

`total_users` = `count(distinct user_id)` over conversations。

### GET /api/admin/stats/conversations（需 JWT）

所有对话（含 user_id 与消息数），按 `updated_at` 降序。

**响应**：`{ "conversations": [{ "id","user_id","title","created_at","updated_at","message_count" }] }`

### GET /api/admin/stats/conversations/:id/messages（需 JWT）

查看任意对话的完整消息（管理员可跨用户浏览，不校验归属）。反序列化 `tool_calls`、`suggestions`、`attachments` 后返回。

**响应**：`{ "conversation": {...}, "messages": [...] }`；对话不存在 → 404。

## 配置层级

```
优先级（高 → 低）：
  1. SQLite settings 表（运行时可修改）
  2. .env 环境变量（启动时读取，不可热更新）
  3. 代码中的默认值（constants.ts）
```

### 配置字段

| 字段 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `app_name` | — | `Momoi` | 应用名称 |
| `app_favicon` | — | `""`（空=默认） | Base64 data URL |
| `app_background` | — | `""`（空=无背景） | 聊天背景图，Base64 data URL |
| `api_endpoint` | `OPENAI_BASE_URL` | `https://api.openai.com/v1` | API 地址 |
| `api_key` | `OPENAI_API_KEY` | `""` | API 密钥 |
| `support_attachments` | — | `false` | 全局附件开关 |
| `show_github` | — | `true` | 是否显示 GitHub 链接 |

## JWT 实现细节

- 管理员**不再有独立 JWT**：管理端点复用用户 JWT（HS256、14 天滑动续期、`role:'user'`），由 `adminAuthMiddleware` 逐请求校验 `isAdmin(username)`
- **签名密钥**：`JWT_SECRET` 环境变量（可选）；缺省时首启生成随机密钥并持久化到 `settings` 表（键 `jwt_secret`），重启复用
- 名单为空/缺省时无任何管理员，应用其余功能不受影响

## 技能上传

管理员通过本路由上传/安装/卸载技能，zip 处理逻辑（zip slip 防护、包装目录检测、macOS 产物清理、50MB 上限）详见 `module-skill.md`。对应端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/skills` | 列出技能 |
| POST | `/api/admin/skills/upload` | 上传技能 zip |
| POST | `/api/admin/skills/install` | 安装/刷新已有目录 |
| DELETE | `/api/admin/skills/:name` | 卸载技能 |

### MCP 服务器

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/mcp-servers` | 列出 MCP 服务器 |
| POST | `/api/admin/mcp-servers` | 新增 MCP 服务器 |
| PUT | `/api/admin/mcp-servers/:id` | 更新 MCP 服务器 |
| DELETE | `/api/admin/mcp-servers/:id` | 删除 MCP 服务器 |

> 插件系统已移除（commit 3530176），相关端点不再存在。

## 前端面板（SettingsDialog）

6 个标签页：

1. **Agent** — Agent 列表 / 创建 / 编辑 / 删除（中立 Agent 不可删除，名称/头像不可修改）
2. **Gateway** — API 地址、密钥（密钥输入框为 `type=password` 遮挡显示 + 明文切换按钮）
3. **Branding** — 应用名称、Favicon（上传转 base64）、聊天背景图
4. **MCP** — MCP 服务器管理（添加/编辑/删除/启用禁用），存储于 `mcp_servers` 表
5. **Skills** — 技能列表 / 上传 / 卸载
6. **Stats** — 用户/对话/消息统计 + 对话表格（可展开查看消息）

管理面板（`AdminScreen`）复用登录用户的 JWT：`lib/api.ts` 的请求层自动附加 `Authorization`，服务端由 `adminAuthMiddleware` 校验名单。路由守卫保证只有 `/me` 返回 `is_admin: true` 的用户能进入 `#/settings`。

## 安全约束

1. `ADMIN` 名单、`JWT_SECRET` 永远不通过 API 返回给前端 ✅ 已实现
2. 受保护路由：`/api/admin/config`、`/api/admin/skills/*`、`/api/admin/stats`、`/api/admin/mcp-servers`、`/api/admin/mcp-servers/*` ✅ 已实现
3. 无效用户 token → 401；有效用户但不在 `ADMIN` 名单 → 403（不触发前端自动登出）✅ 已实现
4. 统计面板可跨用户读取所有对话内容 —— 属管理员特权，受名单校验保护（`use('/stats', ...)` + `use('/stats/*', ...)` 双挂载覆盖精确路径与所有子路径；曾因只挂 `/stats` 导致 `/stats/conversations` 及 messages 子端点匿名可访问，已修复并实测验证）

## ⚠️ 已知缺陷：API Key 未脱敏

**需求（PRD F7「API Key 脱敏显示」）与实现不符。**

`src/server/config.ts:getConfig()` 原样回传 `api_key`，`GET /api/admin/config` 返回**完整明文密钥**。已实测确认：

```
{"api_key":"<完整密钥明文>", ...}
```

**影响**：任何拿到管理员 JWT 的人（或能查看该请求的中间人/浏览器历史/日志）即可获取上游 API 密钥明文。前端仅用 `type=password` 遮挡渲染，属**视觉遮罩而非安全边界**，不改变响应体含明文的事实。

**修复方向**：在 `getConfig()` 中按调用场景区分 —— 供管理员面板读取时返回 `***` + 后 4 位；`updateConfig()` 需识别脱敏占位值以避免把 `***abcd` 回写入库（否则保存一次配置就会污染真实密钥）。这是脱敏必须同时改动写入路径的原因，不能只在 GET 侧打补丁。