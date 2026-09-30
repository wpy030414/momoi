# Spec — 聊天模块（Chat）

## 概述

聊天模块是 Momoi 的核心，负责用户与 AI 之间的实时对话。系统支持两种对话模式：**直接对话**（单个 Agent）和**群聊**（多个 Agent 串行回复）。此外，**无限演算模式**可作为独立开关叠加在任意对话类型上，由中立 Agent 自动生成追问实现持续对话循环。服务端基于 Pi Agent Core 实现多轮工具调用循环，客户端通过 SSE 流式接收事件。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `apps/server/src/routes/chat.ts` | SSE 流式端点 `POST /api/chat`、附件拼装、对话创建、无限模式开关 |
| `apps/server/src/ai/pi-adapter.ts` | Pi Agent Core 适配层：系统提示词构建 + 工具适配 + 流式映射 + Agent 循环入口 |
| `apps/server/src/ai/provider.ts` | OpenAI 兼容 API 流式客户端（含多模态与 thinking 参数） |
| `apps/server/src/ai/tokens.ts` | 字符级 token 估算：上游不回 usage 时状态条与累计消耗的退化路径 |
| `apps/server/src/ai/conversation-stats.ts` | 会话累计口径（纯函数）：增量合并、历史账单粗估、脏数据解析 |
| `apps/server/src/lib/stats-store.ts` | 状态条快照 + 会话累计的落库口（网页 / QQ / 微信共用） |
| `apps/server/src/ai/group-orchestrator.ts` | 群聊编排：发言调度 + 多 Agent 串行回复 + @mention 处理 + 无限模式 |
| `apps/server/src/ai/neutral-agent.ts` | 中立 Agent：无限模式追问 + 回复后追问建议 + 群聊发言调度 |
| `apps/server/src/ai/tools.ts` | 工具注册表（委托到内置工具 registry） |
| `apps/server/src/tools/group-mention-tool.ts` | @mention 工具：Agent 间点名调用 |
| `apps/server/src/tools/ask-user-tool.ts` | ask_user 工具：阻塞式向用户提问并等待回答 |
| `apps/server/src/realtime.ts` | 进程内事件总线：同账号多设备实时同步 |
| `apps/server/src/routes/events.ts` | 实时事件通道 `GET /api/events`（SSE 长连接） |
| `packages/shared/src/thinking.ts` | thinking 分段的编解码 |
| `packages/shared/src/types.ts` | ServerMessage 联合类型、RealtimeEvent、AskUserQuestion 等 |
| `apps/web/src/hooks/useChat.ts` | 客户端聊天状态管理 + SSE 解析 + 重试 + 哈希路由 |
| `apps/web/src/hooks/useGroupChat.ts` | 群聊状态管理 |
| `apps/web/src/lib/format.ts` | 状态条展示格式化：token 数缩写、耗时（ms/s） |

## 接口契约

### POST /api/chat

**认证**：需用户 JWT（`userAuthMiddleware`，严格模式）。缺失 → `401`。

**请求**：
```json
{
  "message": "用户消息文本",
  "conversation_id": "可选-已有对话ID",
  "agent_id": "可选-Agent ID（不传则使用默认Agent）",
  "_retry": false,
  "thinking_mode": true,
  "attachments": [{ "url": "...", "name": "...", "size": 123, "type": "image/png" }],
  "conversation_type": "direct | group",
  "agent_ids": ["可选-群聊Agent ID列表"],
  "infinite_mode": false,
  "language": "zh-CN",
  "device_id": "来源设备标识（同账号实时中继用，源设备据此跳过）"
}
```

- `message` 为空或全空白 → `400 { "code": "CHAT_EMPTY_MESSAGE" }`
- `thinking_mode` 判定为 `thinking_mode !== false`，即**省略时默认开启**
- `conversation_type`：`direct`（默认）为单 Agent 对话，`group` 为群聊模式
- `agent_ids`：群聊模式下指定参与 Agent 的 ID 列表
- `infinite_mode`：是否开启无限演算模式（中立 Agent 自动追问）
- `attachments` 见 `module-file-attachment.md`

**响应**：SSE 流（`Content-Type: text/event-stream`），每条事件通过 `event: message` + `data: {json}` 发送。

##### SSE 事件表

| 事件 | 数据 | 说明 |
|---|---|---|
| `conversation_id` | `{ id: string }` | 对话 ID（新建或复用时发送；清除客户端草稿态） |
| `user_message_id` | `{ id: number }` | 刚入库的用户消息 ID |
| `user_message` | `{ id: number, content: string, attachments? }` | **实时中继专用**：他设备渲染用户气泡 |
| `token` | `{ text: string, agent_id?, agent_name? }` | 文本增量 token |
| `thinking` | `{ text: string, round?: number, agent_id?, agent_name? }` | 思考过程增量 token |
| `tool_call` | `{ id?: string, name: string, input: object, agent_id?, agent_name? }` | LLM 发起工具调用（intent 阶段，尚未执行） |
| `tool_execution_start` | `{ id?: string, name: string, input: object, agent_id?, agent_name? }` | 工具实际开始执行（`tool_call` 是 LLM intent，`tool_execution_start` 是运行时确认——分离后客户端可区分"声明要调"与"正在执行"两个阶段） |
| `tool_result` | `{ id?: string, name: string, summary: string, artifacts?, agent_id?, agent_name? }` | 工具调用结果 |
| `ask_user` | `{ question_id: string, tool_call_id: string, questions: AskUserQuestion[], agent_id?, agent_name? }` | Agent 调用 ask_user 工具向用户提问（暂停执行，等待用户回答） |
| `agent_start` | `{ agent_id: string, agent_name: string }` | 群聊中某个 Agent 开始回复 |
| `agent_done` | `{ agent_id: string, agent_name: string, reply: string, suggestions: string[] }` | 群聊中某个 Agent 回复完成 |
| `group_start` | `{ agent_ids: string[] }` | 群聊开始 |
| `group_done` | `{ infinite?: boolean }` | 群聊结束 |
| `suggestions` | `{ suggestions: string[], agent_id?: string \| null }` | 回复完成后由中立 Agent 异步补发的追问建议 |
| `follow_up_start` | `{}` | 无限模式：中立 Agent 即将生成追问（客户端据此创建占位气泡） |
| `follow_up` | `{ text: string }` | 无限模式：中立 Agent 生成的追问 |
| `infinite_mode_off` | `{}` | 无限模式已关闭 |
| `done` | `{ reply: string, suggestions: string[], agent_id?, agent_name?, infinite? }` | 对话完成（终止事件） |
| `stats` | `{ stats: ConversationStats }` | 本轮生成的状态条统计快照（轮/步/上下文/tok·s）；紧随 `done` / `group_done` 之后下发，见〈会话状态条〉 |
| `voice_segment` | `{ message_id: number, index: number, audio_url: string, text: string, duration_seconds: number }` | TTS 语音合成片段（逐句流式下发） |
| `voice_done` | `{ message_id: number, total_segments: number }` | 该消息全部 TTS 片段合成完毕 |
| `error` | `{ message: string, agent_id?, agent_name? }` | 错误（终止事件） |

**保活**：每 15 秒发送 SSE 注释 `:\n\n`，防止代理/浏览器关闭空闲连接。

**终止保证**：`try/catch/finally` 兜底 —— handler 内任何未捕获异常都会转成 `error` 事件下发，`finally` 中清理心跳定时器。客户端因此总能收到终止事件。所有写入通过 `writeChain` 串行化，确保流关闭前尾部事件被 flush。

**写入失败容忍**：`send()` 写失败即置 `aborted=true` 并静默丢弃后续事件（终止事件失败会打一条 `console.warn`），避免客户端已断开时抛错污染日志。

### POST /api/chat/infinite-mode

切换对话的无限演算模式。

**请求**：`{ "conversation_id": "uuid", "enabled": true | false }`

**响应**：`{ "success": true, "enabled": true | false }`

**行为**：开启时记录当前消息数作为基线；关闭时清除状态。无限模式最多 500 条消息，超出自动停止。

### POST /api/group

群聊创建接口。与 `POST /api/chat` 使用相同的 SSE 流式端点，但 `conversation_type` 固定为 `group`。

### POST /api/chat/:conversationId/answer

向 ask_user 工具提交用户回答。

**认证**：需用户 JWT（`userAuthMiddleware`）。缺失 → `401`。

**请求**：
```json
{
  "question_id": "uuid-问题的唯一ID（必填）",
  "answer": "用户自由填写内容（可选，跳过时为空）",
  "selected_options": ["选中的选项 label 列表（可选）"]
}
```

**响应**：
- `200 { "success": true }` — 回答已接收，ask_user Promise resolve
- `400 { "code": "CHAT_QUESTION_ID_REQUIRED" }` — 缺少 question_id
- `403 { "code": "CHAT_QUESTION_WRONG_CONVERSATION" }` — 问题不属于指定会话
- `410 { "code": "CHAT_QUESTION_EXPIRED" }` — 问题不存在、已被回答或已超时

**行为**：`answer` 和 `selected_options` 至少传一个。两者的优先级：
- 若有 `selected_options` → 回答文本为「用户选择了: xxx。附加说明: yyy」
- 若仅传 `answer` → 直接用作回答文本
- 两者皆空 → 视为「用户跳过了此问题」

### Voice（TTS 语音合成）

当 Agent 启用 `voice_enabled` 时，每次 assistant 消息持久化后，服务端按标点 + 长度（`[。！？.!?\n]` 或满 40 字符）将回复文本拆句，逐句异步调用 TTS 提供方（GPT-SoVITS / CosyVoice），生成音频文件并下发 SSE 事件：

- **`voice_segment`**：单句音频生成完毕。`message_id` 关联消息，`index` 表示句序号（0-based），`audio_url` 为音频文件相对路径，`text` 为对应的原文，`duration_seconds` 为音频时长
- **`voice_done`**：全部句段合成完毕（含超时 30s 兜底）。`total_segments` 表示总句数

Voice 参数从 Agent 的 `voice_settings` JSON 中读取：`speakerId`（必选）、`speed`（默认 1.0）、`pitch`（默认 0）。TTS 配置端点与 provider 类型从 `getTtsConfig()` 动态获取。

### ask_user 工具

`ask_user` 是阻塞式工具：Agent 调用后暂停执行，向用户展示问题（单选/多选/自由输入），等待用户回答后以工具结果回传 LLM 继续循环。

**核心流程**：
1. Agent 调用 `ask_user` → 工具 validate 问题参数（questions 非空、options 2-4 个）
2. 通过 `ctx.onUpdate` 触发 `tool_execution_update` → 服务端发 SSE `ask_user` 事件（含 `questionId`、`tool_call_id`、`questions`）
3. execute() 返回永不 resolve 的 Promise —— Pi 循环自然暂停
4. 客户端渲染问题 UI → 用户填写回答 → 调用 `POST /api/chat/:id/answer`
5. answer 端点查出问题 → `resolveQuestion()` → Promise resolve → LLM 继续循环
6. 超时（120s）或 SSE 断开 → `rejectQuestion()` → LLM 收到错误

**`ask_user` SSE 事件**：
- `type: "ask_user"` — `questionId`（问题 UUID）、`tool_call_id`、`questions`（`AskUserQuestion[]`，每个含 `header`、`question`、`options`、`multiSelect`）

**`AskUserQuestion` 结构**：
| 字段 | 类型 | 说明 |
|---|---|---|
| `header` | `string` | 短标签，最多 12 字符（如「文件命名」） |
| `question` | `string` | 完整问题文本 |
| `options` | `AskUserOption[]` | 2-4 个预设选项，每个含 `label` 和可选 `description`；空数组 = 自由输入 |
| `multiSelect` | `boolean` | 是否允许多选 |

**注意**：`tool_call` 事件（LLM intent）和 `ask_user` 事件是两件事——`tool_call` 表示 LLM 声明要调这个工具（与其他工具的 tool_call 一致），`ask_user` 是工具 execute 后下发的 UI 事件（含 questionId 供 answer 端点回传）。

### 实时事件通道（GET /api/events）

同账号多设备实时同步的核心基础设施。客户端每设备维护一条 SSE 长连接，接收聊天流中继、会话列表变更等事件。

**认证**：需用户 JWT（`userAuthMiddleware`）。`device_id` 经 query 参数传递（EventSource 无法附加自定义请求头）。

**SSE 防缓冲响应头**：`Cache-Control: no-cache`、`X-Accel-Buffering: no`、`Connection: keep-alive`，阻止 Nginx/CDN 缓冲聚合。

**保活**：每 15s `:keepalive\n\n`。

**RealtimeEvent 类型**（`data` 字段为完整 JSON）：

| 事件 | 数据 | 说明 |
|---|---|---|
| `stream` | `{ type: "stream", conversation_id: string, event: ServerMessage }` | 聊天流中继：同账号其他设备的实时消息事件 |
| `conv_sync` | `{ type: "conv_sync" }` | 会话列表变更信号 → 刷新侧边栏 |
| `conv_changed` | `{ type: "conv_changed", conversation_id: string }` | 会话内容变更（如回退消息）→ 正在查看的设备重新拉取 |
| `group_members` | `{ type: "group_members", conversation_id: string }` | 群成员变更 → 刷新成员列表 |

**订阅管理**：
- 按 `deviceId` 幂等：同设备重连时先移除旧订阅，避免事件双发
- 惰性清理：广播时顺带移除 `aborted` 订阅，防止异常断线泄漏
- 仅内存态，单实例部署；多实例需替换为 Redis pub/sub

**源设备自跳过**：`broadcastStream` 携带 `originDeviceId`，源设备自己的事件通道不重复推送（已通过 fetch 流直接渲染）。

### 服务端事件总线（realtime.ts）

进程内 `Map<userId, Set<RealtimeSubscriber>>`。每个订阅持 `deviceId`、`aborted` 标记、串行化 `writeChain`。

**广播函数**：
- `broadcastStream(userId, originDeviceId, data)` — 聊天流事件中继（`POST /api/chat` 的 `send()` 内调用，跳过源设备）
- `broadcastConversationSync(userId)` — 会话列表变更（新建/删除/重命名时调用）
- `broadcastConversationChanged(userId, conversationId)` — 会话内容变更广播
- `broadcastGroupMembers(userId, conversationId)` — 群成员变更广播

## 行为约束

### 服务端（chat.ts）

1. **对话归属校验**：传入 `conversation_id` 时校验 `user_id` 是否为当前用户，不匹配则发送 `error` 事件并终止
2. **新建对话**：未传 ID 时以 `randomUUID()` 创建，标题取消息前 40 字符（空则 `New Chat`）。群聊默认标题为 `群组对话`
3. **Agent 选择与锚定**：新建对话时记录 `agent_id` 和 `type`（`direct` / `group`）。已有单聊会话的发言 Agent 以 `conversations.agent_id` 为准，**请求携带的 `agent_id` 被忽略**（客户端下拉状态与当前会话脱钩，后台增删 Agent 后会被重置，不锚定会导致"换人回答"的身份漂移）；会话尚无归属记录（legacy / 附件预创建会话）时采纳请求 `agent_id` 并回写 `conversations.agent_id` 完成锚定。锚定后的 Agent 同样作用于 voice 查找与无限演算的后续轮次。群聊成员由 `group_conversation_agents` 管理，不在此锚定
4. **群聊初始化**：群聊创建时写入 `group_conversation_agents` 关联表
5. **重试去重**：`_retry === true` 时**跳过**保存用户消息，避免重复入库
6. **更新时间**：每次收到用户消息都刷新 `conversations.updated_at`
7. **历史裁剪**：从 DB 读取该对话全部消息后 `slice(0, -1)` 去掉刚插入的当前消息，作为 history 传入 AI 循环
8. **助手消息持久化**：仅当 `reply` 非空才写入，保存 `content`、`thinking`、`suggestions`、`attachments`、`agent_id`（单聊记录实际采用的 Agent，群聊记录发言者）
9. **追问建议补发**：非无限模式下，本轮最后一条 assistant 消息入库后由中立 Agent（其 `model` / `system_prompt` 现查）基于最近 20 条上下文生成 3 条追问建议：先 `UPDATE messages.suggestions`，再补发 `suggestions` SSE 事件。与 follow_up 共用「用户代笔」身份锚定（系统提示词铁律禁止模仿 Agent 口癖/助手口吻 + 定界符包裹上下文），输出行级防御清理（围栏/bullet/编号/引号/「用户：」标签前缀）。`done`/`agent_done` 中的 `suggestions` 字段正常路径为空数组。生成失败或超时（30s）静默降级为无建议；兜底路径（模型自发输出围栏被解析出建议）跳过生成，避免重复
10. **文档附件复制到工作区**：`docx/pptx/xlsx/xls/pdf` 附件会自动复制到对话工作区
11. **无限模式循环**：每次 Agent 回复后由中立 Agent 生成追问，重新加载历史并启动新一轮 AI 循环，直到关闭或达上限
12. **参数透传**：`language` 参数透传到 Pi Agent 循环和群聊编排，供多语言提示词注入使用
13. **device_id**：请求携带 `device_id`（来源设备标识），服务端据此跳过对源设备的实时中继（源设备已通过 fetch 流直接渲染）。`user_message` 中继在 `streamConvId` 确立后立即广播
14. **Voice 语音合成**：当 Agent `voice_enabled` 为 true 时，每次 assistant 消息持久化后异步逐句 TTS 合成；按标点 + 长度（`[。！？.!?\n]` 或 40 字符）拆句，每句完成发送 `voice_segment` 事件，全部完成（或 30s 超时）后发送 `voice_done`
15. **ask_user 工具集成**：Agent 调用 ask_user 时，服务端通过 SSE 下发 `ask_user` 事件（含 questionId、questions 数据）；用户回答经 `POST /api/chat/:id/answer` 端点递交，`resolveQuestion()` 唤醒 Promise 并将回答作为工具结果回传 LLM；超时 120s 或 SSE 断开则 `rejectQuestion()`
16. **实时中继广播**：`send()` 内每次写入 SSE 事件后（除 `conversation_id` 和 `user_message_id`），调用 `broadcastStream` 中继到同账号其他设备的 `/api/events` 连接，跳过源 `device_id`；`user_message` 在 `streamConvId` 确立后单独广播
17. **状态条落库**：每轮生成后先下发 `stats` 事件，**随即**把同一份快照写入 `conversations.stats`（写失败只记日志，不影响本轮回复）——契约见〈会话状态条〉

### 服务端（pi-adapter.ts）

Pi Agent Core 适配层，将 Momoi 的工具和流式客户端桥接到 Pi 的 Agent 循环框架。

1. **Agent 选择**：`agent_id` 参数 → `getAgent()`；Agent 记录不存在（含已被后台删除）则回退到第一个非中立 Agent——避免残留 ID 把模型钉死在占位值 `gpt-4o` 上
2. **系统提示词构建**（提示词规则引擎的 `chat.system` 配方，片段见 `prompts/fragments/chat.ts`）：
   - 基础内容 = Agent 的 `system_prompt`
   - 若存在技能，追加 `## Available Skills` + 每个技能的名称和描述摘要
   - 思考模式关闭时追加 `/no_think` 指令
   - 追加当前日期时间
   - 无限模式：追加「无限演算模式」指引（不生成 suggestions，追问由中立 Agent 负责）
   - 群聊模式：追加群组对话规则 + Agent 身份感知 + at_mention 使用指引
3. **工具适配**：12 个 `ToolModule` → Pi `AgentTool`（TypeBox schemas）。群聊时额外添加 `at_mention` 工具
4. **Stream 函数**（`createStreamFn`）：包装 `provider.ts` 为 Pi 兼容的 `StreamFn`，将 Pi 消息格式转换为 `ChatMessage` 格式
5. **Pi `runAgentLoop`**：内置多轮工具调用循环、并行执行、事件流式输出
6. **Suggestions 围栏扣留（防御性兜底）**：提示词已不注入 suggestions 指令（改由中立 Agent 在回复完成后单独生成），维护 `SUGGESTIONS_FENCE.length` 长度的缓冲区仅用于剥离模型自发输出的围栏，围栏跨 token chunk 到达时仍然被完整检测
7. **Suggestions 解析（防御性兜底）**（`parseSuggestions`）：
   - 用 `lastIndexOf` 定位**真正末尾**的 `` ```suggestions `` 块
   - 去除行首空白、`-`、`*`、数字与点等前缀，过滤空行，最多取 3 条
   - 未找到围栏时只做 `trimEnd()`
8. **多轮思考链分段**：每一轮的第一条 thinking 前注入「思考片段 N」分隔符，`thinking` SSE 事件带 `round` 字段
9. **统一收口**：`agent_end` 事件中 flush pending buffer，发送 `done` 事件。兜底为空时固定提示
10. **取消**：`signal.aborted` 时发送 `error` 并返回
11. **状态条计数**：`GenUsageAcc` 累计每次 LLM 调用的 usage（上游回传时）与纯流式耗时，`buildStats()` 产出 `ConversationStats`——轮/步的计数点、重试作废规则与退化估算见〈会话状态条〉。空回复搬迁重试时整体清零，作废轮的用量不得并入

### 群聊编排（group-orchestrator.ts）

1. **发言调度**：每轮开始前由中立 Agent 裁决本轮参与成员（规则与降级见 `module-group-chat.md`）；失败/超时/全跳过 → 全员参与；用户点名者强制参与
2. **Agent 顺序随机化**：第一个 Agent 保持原位，其余随机排列（制造自然对话感）
3. **历史格式化**（`prepareGroupHistory`）：将其他 Agent 的 assistant 消息转换为 `[Agent名字]: 内容` 的 user 角色消息，避免模型误认为是自己说过的话
4. **串行执行**：Agent 逐个回复，后续 Agent 能看到前面 Agent 的发言
5. **@mention 检测**：Agent 调用 `at_mention` 工具后，被点名者插入队首立即应答，其余 Agent 照常发言。最多 5 次重定向
6. **事件标记**：所有 SSE 事件附加 `agent_id` 和 `agent_name` 字段，`agent_start` / `agent_done` 标记 Agent 回复边界
7. **无限模式**：所有 Agent 回复完毕后，中立 Agent 生成追问
8. **状态条聚合**：各成员 run 的轮/步累加、tok/s 按 Σ输出/Σ流式时长、上下文与 `estimated` 取末位发言人（同源）——`orchestrateGroupChat` 返回聚合体，由 chat.ts 下发 `stats` 并落库，见〈会话状态条〉

### 客户端（useChat.ts）

1. **请求头**：携带 `X-User`（encodeURIComponent）；认证经同源 HttpOnly Cookie 自动携带
2. **重试策略**：最多 3 次（`MAX_RETRIES`），指数退避 `2s → 4s → 8s`，上限 `10s`
3. **重试标记**：重试请求带 `_retry: true`，并在重发前清空当前助手气泡内容
4. **空闲超时**：60 秒无数据则 `abort()` 触发重试
5. **部分响应保护**：流结束但未收到 `done`/`error` 时——
   - 已收到过 token → 视为**优雅关闭**，保留已有内容，不再重试
   - 完全没收到 token → 抛错进入重试
6. **取消判定**：通过 `abortRef.current !== abort` 区分「用户主动取消」与「空闲超时中断」
7. **收尾对齐**：整轮结束后重新 `GET /api/conversations/{id}` 拉取真实消息（含 suggestions），为本地乐观创建的消息补上服务端 ID。带竞态守卫：`done` 已提前结束 loading，用户抢发新消息（`abortRef` 被覆盖）时跳过全量重拉，避免抹掉新的本地气泡
8. **loading 提前结束**：收到 `done` 即 `setLoading(false)`（连接为等待 `suggestions` 补发保持打开）；`suggestions` 事件挂到本轮最后一条 assistant 气泡，若用户已抢发新消息或群聊 `agent_id` 不匹配则静默丢弃（DB 已持久化）
9. **哈希路由**：`#/c/{conversationId}`
   - 首次消息创建对话 → `replaceState` 写入 hash
   - 选中对话 → `pushState`（支持后退）
   - 新建/删除当前对话 → 清除 hash
   - 监听 `hashchange` 支持浏览器前进后退
10. **导出**：客户端拼接 `# 标题` + 每条 `### User` / `### <Agent 名称>`，以 `---` 分隔，生成 `.md` 下载；Agent 名称解析 = 消息 `agent_id`（群聊成员 + 全局 Agent 列表）→ 单聊回退会话所属 Agent
11. **多轮思考分段渲染**：SSE `thinking` 事件带 `round` 字段时，前端按轮聚合为 `thinkingSegments`；历史消息通过 `decodeThinkingToSegments` 切分
12. **消息渲染**：群聊按 `msg.agent_id` 显示各 Agent 头像和名称；单聊同样显示 Agent 名称（优先消息的 `agent_id`，回退当前会话的 Agent，再回退下拉选择）
13. **会话归属同步**（App.tsx）：切进已有会话时把 Agent 下拉选择（`selectedAgentId`）同步为该会话归属的 Agent，防止全局下拉状态（后台增删 Agent 后列表刷新会重置为 `agents[0]`）与当前会话错位；服务端按 `conversations.agent_id` 的锚定为最终兜底
14. **草稿会话（新机制）**：点击「新会话」/「新群聊」只进入**草稿态**（`draftType: 'direct' | 'group'`，`activeId` 为 null），**不落库、不建记录、不调 `POST /api/conversations`**。会话记录在**发出第一条消息**时由服务端在 `POST /api/chat` 内创建（无 `conversation_id` → 服务端建会，群聊按 `conversation_type: 'group'` + `agent_ids` 写关联表），收到 SSE `conversation_id` 事件后客户端清除草稿标记并写入 hash，侧边栏同步出现记录（无需刷新）。例外：草稿态上传附件经 `ensureConversation` 需要真实会话 ID（workspace 落盘），按当前草稿类型预建真实会话（技术必要）
15. **多设备实时同步（新机制）**：客户端维护一条 `GET /api/events` SSE 长连接（同账号每设备一条，按 `localStorage` 持久化的 `momoi_device_id` 标识），接收：
    - `stream` 事件：其他设备正在流式输出同一会话时，直接把中继的 `ServerMessage` 应用到本地消息列表（tokens / thinking / tool_call / agent_start / done / suggestions / voice_segment 等）；`user_message` 中继用于渲染他设备的用户气泡（单聊同时预建流式 assistant 气泡以承接后续 token）
    - `conv_sync`：会话列表变更信号 → 刷新侧边栏（新建/删除/重命名/群成员数）
    - `conv_changed`：其他设备回退了某会话 → 若本设备正在查看则整条重拉对齐
    - `group_members`：群成员变更 → 刷新成员列表与侧边栏人数
    - 事件源 `EventSource` 携带 Cookie 认证（HttpOnly JWT），用户名经查询参数传递（EventSource 无法附加自定义请求头）；断线由浏览器自动重连
    - 源设备自跳过：聊天流中继携带发起方 `device_id`，源设备不重复接收（已通过自己的 fetch 流渲染）
16. **发送请求体**：`POST /api/chat` 新增可选 `device_id`（来源设备标识，服务端据此跳过对源设备的实时中继）
17. **状态条统计（`statsByConv`）**：只**接收**服务端发放的快照——SSE `stats` 事件与会话详情响应里的那一份，经 `storeServerStats` 原样覆盖，不比较、不合并、不判新旧；草稿转正时随分区迁移。见〈会话状态条〉

### 客户端（useGroupChat.ts）

组合 `useChat` 并扩展群聊专用能力：

1. **Agent 列表**：从 `GET /api/app-name` 加载所有可用 Agent
2. **群聊检测**：切换对话时通过 `GET /api/conversations/:id` 检测 `type === 'group'`，加载群组成员
3. **创建群聊（草稿态）**：`createGroupConversation(agentIds)` 只暂存所选成员（`groupAgents`）并进入群聊草稿态（`draftType: 'group'`），**不调用服务端建会**；选好 Agent 后侧边栏不自动收回；首条消息发出时由服务端创建群会话
4. **发送消息**：`sendGroupMessage` 携带 `agent_ids` 和 `conversation_type: 'group'`
5. **成员管理**：`addAgentToGroup` / `removeAgentFromGroup` 增删群组成员
6. **实时群成员同步**：其他设备改动了群成员时，若本设备正在查看该群则刷新成员列表

### 服务端（realtime.ts + routes/events.ts）

1. **进程内事件总线**：`Map<userId, Set<subscriber>>`，每个订阅持有 `device_id` 与串行化写入链。聊天流事件经 `broadcastStream` 跳过源设备后实时中继到同账号其他设备；会话列表 / 内容变更 / 群成员变更经 `broadcastConversationSync` / `broadcastConversationChanged` / `broadcastGroupMembers` 广播
2. **事件通道路由**：`GET /api/events?device_id=xxx`（`userAuthMiddleware` 认证）→ SSE 长连接，每 15s 心跳；客户端断开时 `onAbort` 清理订阅。订阅按 `deviceId` 幂等（同设备重连先移除旧订阅，避免事件双发）
3. **仅限单实例**：多实例 / 横向扩容需把内存总线替换为 Redis pub/sub（超出当前范围，见 `AGENTS.md` 非目标）

## 会话状态条（ConversationStats）

输入框下方一行：`<工作区> | 3.4s · 128 tok/s | 1.2M tok | 35%`——**只列裸数字**（无中文标签、无 `≈` 标记）。仅在**已有会话**渲染（草稿态不显示）。数据源是服务端每次生成后算出的一份快照——**发放权威完全在服务端**，客户端只接收。

### 契约

| 字段 | 语义 |
|---|---|
| `totalTokens` | 本会话**累计消耗**（账单口径）：Σ 每一次 LLM 调用的（输入 + 输出），跨所有生成、所有轮次累加。agent 每轮都把整个上下文重发一次，**重复投喂也计入**。快照每次覆盖写，而该值**只增不减**。缺省 = 该字段上线前写入的存量快照 |
| `totalEstimated` | true = 累计中含估算部分（存量会话的历史回填，或某次生成整轮未回 usage）。一旦置位**永不回退**——估算进来了就不能再假装精确。**状态条不渲染该标记**，留给工具提示 / 详情视图 |
| `durationMs` | 本轮**生成耗时**（服务端墙钟）。单聊 = AI 循环段（含工具执行与空回复重试），**不含**路由层准备（历史加载 / 建会 / 附件复制 / 落库）；群聊 = 整轮编排（含发言裁决与各成员串行回复） |
| `tokensPerSecond` | 本轮**输出**速度：`Σ completionTokens ÷ Σ 纯流式时长`（首事件 → 流尾，不含工具执行间隙）；为 0 时前端整段隐藏 |
| `contextTokens` | **当前上下文占用**（与累计无关）：优先上游最后一次 usage 的 `promptTokens + completionTokens`（≈「下一次调用将携带的规模」）；上游不回 usage 时退化为字符估算 |
| `estimated` | true = `contextTokens` 来自字符估算而非上游 usage。**状态条不渲染该标记**，同上 |
| `rounds` / `steps` | **不上状态条**（诊断字段，保留在快照里）。`rounds` = LLM 调用次数（`streamFn` 被调用一次计一轮，纯文本轮与工具轮同权）；`steps` = 工具执行次数（每个 `tool_execution_start` 计一步，无工具调用的会话恒为 0）。保留的理由：将来做「生成中实时进度」或诊断面板时要这两个数；不上 UI 的理由见下方*为什么显示耗时而不是轮/步* |

#### 累计消耗（账单口径）

- **口径**：Σ 每次 LLM 调用的（输入 + 输出）。**输入侧包含每轮重发的整个上下文**（system + 全量历史 + 工具定义 + 本轮输入），这是网关真正计费的口径；一轮里调 3 次工具再回答，上下文就被计 4 遍
- **真值优先**：上游回 usage 时累加 `promptTokens + completionTokens`（含思考——思考属 completion）
- **估算后备**：整轮生成一次 usage 都没拿到时，按「**每轮实际发送的输入** + 每轮实际产出」字符估算（结构与真值一致，只是字符估算）。真值与估算**不混用**：有 usage 用真值，完全没有才用估算
- **首次回填**：累计是该能力上线后才开始记录的，存量会话从 0 起算会明显偏小 → 首次落库（快照里还没有 `totalTokens`）时用 `estimateHistoricalBill` 粗估历史起点，并让该会话的累计**永久标记为含估算**（`totalEstimated`——状态条不渲染该标记）。粗估的已知偏差：全部为字符估算；`history` 不带 thinking（历史思考未计入，偏小）；系统提示词取**当前**值（含日期等易变部分）
- **各渠道共用**：网页 / QQ / 微信三条路径都调同一个落库入口（`lib/stats-store.ts`）——「整个会话消耗」必须覆盖所有渠道，否则绑定 IM 的会话在网页端会显示偏小的数
- **已知取舍（并发）**：累计是「读旧值 → 加增量 → 写回」。同一会话真并发两个生成（网页双设备同时发；IM 侧有 `im/locks.ts` 的会话锁，网页侧无锁）理论上会丢一次增量——概率极低且只影响一个会话的累计数值。彻底的解法是改成「每次生成追加一行用量流水、总额读时求和」

- **快照口径 = 「最近一次生成」**（`durationMs` / `contextTokens` / `tokensPerSecond` / `rounds` / `steps` 每轮覆盖写，同一会话连发两条消息不累加）；**唯一例外是 `totalTokens`——它跨生成累加、只增不减**（见〈累计消耗〉）
- **计数点**：轮在 `createStreamFn` 入口自增（每次 LLM 调用一次）；步在事件发射器的 `tool_execution_start` 分支自增。两者都不看 `turn_end` / `tool_execution_end`——被**执行到**就是一步，成败不改变计数
- **空回复搬迁重试**：上一轮完全作废，轮/步/用量（`GenUsageAcc`）**整体**清零后从头上计。作废轮的轮数与 prompt/completion 一律不得并入，否则轮数偏大、tok/s 虚高、上下文取到作废值且丢掉估算标记
- **群聊聚合**：轮/步**累加**；tok/s = Σ输出 ÷ Σ流式时长；`contextTokens` 与 `estimated` 取**最后一名发言人**的 run（成员间上下文高度重叠，末位最接近全貌）——两者必须同源，不能一处取 last、一处取 some，否则真值会被错标成估算；`durationMs` 取**整轮编排墙钟**而非各成员之和（用户等的是整轮）
- **哪些是「当场捕获」、哪些可重算**：`tokensPerSecond`（分母是每轮纯流式时长）、`durationMs` 与 `contextTokens` 的真值（上游 usage）在 DB 里没有任何别的痕迹，**只能当场捕获**；`steps` 事后可从 `messages.trace` 精确数出，`rounds` 只能靠 `thinking` 里的「思考片段 N」近似（没产生思考的轮会漏）。整份落库的理由不是「算不出来」，而是口径是「最近一次生成」——这个边界只有当场知道；且列表/详情要 O(1) 读出，重算得把每条会话的消息与 trace 全拉出来聚合

#### 为什么显示耗时而不是轮/步

- `steps` 与界面**重合**：它等于本轮工具气泡的数量（`tool_execution_start` 与气泡一对一），用户能自己数
- `rounds` 反而**制造疑问**：界面上没有它的对应物；唯一沾边的是 `thinking` 里的「思考片段 N」，而那只是近似——**没产生思考的轮不落 header**，于是会出现「4轮 vs 片段 1..3」的自相矛盾。群聊下它是各成员之和（3 个 Agent 各 2 轮 → `6轮`），但用户并未经历「6 轮」
- 两者都**不能当进度用**：快照只在生成**结束**时发放一次，生成中显示的是上一轮的数
- `durationMs` 自解释、零歧义、不冗余，并与上下文占用%一起回答「为什么等这么久 / 花了多少」

### 持久化与发放（权威在服务端）

1. `POST /api/chat` 每轮生成后下发一次 `stats` SSE 事件，**并随即** `persistConversationStats()`（`lib/stats-store.ts`）把「快照 + 累计增量」写回 `conversations.stats`（JSON 字符串）
2. 群聊在 `group_done` 之后下发（`orchestrateGroupChat` 返回聚合体）
3. **IM 渠道（QQ / 微信）**：回复落库后广播同一个 `stats` 事件（网页端状态条实时更新）并走**同一个落库入口**——累计必须覆盖所有渠道的生成
4. `GET /api/conversations/:id` 返回**已反序列化**的 `stats`（null = 尚未生成过）。**列表 `GET /api/conversations` 不返回**——列表刷新频繁（`conv_sync` / `unread_update`），若把快照塞进去，客户端就得替服务端判定新旧，「权威发放」就漏到客户端了
5. **客户端只接收、不裁决**（useChat `storeServerStats`）：SSE `stats` 事件与会话详情（打开会话 / `conv_changed` 对账 / 流收尾对账）里的快照一律**原样覆盖**——不比较、不合并、不判新旧。两条通道都是服务端在会话上下文里给出的权威值
6. **有序性由服务端负责**：客户端不纠正乱序（例如迟到的详情响应带着上一代快照），等下一次发放收敛。这是「客户端不替服务端裁决」的代价
7. 草稿转正（`renamePartition`）时 `statsByConv` 分区一并迁移

### 展示

- 首字段：会话归属工作区名（未分组 / 悬空值渲染为「未分组」）
- **状态条只列裸数字**：没有中文标签，也不渲染 `≈` 之类的估算标记（估算标记 `estimated` / `totalEstimated` 仍在快照数据里，留给工具提示 / 详情视图）。用户能读懂的靠顺序与单位：秒/毫秒、`tok/s`、`tok`、`%`
- 累计消耗：`formatTokenCount`（<1000 精确 / <10K `x.xK` / <1M `xK` / ≥1M `x.xM`——百万级是常态，`1200K` 不可读）。**存量快照（无 `totalTokens`）→ 与分隔符整簇隐藏**，不留孤立竖线
- 耗时格式化（`formatDuration`）：<1s → 整数毫秒（`640ms`）；<10s → 一位小数秒（`3.4s`）；≥10s → 整数秒（`12s`）。`durationMs` 缺省 → 同样整簇隐藏
- 上下文只显示**百分比**（绝对值让位给累计消耗——百分比才是驱动「该开新会话了」的那个数）：`contextTokens ÷ contextWindow × 100`（四舍五入取整）
- `contextWindow` 取管理端「模型上下文窗口（tokens）」（`GET /api/app-name` 的 `context_window`，缺省 128000），与 Pi 循环的 `model.contextWindow` **同源**——两处不一致会让条上写着 45% 而循环按另一套窗口判断

## 上游 API 客户端（provider.ts）

```
POST {api_endpoint}/chat/completions
  Headers: Content-Type, Authorization: Bearer {api_key}
  Body: { model, messages, stream: true, max_tokens: 100000,
          enable_thinking: <bool>, tools?: [...] }
```

- **思考模式**：透传 DashScope 兼容参数 `enable_thinking`；关闭时额外置 `thinking_budget: 0`（用于 Qwen3 等默认常开推理的模型彻底关掉思考阶段）。这两个字段不在 OpenAI 规范内：严格实现的端点会以 `400 UNKNOWN_FIELD` 拒绝整个请求，此时**去掉这两个字段原样重发一次**，并把该端点记入进程内缓存，后续请求不再携带；思考内容仍经 `delta.reasoning_content` 透传
- **思考内容**：仅当 `thinkingMode` 为真时才 yield `thinking` 事件（读取 `delta.reasoning_content`）
- **工具**：`ToolDefinition.input_schema` 映射为 OpenAI function 的 `parameters`
- **tool_calls 聚合**：按 `index` 累积 `id`/`name`/`arguments`，`finish_reason` 到达时按 index 排序后一次性 yield
- **超时**：`AbortController` 120 秒，`clearTimeout` 在收到响应头后立即执行
- **流完整性**：reader 结束但既无 `[DONE]` 也无 `finish_reason` → 抛异常
- **容错**：跳过无法解析的 JSON 行；非 2xx 响应读取正文抛错

## 外部依赖

- OpenAI 兼容的 Chat Completions API（流式 + function calling + 可选多模态）
- Pi Agent Core（`@earendil-works/pi-agent-core`）：多轮工具调用循环框架
- 附件解析能力见 `module-file-attachment.md`

## 验收标准

**会话状态条（自动化：`pnpm --filter @momoi/server test`）**

`test/stats.test.ts`（伪造 fetch 驱动真实 `runPiAgentLoop`）

- 单轮纯文本 → `1轮0步`；一次工具往返 + 收尾轮 → `2轮1步`；同一轮内两个工具调用 → `2轮2步`（轮/步为诊断字段，仍按此契约计数）
- 账单增量：两轮（输入 100 / 250、输出 12 / 40）→ `billTokens = 402`——**两轮的输入都算**，且大于「最后一轮的输入+输出」（上下文只看最后一轮，两者不混）
- 整轮无 usage → 走估算（`billEstimated=true`），多轮的账单大于单轮（重发的上下文也计入）
- 空回复搬迁重试 → 作废轮的轮/步/用量/账单全部不并入（`hasUsage` 不残留）
- `history` 非空 → 回填起点 > 0，但**不进**本次生成的账单增量（由落库时合并）
- 耗时墙钟 **⊇** 各轮流式时段；流帧更多 → 耗时更长
- 上游回 usage → 上下文取最后一轮 `prompt+completion` 且 `estimated=false`；不回 usage → `estimated=true`（估算标记只进数据，不上状态条）
- `tok/s` 的分母是纯流式时长：同一输出量下，流帧更多的 tok/s 更低

`test/conversation-stats.test.ts`（纯函数）

- 首次落库 → 采纳回填起点并**永久**标记含估算；`seed=0`（history 为空）不得误标
- 非首次 → 只累加，回填起点不再参与；估算标记**只升不降**
- 脏数据（非法 JSON / 缺字段 / 非数字）一律按「尚未记录」处理
- 历史粗估：空历史 / 只有用户消息 → 0；多次生成时每次都要算上「重发全部历史」

**状态条展示（手工 / 端到端）**

- 状态条显示 `工作区 | 3.4s · 128 tok/s | 1.2M tok | 35%`——**不出现轮/步，也没有中文标签或 `≈`**
- 同一会话连发两条消息 → 累计**只增不减**（第二条后 ≥ 第一条 + 第二条的账单）
- 存量会话（有历史、无 `totalTokens`）首次生成 → 累计含历史回填且 `totalEstimated=true`，此后该会话一直为 true
- IM 渠道（QQ / 微信）回复后 → 网页端状态条同样实时更新，累计同样增大
- 打开已有会话 → 状态条立即显示服务端权威快照；刷新页面后同样从详情端点恢复
- 生成结束 → 本端随 `stats` 事件更新；他端随实时中继或 `conv_changed` 对账收敛到同一组数字
- 格式化：累计 ≥1M 显示 `x.xM`；秒级以下耗时显示毫秒；存量快照不显示对应簇且不留孤立分隔符
- 上下文百分比与管理端「模型上下文窗口」一致（改小窗口 → 百分比上升）
- 列表端点 `GET /api/conversations` **不返回** `stats`；客户端不持有任何判新旧的逻辑（无时间戳、无比较）
- 群聊：耗时为整轮编排墙钟；累计为各成员之和；`tok/s` 与 `contextTokens` 均有值

**原有链路**

- `POST /api/chat` 各终止路径（`done` / `group_done` / `error`）仍保证下发终止事件；`stats` 缺失（如生成失败）不影响前端渲染