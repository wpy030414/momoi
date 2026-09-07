# Open Agent 架构文档

## 系统总览

```
┌─────────────────────────────────────────────────────────────────┐
│                        浏览器（React SPA）                        │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌──────────────┐   │
│  │ Sidebar  │  │ChatPanel │  │ Settings  │  │LoginScreen   │   │
│  │ 对话列表  │  │ 聊天界面  │  │ 管理面板   │  │ PIN 认证登录  │   │
│  └──────────┘  └──────────┘  └───────────┘  └──────────────┘   │
│        │            │              │                │           │
│        └────────────┴──────────────┴────────────────┘           │
│                            │ useChat Hook + API Client          │
└────────────────────────────┼────────────────────────────────────┘
                             │ SSE (POST /api/chat) + REST API + JWT
┌────────────────────────────┼────────────────────────────────────┐
│                     Hono 服务端 (Node.js)                        │
│  ┌─────────────────────────┼─────────────────────────────────┐  │
│  │                      路由层                                │  │
│  │  ┌────────┐ ┌───────────┐ ┌───────┐ ┌────────┐ ┌──────┐ │  │
│  │  │chat.ts │ │conversat. │ │admin  │ │upload  │ │user  │ │  │
│  │  │SSE 聊天 │ │ 对话 CRUD │ │管理API │ │文件上传 │ │PIN   │ │  │
│  │  │+health │ │           │ │       │ │        │ │      │ │  │
│  │  └────────┘ └───────────┘ └───────┘ └────────┘ └──────┘ │  │
│  │  ┌────────┐ ┌───────────┐ ┌────────┐                    │  │
│  │  │workspace│ │  app.ts  │ │  health │                   │  │
│  │  │工作区下载│ │ 应用名称  │ │ (chat内)│                   │  │
│  │  └────────┘ └───────────┘ └────────┘                    │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                     中间件层                                │  │
│  │  ┌──────────────────┐  ┌──────────────────────────────┐   │  │
│  │  │ userAuth.ts      │  │ adminAuthMiddleware          │   │  │
│  │  │ 用户 JWT 认证     │  │ 管理员 JWT 认证               │   │  │
│  │  └──────────────────┘  └──────────────────────────────┘   │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                     业务逻辑层                              │  │
│  │  ┌──────────────────┐  ┌───────────────┐  ┌────────────────┐  │  │
│  │  │ ai/pi-adapter.ts │  │   tools/      │  │  skills/       │  │  │
│  │  │ Pi Agent Core    │  │  内置工具系统  │  │  loader.ts     │  │  │
│  │  │ 适配层           │  │  (沙盒执行)   │  │  + registry    │  │  │
│  │  └──────────────────┘  └───────────────┘  └────────────────┘  │  │
│  │  ┌─────────────┐  ┌───────────────┐  ┌────────────────┐  │  │
│  │  │ai/provider  │  │  config.ts    │  │   auth.ts      │  │  │
│  │  │ API 客户端   │  │  配置管理      │  │  PIN+JWT 认证  │  │  │
│  │  └─────────────┘  └───────────────┘  └────────────────┘  │  │
│  │  ┌─────────────┐                                         │  │
│  │  │files/parser │  附件解析（图片→base64, xlsx→csv, pdf→text）│  │
│  │  └─────────────┘                                         │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                     数据层                                  │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │  db.ts — SQLite (@libsql/client + Drizzle ORM)      │  │  │
│  │  │  conversations | messages (含 attachments) | settings│  │  │
│  │  │  + data/workspaces/{conversationId}/ (工具沙盒)       │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 数据流

### 聊天消息流（SSE）

```
用户输入（+ 可选附件 + 思考模式开关）→ POST /api/chat
  → userAuthMiddleware 验证 JWT
  → 保存用户消息到 DB（含附件元数据）
  → 加载历史消息（最近 20 条）
  → 解析附件（图片→base64 多模态、xlsx→csv、pdf→text）
  → 文档附件复制到对话工作区（docx/pptx/xlsx/pdf）
  → runPiAgentLoop()（基于 @earendil-works/pi-agent-core 内核）
    → buildSystemPrompt()（注入技能摘要 + 工具使用规范 + 防漂移/写文件节制/工具节制规则）
    → createToolAdapter()（将 ToolModule 包装为 Pi AgentTool，TypeBox 参数校验）
    → createStreamFn()（包装 provider.ts 为 Pi 兼容 StreamFn）
    → runAgentLoop()（Pi 原生 Agent 循环，内置多轮工具调用 + 并行执行）
      → 逐 token 流式输出（SSE event: token）
      → 流式输出思考过程（SSE event: thinking，含分隔符分段）
      → 工具调用：Pi 自动管理 tool_execution_start/end 事件
      → 工具产物（artifacts）通过 SSE 下发下载链接
      → 系统提示词硬性规则约束（防漂移、写文件节制、工具节制）
      → 最终回复（统一收口）：
          → 解析 suggestions 代码块
          → 发送 done 事件（完整回复 + 建议 + artifacts）
  → 保存助手消息到 DB（含 thinking、suggestions、artifacts 作为 attachments）
  → 客户端收到 done → 更新 UI → 刷新对话列表
```

### SSE 事件类型

```typescript
type ServerMessage =
  | { type: 'conversation_id'; id: string }
  | { type: 'token'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id?: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_execution_start'; id?: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id?: string; name: string; summary: string; artifacts?: ToolArtifact[] }
  | { type: 'done'; reply: string; suggestions: string[] }
  | { type: 'error'; message: string }
```

### 配置数据流

```
环境变量 (.env)
  ↓ 启动时读取
config.ts → env 对象（不可热更新）
  ↓ 作为默认值
SQLite settings 表（可热更新）
  ↓ 管理员通过 PUT /api/admin/config 修改
getConfig() → 运行时配置（优先使用 DB 值）
  ↓
AppConfig 字段：
  app_name, app_favicon, app_background    — 品牌
  api_endpoint, api_key, model             — LLM 连接
  system_prompt                            — 系统提示词
  support_attachments                      — 附件开关
  show_github                              — 显示 GitHub 链接
```

### 用户认证流

```
用户打开应用
  → localStorage 有 JWT？→ 验证有效 → 直接进入
  → 无 JWT → 显示 LoginScreen
    → 输入用户名
    → GET /api/user/status → 有 PIN？
      → 有 PIN → 输入 PIN → POST /api/user/verify → JWT（30天）
      → 无 PIN → 设置 PIN → POST /api/user/set-pin → JWT（30天）
  → JWT 存入 localStorage → 进入主界面
```

## 模块依赖关系

```
routes/chat.ts
  ├── health (GET /api/chat/health)
  ├── ai/pi-adapter.ts（Pi Agent Core 适配层）
  │     ├── @earendil-works/pi-agent-core（runAgentLoop）
  │     ├── @earendil-works/pi-ai（createAssistantMessageEventStream）
  │     ├── @sinclair/typebox（工具参数 schema）
  │     ├── ai/provider.ts（API 客户端——被 createStreamFn 包装）
  │     ├── ai/tools.ts（工具注册表 → 委托到 tools/registry.ts）
  │     ├── tools/registry.ts（内置工具聚合）
  │     │     ├── tools/file-tools.ts（read_file / write_file）
  │     │     ├── tools/http-tool.ts（http_request）
  │     │     ├── tools/document-tools.ts（read_document / write_document）
  │     │     ├── tools/skill-tools.ts（load_skill / list_skills）
  │     │     ├── tools/bash-tool.ts（受限 bash 执行）
  │     │     └── tools/types.ts（ToolContext, ToolResult, ToolModule, ToolArtifact）
  │     ├── tools/workspace.ts（沙盒文件系统）
  │     ├── skills/registry.ts（技能注册表）
  │     └── config.ts（获取配置）
  ├── files/parser.ts（附件解析）
  ├── db.ts（数据库）
  └── schema.ts（Drizzle 表定义）

routes/conversations.ts
  ├── db.ts
  ├── schema.ts
  └── middleware/userAuth.ts
  （删除对话时同步清理 data/workspaces/{id}/）

routes/admin.ts
  ├── auth.ts（JWT 认证）
  ├── config.ts（配置管理）
  └── skills/loader.ts（技能注册表）

routes/app.ts（GET /api/app-name → 应用名称/品牌信息）
  └── config.ts

routes/workspace.ts
  ├── tools/workspace.ts（沙盒文件系统）
  ├── db.ts（对话所有权验证）
  └── middleware/userAuth.ts

routes/upload.ts
  └── middleware/userAuth.ts

routes/user.ts
  ├── auth.ts（PIN 哈希 + JWT 签发）
  ├── db.ts
  └── schema.ts
```

## 数据库 Schema

```sql
conversations
├── id TEXT PRIMARY KEY          -- UUID
├── user_id TEXT                 -- 用户名（JWT sub）
├── title TEXT                   -- 对话标题（默认取消息前 40 字符）
├── created_at INTEGER           -- Unix epoch (秒)
└── updated_at INTEGER           -- Unix epoch (秒)

messages
├── id INTEGER PRIMARY KEY       -- 自增
├── conversation_id TEXT FK      -- 关联 conversations，级联删除
├── role TEXT                    -- user | assistant | system | tool
├── content TEXT                 -- 消息内容
├── thinking TEXT                -- AI 思考过程（可选）
├── tool_calls TEXT              -- JSON 序列化的工具调用数组（tool_call_id 关联工具结果）
├── tool_call_id TEXT            -- 工具响应关联的调用 ID（可选）
├── suggestions TEXT             -- JSON 序列化的建议数组（可选）
├── attachments TEXT             -- JSON 序列化的附件/产物数组（可选）
└── created_at INTEGER           -- Unix epoch (秒)

settings
├── key TEXT PRIMARY KEY         -- 配置键（含 pin:{username}、app_name、show_github 等）
└── value TEXT                   -- 配置值
```

## 前端组件树

```
App
├── LoginScreen                  -- PIN 认证登录（用户名 → PIN 验证/设置）
├── Sidebar
│     ├── 新建对话按钮
│     ├── 对话列表（重命名、导出、删除）
│     └── 用户信息/菜单按钮
├── ChatPanel
│     ├── MessageList
│     │     └── MessageBubble[]  -- 每条消息
│     │           ├── ThinkingBlock   -- 可折叠的思考过程
│     │           ├── ToolCallsPanel  -- 工具调用列表（含产物下载卡片）
│     │           ├── AttachmentCard[] -- 文件附件卡片
│     │           ├── MessageContent  -- Markdown + Mermaid 渲染
│     │           └── SuggestionChips -- 后续建议按钮
│     ├── InputBar               -- 文本输入 + 附件上传 + 思考模式开关 + 发送
├── SettingsDialog               -- 管理员面板（需密钥认证）
│     ├── BrandingTab            -- 应用名称、Favicon、背景图、GitHub 链接
│     ├── ModelTab               -- API 地址、密钥、模型
│     ├── PromptTab              -- 系统提示词
│     ├── SkillsTab              -- 技能管理
│     └── StatsTab               -- 统计面板（用户/对话/消息 + 浏览）
├── MenuDialog                   -- 用户菜单
│     ├── 语言切换
│     ├── 主题切换
│     ├── 管理设置入口
│     ├── 修改 PIN
│     └── 登出
└── ChangePinDialog              -- 修改 PIN（旧 PIN + 新 PIN + 确认）
```

## 认证模型

```
用户层：
  用户名 + 4 位 PIN
  PIN → PBKDF2（SHA-512, 10000 次, 随机 16 字节盐）→ settings 表 (pin:{username})
  验证成功 → signUserToken() → JWT (HS256, 30天, role:'user', sub:username)
  请求 → Authorization: Bearer <jwt>
  userAuthMiddleware → verifyUserToken() → c.set('userId', username)
  回退：无 JWT 时接受 X-User 头（向后兼容）

管理员层：
  POST /api/admin/auth + ADMIN_KEY → JWT (HS256, 24h, role:'admin')
  后续请求 → Authorization: Bearer <jwt>
  adminAuthMiddleware → verifyAdminToken()
  ⚠️ API Key 明文返回（脱敏未实现，见 specs/module-admin.md 已知缺陷）

安全细节：
  - PBKDF2 10000 次迭代 + SHA-512
  - timingSafeEqual 防止时序攻击
  - ADMIN_KEY 永远不暴露给前端
  - 两种 JWT 共用同一个签名密钥（ADMIN_KEY 的 UTF-8 字节）
```

## 部署架构

```
开发模式：
  Vite Dev Server (:5173)  ──proxy──→  Hono (:3001)

生产模式：
  Hono (:3001)  ── 直接托管 ──→  dist/client/ 静态文件
              └── API 路由 ──→  /api/*
```