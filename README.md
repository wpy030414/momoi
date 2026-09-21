# Momoi

轻量级、可自托管的 Web AI 智能体平台。与 AI 对话，通过内置工具执行文件读写、Shell 命令、网络请求、文档处理等任务，通过技能注入系统提示词，支持文件附件多模态交互。支持微信 / QQ 绑定、OAuth 登录、TTS 语音合成、多设备实时同步。

## 核心特性

- **PIN 认证登录** — 用户名 + 4 位 PIN，PBKDF2 安全哈希，JWT 经 HttpOnly Cookie 传输 + 14 天滑动续期
- **OAuth 登录** — 支持 OAuth2 提供商登录与账号绑定
- **流式对话** — React + shadcn/ui 聊天界面，SSE 实时流式输出（token、思考过程、工具调用）
- **思考模式** — 支持 AI 扩展推理，可折叠展示思考过程
- **文件附件** — 支持图片、Excel、PDF 等附件，管理员可开关
- **内置工具系统** — AI 可执行文件读写、Shell 命令、网络请求、文档处理，沙盒隔离
- **技能系统** — SKILL.md 摘要注入系统提示词，完整内容按需加载
- **Agent 多智能体** — 每个 Agent 独立模型、提示词、头像，支持群聊对话
- **无限演算模式** — 中立 Agent 自动追问，支持个体聊天和群聊
- **TTS 语音合成** — GPT-SoVITS / CosyVoice 双引擎，Agent 可配置独立声音
- **微信 / QQ 绑定** — 扫码或凭证绑定，在 IM 中与 AI 对话
- **多设备实时同步** — 同账号多设备间聊天流实时中继
- **管理员面板** — 在线修改模型、提示词、品牌、技能、MCP 服务器
- **国际化** — 中文 / 英文双语支持
- **白标品牌** — 自定义应用名称、Favicon、聊天背景图

完整功能列表与用例见 `docs/PRD.md`。

## 快速开始

```bash
# 安装依赖
pnpm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入 API Key，按需配置 ADMIN 管理员名单

# 开发模式（Vite 5173 + Hono 11408 同时启动）
pnpm dev
```

- 前端：http://localhost:5173
- 后端 API：http://localhost:11408

### 单机模式

启动服务器时追加 `--stand-alone` 进入单机模式——单用户、无鉴权的本机部署：

```bash
pnpm dev:standalone     # 开发模式
pnpm start:standalone   # 生产模式
```

- 固定 `admin` 用户，无登录页，不可改密/改名/登出
- 后台始终可用，「用户」tab 不显示

> ⚠️ 单机模式不做任何鉴权，仅适合本机或可信内网使用，请勿暴露到公网。

## 环境变量

编辑 `.env`：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ADMIN` | （空） | 管理员用户名名单，逗号分隔 |
| `JWT_SECRET` | （自动生成） | JWT 签名密钥 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容 API 地址 |
| `OPENAI_API_KEY` | | API 密钥 |
| `OPENAI_MODEL` | `gpt-4o` | 模型名称 |
| `PORT` | `11408` | 服务端端口 |

## 管理面板

`ADMIN` 名单内用户登录后点击侧边栏设置图标进入后台，无需额外密钥：

- **Agent** — 创建/编辑/删除 Agent，独立配置模型与提示词
- **Gateway** — 全局 API 地址和密钥
- **体验** — 应用名称、Favicon、背景图、推荐问题
- **技能** — 上传/卸载技能
- **MCP** — 外部 MCP 服务器管理
- **统计** — 用户/对话/消息统计

## 生产部署

```bash
pnpm build          # 构建（server tsup + web Vite）
pnpm start          # 启动（node apps/server/dist/index.js）
```

## 技术栈

- **前端**：React 19 + shadcn/ui（Radix + Tailwind）+ Vite 8
- **后端**：Hono 4 + Pi Agent Core + Drizzle ORM
- **数据库**：SQLite（sql.js）默认；可选 PostgreSQL
- **实时通信**：SSE（Server-Sent Events）
- **认证**：PBKDF2 PIN + JWT（HttpOnly Cookie）+ OAuth2
- **文件解析**：xlsx、pdf-parse、mammoth、word-extractor

## 文档

| 文档 | 职责 |
|---|---|
| `docs/PRD.md` | 为什么做、做什么（目标/场景/功能/范围） |
| `docs/ARCHITECTURE.md` | 系统如何组织（模块/关系/数据流/边界） |
| `docs/DECISIONS.md` | 为何选此方案、备选与权衡 |
| `docs/specs/module-*.md` | 具体模块的表现契约、约束与验收标准 |