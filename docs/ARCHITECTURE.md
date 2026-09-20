# Momoi 架构文档

## 系统总览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         浏览器（React SPA）                                   │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌──────────────┐  ┌──────────┐│
│  │ Sidebar  │  │ChatPanel │  │AdminScreen│  │LoginScreen   │  │OAuthLogin││
│  │ 对话列表  │  │ 聊天界面  │  │ 管理面板   │  │ PIN 认证登录  │  │ OAuth登录 ││
│  └──────────┘  └──────────┘  └───────────┘  └──────────────┘  └──────────┘│
│        │            │              │                │               │       │
│        └────────────┴──────────────┴────────────────┴───────────────┘       │
│                             │ useChat Hook + API Client                     │
└─────────────────────────────┼───────────────────────────────────────────────┘
                              │ SSE (POST /api/chat + GET /api/events) + REST + JWT
┌─────────────────────────────┼───────────────────────────────────────────────┐
│                      Hono 服务端 (Node.js)                                   │
│  ┌──────────────────────────┼────────────────────────────────────────────┐  │
│  │                        路由层                                          │  │
│  │  ┌────────┐ ┌───────────┐ ┌───────┐ ┌────────┐ ┌──────┐ ┌────────┐  │  │
│  │  │chat.ts │ │conversat. │ │group  │ │admin   │ │upload│ │oauth   │  │  │
│  │  │SSE 聊天 │ │ 对话 CRUD │ │群聊API │ │管理API  │ │文件  │ │OAuth2  │  │  │
│  │  └────────┘ └───────────┘ └───────┘ └────────┘ └──────┘ └────────┘  │  │
│  │  ┌────────┐ ┌───────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌───────┐ │  │
│  │  │workspace│ │  app.ts  │ │user.ts │ │voice.ts│ │wechat  │ │ qq.ts │ │  │
│  │  │工作区下载│ │ 应用名称  │ │PIN认证 │ │语音片段│ │微信绑定│ │QQ绑定 │ │  │
│  │  └────────┘ └───────────┘ └────────┘ └────────┘ └────────┘ └───────┘ │  │
│  │  ┌──────────┐ ┌───────────┐                                          │  │
│  │  │assets.ts │ │events.ts  │                                          │  │
│  │  │静态资源  │ │SSE 事件流 │                                          │  │
│  │  └──────────┘ └───────────┘                                          │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                       中间件层                                          │  │
│  │  ┌──────────────────┐  ┌──────────────────────────────┐               │  │
│  │  │ userAuth.ts      │  │ adminAuthMiddleware          │               │  │
│  │  │ 用户 JWT 认证     │  │ 用户 JWT + ADMIN 名单校验      │               │  │
│  │  └──────────────────┘  └──────────────────────────────┘               │  │
│  │  ┌──────────────────┐                                                  │  │
│  │  │ rateLimiter.ts   │  IP 速率限制（PIN 登录）                          │  │
│  │  └──────────────────┘                                                  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                       业务逻辑层                                        │  │
│  │  ┌──────────────────┐  ┌───────────────────┐  ┌────────────────┐      │  │
│  │  │ ai/pi-adapter.ts │  │ai/group-orchestr. │  │ai/neutral-agent│      │  │
│  │  │ Pi Agent Core    │  │ 群聊编排           │  │ 中立 Agent 调度│      │  │
│  │  │ 适配层           │  │ (串行多Agent对话)  │  │ (追问/建议)    │      │  │
│  │  └──────────────────┘  └───────────────────┘  └────────────────┘      │  │
│  │  ┌──────────────────┐  ┌───────────────┐  ┌────────────────┐          │  │
│  │  │   tools/         │  │  skills/      │  │   config.ts    │          │  │
│  │  │  12 个内置工具    │  │  loader.ts    │  │  配置管理       │          │  │
│  │  │  (沙盒执行)      │  │  + registry   │  │  + Agent CRUD  │          │  │
│  │  └──────────────────┘  └───────────────┘  └────────────────┘          │  │
│  │  ┌──────────────┐  ┌────────────────────────────────────┐             │  │
│  │  │   auth.ts    │  │  files/parser.ts                   │             │  │
│  │  │  PIN+JWT认证 │  │  附件解析（图片→base64, xlsx→csv,  │             │  │
│  │  └──────────────┘  │  pdf→text, docx→text）             │             │  │
│  │                    └────────────────────────────────────┘             │  │
│  │  ┌────────────────────────────────────────────────────────────────┐   │  │
│  │  │  wechat/chat.ts          wechat/poller.ts    wechat/ilink.ts  │   │  │
│  │  │  微信消息→AI→回复桥接     微信消息轮询器       iLink API 客户端 │   │  │
│  │  └────────────────────────────────────────────────────────────────┘   │  │
│  │  ┌────────────────────────────────────────────────────────────────┐   │  │
│  │  │  qq/gateway.ts + manager.ts    qq/api.ts          qq/chat.ts   │   │  │
│  │  │  QQ WS网关连接+注册表          QQ REST协议客户端  QQ消息→AI桥接 │   │  │
│  │  └────────────────────────────────────────────────────────────────┘   │  │
│  │  ┌────────────────────────────────────────────────────────────────┐   │  │
│  │  │  ai/tts.ts               realtime.ts                            │   │  │
│  │  │  TTS 引擎（GPT-SoVITS /  同账号多设备实时事件总线                  │   │  │
│  │  │   CosyVoice 双 Provider） (进程内发布-订阅)                       │   │  │
│  │  └────────────────────────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                       数据层                                            │  │
│  │  ┌────────────────────────────────────────────────────────────────┐    │  │
│  │  │  db.ts — SQLite (@libsql/sql.js + Drizzle ORM)                │    │  │
│  │  │  PostgreSQL (pg + Drizzle ORM, DATABASE_URL 环境变量切换)       │    │  │
│  │  │  conversations | messages | settings | agents                 │    │  │
│  │  │  group_conversation_agents | mcp_servers | users              │    │  │
│  │  │  user_oauth_bindings | wechat_bindings | qq_bindings           │    │  │
│  │  │  + data/workspaces/{conversationId}/ (工具沙盒)                 │    │  │
│  │  │  + data/voice/{agentId}/{messageId}/ (TTS 音频缓存)            │    │  │
│  │  └────────────────────────────────────────────────────────────────┘    │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
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
    → 加载跨会话用户记忆（最近 30 条；中立 Agent / 身份未知 / QQ 群聊时跳过）
    → buildSystemPrompt()（注入 Agent 提示词 + 用户记忆 + 跨会话记忆规则 + 技能摘要 + 硬性规则）
    → createToolAdapter()（12 个 ToolModule → Pi AgentTool；中立 Agent / QQ 群聊剔除 save_memory）
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

### 微信消息流（轮询器 + 桥接）

```
startWechatPoller()（进程启动时自动开始，定时轮询）
  → 遍历 wechat_bindings 表，检查 updates_buf 中是否有待处理更新
  → 检测到新消息 → handleWechatMessage()
    → 重复消息去重（messageId + 5 分钟窗口）
    → 用户级并发锁（同一用户串行处理）
    → 查询绑定行，验证 sender 合法性（专属 1v1 通道校验）
    → 处理内置命令（/clear /new /reset）
    → 加载绑定会话 → 保存用户消息 → 加载历史
    → runPiAgentLoop()（复用同一 AI 引擎，无 SSE 输出）
    → 保存助手回复到 DB
    → sendMessage()（iLink API，含指数退避重试，最多 3 次）
      → 会话过期检测：errcode=-14 → 标记 session_expired
      → 发送失败：写入系统消息通知用户
```

### QQ 消息流（WS 网关推送 + 流式桥接）

```
initQqBots()（进程启动时恢复所有已绑定用户的连接）
  → qq/manager.ts per-user 注册表（幂等启停，锁串行化防双连接）
  → qq/gateway.ts QQGatewayConnection
    → qq/api.ts getAccessToken + /gateway → WS 出站连接（无需公网 IP）
    → HELLO → 心跳；IDENTIFY/RESUME；关闭码策略重连（4914/4915 致命停连）
    → DISPATCH: C2C_MESSAGE_CREATE → handleQqMessage()
      → 重复消息去重（messageId + 5 分钟窗口）
      → 跨渠道用户级锁（withUserImLock，与微信共享——双渠道可绑同一会话）
      → 新鲜度守卫：重读绑定行，app_id 不符即丢弃（换凭证后在飞消息）
      → 处理内置命令（/clear /new /reset）
      → 加载绑定会话 → 保存用户消息 → 加载历史
      → runPiAgentLoop()（token 增量喂 QqStreamSender，SSE 同步网页端）
      → 保存助手回复到 DB
      → QqStreamSender：stream_messages 打字机流式（800ms 节流，replace 全量帧）
        → 失败降级 sendText 分片（>4000 字符切片，瞬时错误退避重试）
        → 最终失败：写入系统消息通知用户
```

### OAuth 认证流

```
用户打开应用
  → LoginScreen 显示 OAuth 提供商按钮（来自 GET /api/oauth/providers）
  → 用户点击某提供商 → GET /api/oauth/:providerId/login
    → 生成 state（32 字节随机 hex）+ 设置 HttpOnly Cookie
    → 重定向到提供商授权页
  → 用户授权 → 提供商回调 GET /api/oauth/callback?code=...&state=...
    → 校验 state（防 CSRF）
    → 用 code 换 access_token → 用 access_token 拉 userinfo
    → 获取 provider_user_id（sub/id/user_id）
    → 查询 user_oauth_bindings 表：
      ├── 已有绑定 → 直接登录（set JWT cookie + 重定向回 SPA）
      ├── 无绑定但已登录 → 绑定到当前账号（link）
      └── 全新 OAuth 用户 → 检查 oauth_registration_open
            ├── 开放 → 重定向到 OAuth 注册页
            └── 关闭 → 返回错误
  → OAuth 注册 POST /api/oauth/register
    → action='link'：验证已有账号 PIN → 添加绑定 → 签发 JWT
    → action='create'：检查用户名唯一 + 注册门控 → 创建用户 + 绑定 → 签发 JWT
```

### 多设备实时同步流（SSE 事件通道）

```
设备 A 打开 GET /api/events?device_id=xxx（SSE 长连接）
  → userAuthMiddleware 认证 → subscribeRealtime(userId, deviceId)
  → 挂起 SSE 流，周期性 15s keepalive 心跳

设备 B 发起聊天 POST /api/chat（同一 userId）
  → 聊天流事件通过 broadcastStream(userId, originDeviceId, data) 广播
    → publish() 跳过来源设备 deviceId
    → 推送给设备 A 的 SSE 通道 { type: 'stream', conversation_id, event }
  → 设备 A 前端 onmessage 解析 → 实时渲染 Agent 思考/流式内容

会话操作广播：
  → broadcastConversationSync(userId) → { type: 'conv_sync' }  → 设备刷新侧边栏
  → broadcastConversationChanged(userId, convId) → { type: 'conv_changed' } → 重新拉取消息
  → broadcastGroupMembers(userId, convId) → { type: 'group_members' } → 同步群成员
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

// 实时事件（GET /api/events）—— 以 type 字段区分
| { type: 'stream'; conversation_id: string; event: ServerMessage }
| { type: 'conv_sync' }
| { type: 'conv_changed'; conversation_id: string }
| { type: 'group_members'; conversation_id: string }
```

### 配置数据流

```
环境变量 (.env)
  ↓ 启动时读取
config.ts → env 对象（不可热更新）
  ADMIN, JWT_SECRET, OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_MODEL, PORT
  ↓ 作为默认值
SQLite / PostgreSQL settings 表（可热更新）
  ↓ 管理员通过 PUT /api/admin/config 修改
getConfig() → 运行时配置（优先使用 DB 值）
  ↓
AppConfig 字段：
  app_name, app_favicon, app_background            — 体验（应用外观定制）
  api_endpoint, api_key                             — LLM 连接
  support_attachments                               — 附件开关
  support_infinite_mode                             — 无限模式开关
  show_github                                       — 显示 GitHub 链接
  use_external_image_hosting                        — 外部图床开关
  recommended_questions                             — 首页推荐问题列表（JSON，空对话展示）
  followup_questions                                — 聊天常用追问（JSON，最多 5 条，非空对话输入框上方气泡）
  oauth_providers                                   — OAuth2 提供商配置（JSON）

Agent 级配置（存储在 agents 表）：
  model, system_prompt                              — 每个 Agent 独立配置
  voice_enabled, voice_sample_url, voice_settings   — TTS 语音配置
  → 通过 getAgent(id) 查询

TTS 配置（存储在 settings 表）：
  tts_api_endpoint                                  — TTS 服务地址
  tts_provider                                      — TTS Provider（gpt-sovits | cosyvoice）

注册门控（存储在 settings 表）：
  direct_registration_open                          — PIN 直接注册开关（默认 true）
  oauth_registration_open                           — OAuth 新用户注册开关（默认 true）
```

### 用户认证流

```
用户打开应用
  → localStorage 有 user + 浏览器有 HttpOnly Cookie？→ 验证有效 → 直接进入
  → 无 → 显示 LoginScreen
    → 输入用户名
    → GET /api/user/status → 有 PIN？
      → 有 PIN → 输入 PIN → POST /api/user/verify → Set-Cookie momoi_token（HttpOnly, 14天）
      → 无 PIN → 设置 PIN → POST /api/user/set-pin → Set-Cookie momoi_token（HttpOnly, 14天）
  → localStorage 仅存 username + expires_at（非机密）→ 进入主界面
```

## 模块依赖关系

> Momoi 为 **pnpm monorepo**（`apps/server` + `apps/web` + `packages/shared`）。`@momoi/shared` 以 TS 源码直引（exports → `./src/*.ts`，零构建），tsup 内联到 server bundle；`data/`、`skills/`、`docs/`、`.env` 位于仓库根目录，`dist/` 为根级构建产物，服务端经 `REPO_ROOT`（向上找 `pnpm-workspace.yaml` 标记）锚定访问。

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
  ├── realtime.ts（多设备实时广播）
  ├── ai/tts.ts（TTS 语音合成，流式分段）
  └── middleware/userAuth.ts + rateLimiter.ts

routes/group.ts
  ├── db.ts + schema.ts
  └── middleware/userAuth.ts

routes/conversations.ts
  ├── db.ts + schema.ts
  └── middleware/userAuth.ts

routes/admin.ts
  ├── auth.ts（JWT 认证）
  ├── config.ts（配置 + Agent CRUD + MCP Server CRUD + TTS 配置）
  └── skills/loader.ts（技能注册表）

routes/app.ts → config.ts
routes/workspace.ts → tools/workspace.ts + db.ts + middleware/userAuth.ts
routes/upload.ts → middleware/userAuth.ts
routes/user.ts → auth.ts + db.ts + schema.ts + rateLimiter.ts

routes/oauth.ts
  ├── auth.ts（signUserToken, setAuthCookie, verifyUserToken, verifyPin, hashPin）
  ├── db.ts + schema.ts（users, userOauthBindings）
  └── config.ts（getConfig, isOauthRegistrationOpen）

routes/voice.ts
  ├── middleware/userAuth.ts
  └── config.ts（getAgent）

routes/wechat.ts
  ├── db.ts + schema.ts（conversations, wechatBindings）
  ├── middleware/userAuth.ts
  └── qrcode（QR 码生成）

routes/qq.ts
  ├── db.ts + schema.ts（conversations, qqBindings）
  ├── middleware/userAuth.ts
  ├── im/locks.ts（withNamedLock 绑定串行化）
  └── qq/api.ts（getAccessToken 凭证校验）+ qq/manager.ts（连接重启/停止）

routes/assets.ts
  └── 静态文件服务（voice 音频, user 资源等）

routes/events.ts
  ├── middleware/userAuth.ts
  └── realtime.ts（subscribeRealtime）

wechat/chat.ts（微信消息→AI 桥接）
  ├── db.ts + schema.ts（conversations, messages, wechatBindings）
  ├── ai/pi-adapter.ts（runPiAgentLoop）
  └── wechat/ilink.ts（sendMessage, WECHAT_BASE_URL）

wechat/poller.ts（轮询器）
  ├── db.ts + schema.ts（wechatBindings）
  ├── wechat/ilink.ts（iLink API 客户端）
  └── wechat/chat.ts（handleWechatMessage）

wechat/ilink.ts（iLink 微信通道 API 客户端）
  └── 独立的 fetch 封装（sendMessage, 轮询新消息等）

qq/api.ts（QQ 开放平台 REST 协议客户端，手写最小实现）
  ├── token 缓存（per-appId 单飞 + 提前刷新）
  └── sendC2CText / sendStreamFrame / getGatewayUrl（fetch 封装）

qq/gateway.ts（QQ WS 网关连接状态机）
  ├── qq/api.ts（token, /gateway）
  └── ws（唯一新增依赖，外置于 tsup bundle）

qq/manager.ts（per-user 连接注册表）
  ├── db.ts + schema.ts（qqBindings）
  ├── qq/gateway.ts + qq/chat.ts
  └── im/locks.ts（restart 串行化）

qq/chat.ts（QQ 消息→AI 桥接 + 流式回发）
  ├── db.ts + schema.ts（conversations, messages, qqBindings）
  ├── ai/pi-adapter.ts（runPiAgentLoop）
  ├── qq/api.ts（sendC2CText, sendStreamFrame）
  └── im/locks.ts（withUserImLock 跨渠道锁）

realtime.ts（进程内事件总线）
  └── 纯内存态（Map<userId, Set<RealtimeSubscriber>>），无外部依赖
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
├── id INTEGER/SERIAL PRIMARY KEY  -- 自增（SQLite: INTEGER, PG: SERIAL）
├── conversation_id TEXT FK        -- 关联 conversations，级联删除
├── role TEXT                      -- user | assistant | system | tool
├── content TEXT                   -- 消息内容
├── thinking TEXT                  -- AI 思考过程（可选）
├── tool_calls TEXT                -- JSON 序列化的工具调用数组
├── tool_call_id TEXT              -- 工具响应关联的调用 ID（可选）
├── suggestions TEXT               -- JSON 序列化的建议数组（可选）
├── attachments TEXT               -- JSON 序列化的附件/产物数组（可选）
├── agent_id TEXT                  -- 群聊中发言者的 Agent ID（可选）
└── created_at INTEGER             -- Unix epoch (秒)

settings
├── key TEXT PRIMARY KEY           -- 配置键
└── value TEXT                     -- 配置值
  常用键：
    pin:{username}                 — PBKDF2 PIN 哈希
    app_name, app_favicon, app_background
    api_endpoint, api_key
    support_attachments, support_infinite_mode, show_github
    use_external_image_hosting     — 外部图床开关
    recommended_questions          — 推荐问题 JSON 数组
    oauth_providers                — OAuth 提供商 JSON 数组
    tts_api_endpoint, tts_provider — TTS 配置
    direct_registration_open       — PIN 注册开关
    oauth_registration_open        — OAuth 注册开关
    model, system_prompt           — 旧版全局配置（已迁移至 agents 表）
    jwt_secret                     — 自动生成的 JWT 签名密钥

agents
├── id TEXT PRIMARY KEY            -- UUID（neutral 角色固定为 'neutral-agent'）
├── name TEXT                      -- Agent 名称
├── model TEXT                     -- 该 Agent 使用的模型
├── system_prompt TEXT             -- 该 Agent 的系统提示词
├── avatar TEXT                    -- 头像（base64 data URL）
├── role TEXT                      -- 'default' | 'neutral'
├── created_at INTEGER             -- Unix epoch (秒)
├── voice_enabled INTEGER/BOOLEAN  -- 是否启用 TTS 语音（默认 false）
├── voice_sample_url TEXT          -- 语音样本 URL（声音克隆参考音频）
└── voice_settings TEXT            -- 语音设置 JSON（{speed, pitch}）

group_conversation_agents
├── conversation_id TEXT FK        -- 群聊对话 ID
├── agent_id TEXT FK               -- 参与的 Agent ID
├── sort_order INTEGER             -- 排序权重
└── PRIMARY KEY (conversation_id, agent_id)

mcp_servers
├── id TEXT PRIMARY KEY            -- UUID
├── name TEXT                      -- MCP 服务器名称
├── url TEXT                       -- MCP 服务器 SSE 端点 URL
├── enabled INTEGER/BOOLEAN        -- 是否启用（默认 true）
└── created_at INTEGER             -- Unix epoch (秒)

users
├── username TEXT PRIMARY KEY      -- 用户名
├── pin_hash TEXT                  -- PBKDF2 PIN 哈希
├── first_login_at INTEGER         -- 首次登录时间（Unix 秒）
├── last_login_at INTEGER          -- 最后登录时间（Unix 秒）
└── banned INTEGER/BOOLEAN         -- 是否被禁用（默认 false）

user_oauth_bindings
├── id TEXT PRIMARY KEY            -- UUID
├── user_id TEXT                   -- 本地用户名
├── provider_id TEXT               -- OAuth 提供商 ID
├── provider_user_id TEXT          -- OAuth 提供商用户唯一标识
├── created_at INTEGER             -- Unix epoch (秒)
└── UNIQUE (provider_id, provider_user_id)  -- 每个 OAuth 身份只能绑定一个账号

wechat_bindings
├── user_id TEXT PRIMARY KEY       -- 本地用户名（一个用户一个微信绑定）
├── bot_token TEXT                 -- iLink bot token
├── wechat_user_id TEXT            -- 微信用户 ID（扫码者，用于 sender 校验）
├── conversation_id TEXT           -- 绑定的对话 ID（路由权威，消息发到此会话）
├── pending_conversation_id TEXT   -- 待绑定的对话 ID（扫码中暂存）
├── updates_buf TEXT               -- 待处理的消息更新缓冲
├── session_expired INTEGER/BOOLEAN-- iLink 会话是否过期
└── created_at INTEGER             -- Unix epoch (秒)

qq_bindings
├── user_id TEXT PRIMARY KEY       -- 本地用户名（一个用户一个 QQ 绑定，与微信正交）
├── app_id TEXT                    -- QQ 开放平台机器人 AppID
├── app_secret TEXT                -- 机器人 AppSecret（明文，API 永不回显）
├── conversation_id TEXT           -- 绑定的对话 ID（路由权威；软删会话仅清此列，保留凭证）
├── status TEXT                    -- 'connected' | 'error'（仅凭证/致命错误触发，防抖动）
├── error TEXT                     -- 最近一次错误信息
├── created_at INTEGER             -- Unix epoch (秒)
└── updated_at INTEGER             -- Unix epoch (秒)

user_agent_memories
├── id TEXT PRIMARY KEY            -- UUID
├── user_id TEXT                   -- 本地用户名
├── agent_id TEXT                  -- Agent ID（按 (user, agent) 二元组隔离；Agent 删除后留孤儿行）
├── content TEXT                   -- 记忆正文（上限 4000 字符）
├── source TEXT                    -- 'agent'（save_memory 写入）| 'user'（界面手动添加）
└── created_at INTEGER             -- Unix epoch (秒)
```

### PostgreSQL 模式索引

```sql
-- 通用索引（SQLite + PG）
CREATE INDEX idx_messages_conv        ON messages(conversation_id, created_at);
CREATE INDEX idx_conversations_user   ON conversations(user_id, updated_at);
CREATE INDEX idx_group_conv_agents_conv ON group_conversation_agents(conversation_id);
CREATE INDEX idx_user_agent_memories  ON user_agent_memories(user_id, agent_id);
```

## 前端组件树

```
App
├── LoginScreen
│     ├── PIN 登录（用户名 + PIN 输入 / 设置）
│     └── OAuth 登录（提供商按钮列表，来自 /api/oauth/providers）
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
│     ├── AgentManager（Agent CRUD + TTS 语音配置）
│     ├── GatewaySettings（API 地址 + 密钥）
│     ├── ExperienceSettings（应用名称 + Favicon + 背景图 + 首页推荐问题 + 聊天常用追问）
│     ├── SkillManager（技能管理）
│     ├── McpServerManager（MCP 服务器 CRUD）
│     └── StatsPanel（统计 + 对话浏览）
├── MenuDialog（语言/主题/管理员/修改 PIN/登出）
└── ChangePinDialog
```

## 认证模型

```
用户层：
  —— PIN 认证 ——
  用户名 + 4-8 位 PIN
  PIN → PBKDF2（SHA-512, 10000 次, 随机 16 字节盐）→ users 表 pin_hash
  验证成功 → signUserToken() → JWT (HS256, 14天, role:'user', sub:username)
  续期 → 剩余不足一半（<7天）时客户端 POST /api/user/refresh → 换发新 14 天 JWT（滑动会话）
  请求 → HttpOnly Cookie momoi_token（同源自动携带）
  userAuthMiddleware → verifyUserToken() → c.set('userId', username)

  —— OAuth 认证 ——
  管理员配置 OAuth2 提供商（oauth_providers 配置项），用户点击提供商按钮
  → GET /api/oauth/:providerId/login → 重定向到提供商授权页
  → 授权回调 GET /api/oauth/callback → code 换 token → 拉取 userinfo
  → 查询 user_oauth_bindings 表匹配已有绑定
    ├── 已绑定：直接签发 JWT，写入 momoi_token Cookie，重定向回 SPA
    ├── 已登录但未绑定：绑定到当前账号（静默 link）
    └── 新用户 → 检查 oauth_registration_open 门控
          ├── 开放 → 重定向到注册页（设置用户名 + PIN）
          └── 关闭 → 返回错误
  → OAuth 注册 POST /api/oauth/register
    - action=link：验证已有账号 PIN + 绑定 OAuth + 签发 JWT
    - action=create：创建新用户 + 绑定 OAuth + 签发 JWT
  → 注册完成后同样写入 momoi_token Cookie

IP 速率限制：
  同一 IP 连续 5 次 PIN 错误 → 封禁 5 分钟
  状态仅存于内存（rateLimiter.ts），重启服务即清除
  成功登录后自动清除该 IP 的失败记录

管理员层：
  ADMIN 环境变量 = 管理员用户名名单（逗号分隔，进程生命周期内固定）
  管理端点 → HttpOnly Cookie
  adminAuthMiddleware → verifyUserToken() + isAdmin(username)（名单内放行，否则 403）
  客户端入口显隐 → GET /api/user/me → { username, is_admin }

安全细节：
  - PBKDF2 10000 次迭代 + SHA-512
  - timingSafeEqual 防止时序攻击
  - JWT 经 HttpOnly Cookie 传输（SameSite=Lax；HTTPS 下 Secure）——JS 不可读，XSS 无法窃取
  - JWT 签名密钥：JWT_SECRET 环境变量，或首启随机生成并持久化到 settings 表
  - ADMIN 名单与 JWT_SECRET 不暴露给前端；客户端仅能通过 /me 得知自己是否管理员
  - OAuth state 参数（32 字节随机 hex + HttpOnly Cookie）防 CSRF
  - OAuth 回调使用 Referer 头推断 SPA origin，避免硬编码
```

## 部署架构

```
开发模式：
  Vite Dev Server (:5173)  ──proxy──→  Hono (:PORT, 默认 11408)

生产模式：
  Hono (:PORT, 默认 11408)  ── 直接托管 ──→  dist/client/ 静态文件
              └── API 路由 ──→  /api/*

数据库模式：
  本地模式（默认）：
    SQLite via sql.js（文件：data/momoi.db，30s 间隔自动持久化）
    SIGINT/SIGTERM 触发最终持久化 + 优雅退出

  远程模式：
    DATABASE_URL + DATABASE_USER + DATABASE_SECRET 三个环境变量同时存在时
    → PostgreSQL via pg + Drizzle ORM（pg Pool, max 5 连接）

微信轮询器：
  进程启动后自动启动 startWechatPoller()（非阻塞，定时器驱动）
```