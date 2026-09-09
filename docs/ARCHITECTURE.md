# Momoi 架构文档

## 系统总览

```
┌─────────────────────────────────────────────────────────────────┐
│                        浏览器（React SPA）                        │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌──────────────┐   │
│  │ Sidebar  │  │ChatPanel │  │AdminScreen│  │LoginScreen   │   │
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
│  │  │chat.ts │ │conversat. │ │group  │ │admin   │ │upload│ │  │
│  │  │SSE 聊天 │ │ 对话 CRUD │ │群聊API │ │管理API  │ │文件  │ │  │
│  │  └────────┘ └───────────┘ └───────┘ └────────┘ └──────┘ │  │
│  │  ┌────────┐ ┌───────────┐ ┌────────┐                    │  │
│  │  │workspace│ │  app.ts  │ │user.ts │                    │  │
│  │  │工作区下载│ │ 应用名称  │ │PIN认证 │                    │  │
│  │  └────────┘ └───────────┘ └────────┘                    │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                     中间件层                                │  │
│  │  ┌──────────────────┐  ┌──────────────────────────────┐   │  │
│  │  │ userAuth.ts      │  │ adminAuthMiddleware          │   │  │
│  │  │ 用户 JWT 认证     │  │ 管理员 JWT 认证               │   │  │
│  │  └──────────────────┘  └──────────────────────────────┘   │  │
│  │  ┌──────────────────┐                                     │  │
│  │  │ rateLimiter.ts   │  IP 速率限制（PIN 登录）             │  │
│  │  └──────────────────┘                                     │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                     业务逻辑层                              │  │
│  │  ┌──────────────────┐  ┌───────────────────┐  ┌────────────────┐  │  │
│  │  │ ai/pi-adapter.ts │  │ai/group-orchestr. │  │ai/neutral-agent│  │  │
│  │  │ Pi Agent Core    │  │ 群聊编排           │  │ 中立 Agent 调度│  │  │
│  │  │ 适配层           │  │ (串行多Agent对话)  │  │ (追问/建议)    │  │  │
│  │  └──────────────────┘  └───────────────────┘  └────────────────┘  │  │
│  │  ┌──────────────────┐  ┌───────────────┐  ┌────────────────┐  │  │
│  │  │   tools/         │  │  skills/      │  │   config.ts    │  │  │
│  │  │  12 个内置工具    │  │  loader.ts    │  │  配置管理       │  │  │
│  │  │  (沙盒执行)      │  │  + registry   │  │  + Agent CRUD  │  │  │
│  │  └──────────────────┘  └───────────────┘  └────────────────┘  │  │
│  │  ┌──────────────┐  ┌────────────────────────────────────┐  │  │
│  │  │   auth.ts    │  │  files/parser.ts                   │  │  │
│  │  │  PIN+JWT认证 │  │  附件解析（图片→base64, xlsx→csv,  │  │  │
│  │  └──────────────┘  │  pdf→text, docx→text）             │  │  │
│  │                    └────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │                     数据层                                  │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │  db.ts — SQLite (@libsql/client + Drizzle ORM)      │  │  │
│  │  │  conversations | messages | settings | agents       │  │  │
│  │  │  group_conversation_agents                          │  │  │
│  │  │  + data/workspaces/{conversationId}/ (工具沙盒)       │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 数据流

### 聊天消息流（SSE — 直接对话）

```
用户输入 → POST /api/chat
  → userAuthMiddleware 验证 JWT
  → 确定 Agent（agent_id 参数或默认 Agent）
  → 保存用户消息到 DB
  → 加载历史消息（最近 20 条）
  → 解析附件
  → runPiAgentLoop()
    → buildSystemPrompt()（注入 Agent 提示词 + 技能摘要 + 硬性规则）
    → createToolAdapter()（12 个 ToolModule → Pi AgentTool）
    → createStreamFn()（provider.ts → Pi StreamFn）
    → runAgentLoop()（Pi 原生循环，并行工具执行）
      → SSE 事件流：token / thinking / tool_call / tool_result
      → suggestions 围栏扣留
      → done 事件（完整回复 + 建议）
  → 保存助手消息到 DB
  → 无限模式：若开启，generateNeutralFollowUp() → follow_up 事件 → 重新加载历史 → 新一轮循环
```

### 群聊消息流（SSE）

```
用户输入 → POST /api/chat (conversation_type: 'group')
  → 创建/获取群聊对话
  → orchestrateGroupChat()
    → 随机打乱 Agent 顺序
    → 每个 Agent 依次：
      → prepareGroupHistory()（前序回复以 user 角色 + 名字前缀注入）
      → runPiAgentLoop()（该 Agent 独立回复）
      → SSE: agent_start → token/thinking/tool_call → agent_done
      → @mention 拦截：被点名 Agent 立即应答
    → 无限模式（若开启）：generateNeutralFollowUp() → follow_up 事件
    → SSE: group_done
```

### SSE 事件类型

```typescript
type ServerMessage =
  | { type: 'conversation_id'; id: string }
  | { type: 'token'; text: string; agent_id?: string; agent_name?: string }
  | { type: 'thinking'; text: string; round?: number; agent_id?: string; agent_name?: string }
  | { type: 'tool_call'; id?: string; name: string; input: Record<string, unknown>; agent_id?: string; agent_name?: string }
  | { type: 'tool_execution_start'; id?: string; name: string; input: Record<string, unknown>; agent_id?: string; agent_name?: string }
  | { type: 'tool_result'; id?: string; name: string; summary: string; artifacts?: Array<{...}>; agent_id?: string; agent_name?: string }
  | { type: 'agent_start'; agent_id: string; agent_name: string }
  | { type: 'agent_done'; agent_id: string; agent_name: string; reply: string; suggestions: string[] }
  | { type: 'group_start'; agent_ids: string[] }
  | { type: 'group_done'; infinite?: boolean }
  | { type: 'follow_up'; text: string }
  | { type: 'infinite_mode_off' }
  | { type: 'done'; reply: string; suggestions: string[]; agent_id?: string; agent_name?: string; infinite?: boolean }
  | { type: 'error'; message: string; agent_id?: string; agent_name?: string }
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
  api_endpoint, api_key                    — LLM 连接
  support_attachments                      — 附件开关
  show_github                              — 显示 GitHub 链接

Agent 级配置（存储在 agents 表）：
  model, system_prompt                     — 每个 Agent 独立配置
  → 通过 getAgent(id) 查询
```

### 用户认证流

```
用户打开应用
  → localStorage 有 JWT？→ 验证有效 → 直接进入
  → 无 JWT → 显示 LoginScreen
    → 输入用户名
    → GET /api/user/status → 有 PIN？
      → 有 PIN → 输入 PIN → POST /api/user/verify → JWT（14天）
      → 无 PIN → 设置 PIN → POST /api/user/set-pin → JWT（14天）
  → JWT 存入 localStorage → 进入主界面
```

## 模块依赖关系

```
routes/chat.ts
  ├── ai/pi-adapter.ts（Pi Agent Core 适配层）
  │     ├── @earendil-works/pi-agent-core（runAgentLoop）
  │     ├── @earendil-works/pi-ai（createAssistantMessageEventStream）
  │     ├── @sinclair/typebox（工具参数 schema）
  │     ├── ai/provider.ts（API 客户端）
  │     ├── ai/tools.ts → tools/registry.ts（12 个内置工具）
  │     ├── skills/registry.ts（技能注册表）
  │     └── config.ts（获取 Agent 配置）
  ├── ai/group-orchestrator.ts（群聊编排）
  │     ├── ai/pi-adapter.ts
  │     ├── tools/group-mention-tool.ts（@mention）
  │     └── config.ts（getAgent）
  ├── ai/neutral-agent.ts（中立：追问 / 建议 / 发言调度）
  ├── files/parser.ts（附件解析）
  ├── db.ts + schema.ts
  └── middleware/userAuth.ts + rateLimiter.ts

routes/group.ts
  ├── db.ts + schema.ts
  └── middleware/userAuth.ts

routes/conversations.ts
  ├── db.ts + schema.ts
  └── middleware/userAuth.ts

routes/admin.ts
  ├── auth.ts（JWT 认证）
  ├── config.ts（配置 + Agent CRUD）
  └── skills/loader.ts（技能注册表）

routes/app.ts → config.ts
routes/workspace.ts → tools/workspace.ts + db.ts + middleware/userAuth.ts
routes/upload.ts → middleware/userAuth.ts
routes/user.ts → auth.ts + db.ts + schema.ts + rateLimiter.ts
```

## 数据库 Schema

```sql
conversations
├── id TEXT PRIMARY KEY          -- UUID
├── user_id TEXT                 -- 用户名（JWT sub）
├── title TEXT                   -- 对话标题（默认取消息前 40 字符）
├── agent_id TEXT                -- 直接对话：关联的 Agent ID
├── type TEXT                    -- 'direct' | 'group'
├── created_at INTEGER           -- Unix epoch (秒)
├── updated_at INTEGER           -- Unix epoch (秒)
└── deleted_at INTEGER           -- 软删除时间戳

messages
├── id INTEGER PRIMARY KEY       -- 自增
├── conversation_id TEXT FK      -- 关联 conversations，级联删除
├── role TEXT                    -- user | assistant | system | tool
├── content TEXT                 -- 消息内容
├── thinking TEXT                -- AI 思考过程（可选）
├── tool_calls TEXT              -- JSON 序列化的工具调用数组
├── tool_call_id TEXT            -- 工具响应关联的调用 ID（可选）
├── suggestions TEXT             -- JSON 序列化的建议数组（可选）
├── attachments TEXT             -- JSON 序列化的附件/产物数组（可选）
├── agent_id TEXT                -- 群聊中发言者的 Agent ID（可选）
└── created_at INTEGER           -- Unix epoch (秒)

settings
├── key TEXT PRIMARY KEY         -- 配置键（含 pin:{username}、app_name、show_github 等）
└── value TEXT                   -- 配置值

agents
├── id TEXT PRIMARY KEY          -- UUID（neutral 角色固定为 'neutral-agent'）
├── name TEXT                    -- Agent 名称
├── model TEXT                   -- 该 Agent 使用的模型
├── system_prompt TEXT           -- 该 Agent 的系统提示词
├── avatar TEXT                  -- 头像（base64 data URL）
├── role TEXT                    -- 'default' | 'neutral'
└── created_at INTEGER           -- Unix epoch (秒)

group_conversation_agents
├── conversation_id TEXT FK      -- 群聊对话 ID
├── agent_id TEXT FK             -- 参与的 Agent ID
├── sort_order INTEGER           -- 排序权重
└── PRIMARY KEY (conversation_id, agent_id)
```

## 前端组件树

```
App
├── LoginScreen
├── Sidebar
│     ├── 新建对话 / 新建群聊按钮
│     ├── 对话列表（直接对话 + 群聊，含 Agent 数量和类型标识）
│     └── 用户信息/菜单按钮
├── ChatPanel
│     ├── MessageList
│     │     └── MessageBubble[]
│     │           ├── AgentAvatar（群聊中显示发言者头像和名字）
│     │           ├── ThinkingBlock
│     │           ├── ToolCallsPanel
│     │           ├── AttachmentCard[]
│     │           ├── MessageContent（Markdown + Mermaid）
│     │           └── SuggestionChips
│     ├── InputBar（文本输入 + 附件 + 思考模式 + 无限模式开关 + 发送）
├── AdminScreen（密钥认证）
│     ├── AgentManager（Agent CRUD）
│     ├── GatewaySettings（API 地址 + 密钥）
│     ├── BrandingSettings（应用名称 + Favicon + 背景图）
│     ├── SkillManager（技能管理）
│     └── StatsPanel（统计 + 对话浏览）
├── MenuDialog（语言/主题/管理员/修改 PIN/登出）
└── ChangePinDialog
```

## 认证模型

```
用户层：
  用户名 + 4 位 PIN
  PIN → PBKDF2（SHA-512, 10000 次, 随机 16 字节盐）→ settings 表 (pin:{username})
  验证成功 → signUserToken() → JWT (HS256, 14天, role:'user', sub:username)
  续期 → 剩余不足一半（<7天）时客户端 POST /api/user/refresh → 换发新 14 天 JWT（滑动会话）
  请求 → Authorization: Bearer <jwt>
  userAuthMiddleware → verifyUserToken() → c.set('userId', username)

IP 速率限制：
  同一 IP 连续 5 次 PIN 错误 → 封禁 5 分钟
  状态仅存于内存（rateLimiter.ts），重启服务即清除
  成功登录后自动清除该 IP 的失败记录

管理员层：
  ADMIN 环境变量 = 管理员用户名名单（逗号分隔，进程生命周期内固定）
  管理端点 → Authorization: Bearer <用户 JWT>
  adminAuthMiddleware → verifyUserToken() + isAdmin(username)（名单内放行，否则 403）
  客户端入口显隐 → GET /api/user/me → { username, is_admin }

安全细节：
  - PBKDF2 10000 次迭代 + SHA-512
  - timingSafeEqual 防止时序攻击
  - JWT 签名密钥：JWT_SECRET 环境变量，或首启随机生成并持久化到 settings 表
  - ADMIN 名单与 JWT_SECRET 不暴露给前端；客户端仅能通过 /me 得知自己是否管理员
```

## 部署架构

```
开发模式：
  Vite Dev Server (:5173)  ──proxy──→  Hono (:PORT, 默认 3001)

生产模式：
  Hono (:PORT, 默认 3001)  ── 直接托管 ──→  dist/client/ 静态文件
              └── API 路由 ──→  /api/*
```