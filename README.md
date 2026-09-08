# Momoi

轻量级、可自托管的 Web AI 智能体平台。与 AI 对话，通过内置工具执行文件读写、Shell 命令、网络请求、文档处理等任务，通过技能注入系统提示词，支持文件附件多模态交互，一切由管理员密钥统一管理。

## 核心特性

- **PIN 认证登录** — 用户名 + 4 位 PIN，PBKDF2 安全哈希，JWT 30 天免登录
- **流式对话** — React + shadcn/ui 聊天界面，SSE 实时流式输出（token、思考过程、工具调用）
- **思考模式** — 支持 AI 扩展推理（DashScope 兼容 `enable_thinking`），可折叠展示思考过程
- **文件附件** — 支持图片（多模态）、Excel（转 CSV）、PDF（提取文本）等附件，管理员可开关
- **内置工具系统** — AI 可执行文件读写、Shell 命令、网络请求、文档处理（DOCX/PPTX/XLSX/PDF），沙盒隔离
- **技能系统** — SKILL.md 摘要注入系统提示词，完整内容通过 `load_skill` 工具按需加载；支持嵌套技能目录递归扫描
- **Mermaid 图表** — AI 回复中的 mermaid 代码块自动渲染为图表
- **后续建议** — AI 每次回复末尾自动生成 3 条可点击的追问建议
- **消息回退** — 可从任意历史消息处回退，删除该消息及之后所有消息
- **对话导出** — 将对话导出为格式化 TXT 文件
- **统计面板** — 管理员可查看用户/对话/消息统计，浏览所有对话和消息
- **管理员面板** — 密钥认证 + JWT，在线修改模型、提示词、品牌、技能
- **白标品牌** — 自定义应用名称、Favicon、聊天背景图
- **持久化存储** — SQLite 单文件数据库，对话历史自动保存
- **国际化** — 中文/英文双语支持

## 快速开始

```bash
# 安装依赖
pnpm install

# 配置环境变量
cp .env.example .env
# 编辑 .env 填入 API Key 和管理员密钥

# 开发模式（Vite 5173 + Hono 3001 同时启动）
pnpm dev
```

- 前端：http://localhost:5173
- 后端 API：http://localhost:3001

## 环境变量

编辑 `.env`：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ADMIN_KEY` | （必填） | 管理员密钥，用于访问管理面板 |
| `OPENAI_BASE_URL` | `https://api.openai.com/v1` | OpenAI 兼容 API 地址 |
| `OPENAI_API_KEY` | | API 密钥 |
| `OPENAI_MODEL` | `gpt-4o` | 模型名称 |
| `PORT` | `3001` | 服务端端口 |

## 配置项

管理员面板或 API 可在运行时修改以下配置：

| 配置项 | 类型 | 说明 |
|---|---|---|
| `model` | string | AI 模型名称 |
| `api_endpoint` | string | API 地址 |
| `api_key` | string | API 密钥 |
| `system_prompt` | string | 系统提示词 |
| `support_attachments` | boolean | 是否启用文件附件上传 |
| `show_github` | boolean | 是否在界面中显示 GitHub 链接 |
| `app_name` | string | 应用名称（白标） |
| `app_favicon` | string | Favicon base64 data URL（白标） |
| `app_background` | string | 聊天背景图 base64 data URL（白标） |

## 登录与认证

1. 输入用户名
2. 首次使用：设置 4 位数字 PIN
3. 再次登录：验证 PIN 即可进入
4. PIN 使用 PBKDF2 加盐哈希安全存储于 SQLite（参数详见 `docs/specs/module-auth.md`）
5. 验证成功后获得 JWT（30 天有效），自动保存在浏览器

## 管理面板

点击侧边栏 ⚙️ 图标，输入 `ADMIN_KEY` 后可访问：

- **品牌** — 修改应用名称、Favicon、聊天背景图
- **模型** — 修改 API 地址、密钥、模型名称
- **提示词** — 编辑系统提示词
- **技能** — 上传/卸载技能（.zip 文件）
- **统计** — 查看用户数、对话数、消息数，浏览所有对话详情

## 内置工具

AI 在对话中可自动调用以下内置工具（沙盒隔离，每对话独立工作区，Pi 式并行批执行）：

| 工具 | 说明 |
|------|------|
| `read_file` | 读取工作区文件（text/base64） |
| `write_file` | 写入文件到工作区（产物可下载；第 2 次起温和提醒，不强制拒绝） |
| `list_files` | 列出工作区文件 |
| `delete_file` | 删除工作区文件 |
| `bash` | 在工作区沙盒中执行 Shell 命令（受限 bash，带超时与输出截断，破坏性命令被拦截） |
| `http_request` | 发起出站 HTTP 请求（SSRF 防护） |
| `read_document` | 读取文档内容（DOCX/DOC/PPTX/XLSX/XLS/PDF/CSV） |
| `write_document` | 生成文档文件（DOCX/PPTX/XLSX，产物可下载） |
| `load_skill` | 按需加载技能完整内容 |
| `list_skill_files` | 列出技能目录中的文件 |

所有工具在 `data/workspaces/{conversationId}/` 沙盒内执行，防止访问宿主文件系统。详见 `docs/specs/module-tool-system.md`。

## AI 循环

采用 Pi 风格的循环设计，核心特点：

- **Pi 式并行批执行** — 同一轮中无依赖的工具通过 `Promise.all` 并发执行，结果按模型请求顺序返回
- **多轮工具调用** — 最多连续 5 轮（`MAX_TOOL_ROUNDS`），每轮 AI 可发起新的工具调用
- **漂移检测** — 若模型连续两轮调用完全相同的工具批（相同名称 + 参数），视为模型漂移，强制终止工具阶段
- **批量终止** — 若某轮中所有工具均返回 `terminate: true`，则提前退出循环，不再发起下一轮
- **finishReason = 'length' 保护** — 输出 token 上限被截断时，工具调用被跳过并以错误消息回填，强制模型直接用文本回答

## SSE 事件

服务端通过 Server-Sent Events 向客户端推送以下事件类型：

| 事件类型 | 说明 |
|---|---|
| `token` | AI 回复文本片段 |
| `thinking` | AI 思考过程文本 |
| `tool_call` | AI 请求调用工具（含工具名称和参数） |
| `tool_execution_start` | 工具开始执行（与 `tool_call` 分离，独立事件） |
| `tool_result` | 工具执行结果（含摘要和产物下载链接） |
| `done` | 本轮回复完成（含最终回复文本和后续建议） |
| `error` | 错误信息 |

## 技能开发

技能放在 `skills/` 目录下。系统会递归扫描整个技能目录树，任何包含 `SKILL.md` 的目录自动注册为技能：

```
skills/
├── my-skill/
│   ├── SKILL.md    # YAML 前置元数据 + Markdown 指令内容
│   └── README.md
└── nested/
    └── sub-skill/         # 嵌套在子目录中，也会被自动发现
        ├── SKILL.md
        └── references/
```

**SKILL.md：**
```markdown
---
name: my-skill
description: 帮助处理 X 类任务
version: 1.0.0
---

当用户询问关于 X 的问题时，请遵循以下准则：
1. 首先确认用户的需求
2. 给出具体可行的建议
3. 提供相关示例
```

技能的名称和描述会在每次对话时注入系统提示词的 `## Available Skills` 部分，完整内容通过 `load_skill` 工具按需加载。`list_skill_files` 工具可列出技能目录下的所有文件，帮助 AI 发现子技能和参考资料。

## 生产部署

```bash
# 构建（前端 Vite + 后端 tsup）
pnpm build

# 启动生产服务（Hono 同时提供 API 和静态文件）
pnpm start
# 等效于 node dist/index.js
```

生产模式下 Hono 直接托管前端构建产物，无需额外的 Web 服务器。

## 技术栈

- **前端**：React 18 + shadcn/ui（Radix 原语 + Tailwind CSS）+ Vite 8（Rolldown）
- **后端**：Hono 4 + @libsql/client + Drizzle ORM
- **实时通信**：SSE（Server-Sent Events）
- **AI**：OpenAI 兼容的 Chat Completions API（流式 + function calling + 多模态 + 思考模式）
- **认证**：PBKDF2 PIN 哈希 + JWT（jose）
- **数据库**：SQLite（单文件，零配置）
- **文件解析**：xlsx（Excel→CSV）、pdf-parse（PDF→文本）

## 项目结构

```
momoi/
├── src/
│   ├── shared/          # 客户端与服务端共享的类型和常量
│   ├── client/          # React 前端（入口：main.tsx）
│   │   ├── components/  # UI 组件（shadcn/ui）和业务组件
│   │   │   ├── auth/    # 登录界面（用户名 + PIN）
│   │   │   ├── chat/    # 聊天界面（消息、输入、附件、思考块）
│   │   │   ├── sidebar/ # 侧边栏（对话列表、导出、用户信息）
│   │   │   ├── settings/# 管理面板（6 个标签页）+ 用户菜单
│   │   │   └── ui/      # shadcn/ui 基础组件
│   │   ├── hooks/       # React Hooks（useChat、useAdmin、useTheme）
│   │   ├── lib/         # API 客户端、工具函数
│   │   ├── i18n/        # 国际化配置（zh-CN、en）
│   │   └── styles/      # 全局 CSS（主题变量、滚动条、Mermaid）
│   └── server/          # Hono 后端（入口：index.ts）
│       ├── ai/          # AI 提供商客户端 + function calling 循环
│       ├── tools/       # 内置工具
│       │   ├── types.ts         # 工具模块类型定义
│       │   ├── workspace.ts     # 沙盒文件系统
│       │   ├── registry.ts      # 工具注册表
│       │   ├── file-tools.ts    # 文件读写工具
│       │   ├── http-tool.ts     # HTTP 请求工具
│       │   ├── document-tools.ts# 文档处理工具
│       │   ├── skill-tools.ts   # 技能加载 & 文件列表工具
│       │   ├── bash-tool.ts     # 受限 Shell 命令工具
│       │   └── index.ts         # 工具集合导出
│       ├── skills/      # 技能加载和注册
│       ├── files/       # 文件附件解析（图片、Excel、PDF、文本）
│       ├── middleware/   # 用户 JWT 认证中间件
│       └── routes/      # API 路由
│           ├── chat.ts           # 对话流式接口
│           ├── conversations.ts  # 对话 CRUD
│           ├── admin.ts          # 管理面板
│           ├── upload.ts         # 文件上传
│           ├── user.ts           # 用户认证
│           ├── workspace.ts      # 工作区文件管理
│           └── app.ts            # 应用名称等元信息
├── skills/              # 已安装的技能目录
├── data/                # SQLite 数据库 + 对话工作区（workspaces/）
├── uploads/             # 用户上传的文件附件
└── docs/                # 项目文档
```