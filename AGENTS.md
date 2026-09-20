# AGENTS.md

## 项目：Momoi

自托管的 Web AI 智能体平台。用户通过 PIN 认证登录后与 AI 对话；模型按需调用技能；支持文件附件多模态交互；管理员由 `.env` 的 `ADMIN` 用户名名单指定。

## 文档结构

`docs/` 下的文档各司其职，互不重叠：

| 文档 | 职责 |
|---|---|
| `docs/PRD.md` | 为什么做、做什么（目标/场景/功能/范围） |
| `docs/ARCHITECTURE.md` | 系统如何组织（模块/关系/数据流/边界） |
| `docs/DECISIONS.md` | 为何选此方案、备选与权衡 |
| `docs/specs/module-*.md` | 具体模块的表现契约、约束与验收标准 |

## 非目标（Non-Goals）

这些功能**不在本项目范围内**，Agent 不应尝试添加：

- ❌ RAG / 知识库
- ❌ 工作流构建器 / 可视化编辑器
- ❌ 移动应用
- ❌ 企业 SSO
- ❌ 实时协作
- ❌ WebSocket 实时通信（已迁移到 SSE）

## 架构概述

pnpm monorepo（`apps/*` + `packages/*`），纯 workspace 协议，无外部编排工具。详情见 `docs/ARCHITECTURE.md`。

- **前端**：React 19 + shadcn/ui + Vite 8，outDir → `apps/server/dist/client/`
- **后端**：Hono 4（Node.js），SSE + REST API
- **数据库**：SQLite（sql.js + Drizzle ORM）为默认；支持 PostgreSQL
- **AI**：OpenAI 兼容 Chat Completions API + Pi Agent Core
- **认证**：PIN（PBKDF2 哈希）+ JWT（HttpOnly Cookie 14 天滑动续期）；管理员由 `ADMIN` 环境变量名单指定
- **共享层**：`@momoi/shared` TS 源码直引，tsup 内联到 server bundle

## 项目结构

pnpm monorepo：应用 (`apps/`) 与可复用包 (`packages/`)，纯 workspace 协议。

| 包 | 位置 | 说明 |
|---|---|---|
| `@momoi/server` | `apps/server/` | Hono 后端，入口 `src/index.ts`，自包含产物 `dist/`（含 `client/`） |
| `@momoi/web` | `apps/web/` | React 前端（Vite），产出物落在 `apps/server/dist/client/` |
| `@momoi/shared` | `packages/shared/` | 共享类型与常量，TS 源码直引（`exports` → `./src/*.ts`，零构建） |

运行时的用户数据（`data/`、`skills/`、`.env`）在仓库根目录不动。服务端通过 `REPO_ROOT` 锚定访问（向上找到 `pnpm-workspace.yaml` 标记）。

## 关键目录

| 路径 | 用途 |
|---|---|
| `apps/server/src/` | Hono 后端（入口：`index.ts`） |
| `apps/server/src/ai/` | Pi Agent Core 适配层 + 群聊编排 + 中立 Agent + TTS |
| `apps/server/src/tools/` | 内置工具系统 + MCP 客户端 |
| `apps/server/src/skills/` | 技能加载和注册 |
| `apps/server/src/middleware/` | 用户 JWT 认证中间件 + IP 速率限制 |
| `apps/server/src/routes/` | API 路由 |
| `apps/web/src/` | React 前端（入口：`main.tsx`） |
| `apps/web/src/components/` | UI 组件和业务组件 |
| `apps/web/src/hooks/` | React Hooks |
| `apps/web/src/lib/` | API 客户端、工具函数 |
| `apps/web/src/i18n/` | 国际化 |
| `packages/shared/src/` | 共享类型 (`types.ts`) 和常量 (`constants.ts`, `thinking.ts`) |
| `skills/` | 已安装的技能（运行时，根目录） |
| `data/` | SQLite 数据库 + 对话工作区（运行时，根目录） |

## 开发

```bash
pnpm dev          # 同时运行 Vite（5173）+ Hono（11408），tsx watch 热重载
pnpm build        # 先构建 server（tsup），再 web（Vite）——server 的 tsup --clean 会清掉旧的 client/
pnpm start        # 运行生产构建（node apps/server/dist/index.js 从仓库根运行）
```

## 代码规范

- 所有 UI 组件使用 shadcn/ui 模式（Radix + Tailwind + CVA）
- 基础 UI 组件在 `apps/web/src/components/ui/`
- 业务组件在 `apps/web/src/components/{chat,sidebar,settings,auth}/`
- Hooks 在 `apps/web/src/hooks/`
- API 客户端在 `apps/web/src/lib/api.ts`
- 服务端路由在 `apps/server/src/routes/`
- 共享类型在 `packages/shared/src/types.ts` —— 唯一的事实来源

## 技能契约

技能是 `skills/` 下的一个目录，包含：

- **`SKILL.md`** — YAML 前置元数据（`name`、`description`、可选 `version`）+ Markdown 正文（注入系统提示词）

## 认证模型

PIN（PBKDF2）+ JWT（HttpOnly Cookie 14 天滑动续期）+ IP 速率限制。管理员由 `ADMIN` 环境变量名单授权，复用用户 JWT。详情见 `docs/specs/module-auth.md` 与 `docs/ARCHITECTURE.md`。

## 数据库

SQLite（sql.js，单文件 `data/momoi.db`）或 PostgreSQL（`DATABASE_URL`）。表结构见 `docs/ARCHITECTURE.md` 的 Schema 章节。
