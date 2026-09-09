# Spec — 聊天模块（Chat）

## 概述

聊天模块是 Momoi 的核心，负责用户与 AI 之间的实时对话。系统支持两种对话模式：**直接对话**（单个 Agent）和**群聊**（多个 Agent 串行回复）。此外，**无限演算模式**可作为独立开关叠加在任意对话类型上，由中立 Agent 自动生成追问实现持续对话循环。服务端基于 Pi Agent Core 实现多轮工具调用循环，客户端通过 SSE 流式接收事件。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/server/routes/chat.ts` | SSE 流式端点 `POST /api/chat`、附件拼装、对话创建、无限模式开关 |
| `src/server/ai/pi-adapter.ts` | Pi Agent Core 适配层：系统提示词构建 + 工具适配 + 流式映射 + Agent 循环入口 |
| `src/server/ai/provider.ts` | OpenAI 兼容 API 流式客户端（含多模态与 thinking 参数） |
| `src/server/ai/group-orchestrator.ts` | 群聊编排：多 Agent 串行回复 + @mention 处理 + 无限模式 |
| `src/server/ai/neutral-agent.ts` | 中立 Agent：生成无限模式追问 |
| `src/server/ai/tools.ts` | 工具注册表（委托到内置工具 registry） |
| `src/server/tools/group-mention-tool.ts` | @mention 工具：Agent 间点名调用 |
| `src/shared/thinking.ts` | thinking 分段的编解码 |
| `src/client/hooks/useChat.ts` | 客户端聊天状态管理 + SSE 解析 + 重试 + 哈希路由 |
| `src/client/hooks/useGroupChat.ts` | 群聊状态管理 |

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
  "infinite_mode": false
}
```

- `message` 为空或全空白 → `400 { "error": "Empty message" }`
- `thinking_mode` 判定为 `thinking_mode !== false`，即**省略时默认开启**
- `conversation_type`：`direct`（默认）为单 Agent 对话，`group` 为群聊模式
- `agent_ids`：群聊模式下指定参与 Agent 的 ID 列表
- `infinite_mode`：是否开启无限演算模式（中立 Agent 自动追问）
- `attachments` 见 `module-file-attachment.md`

**响应**：SSE 流（`Content-Type: text/event-stream`），每条事件通过 `event: message` + `data: {json}` 发送。

**事件类型**（`ServerMessage` 联合类型）：

| 事件 | 数据 | 说明 |
|---|---|---|
| `conversation_id` | `{ id: string }` | 对话 ID（新建或复用时都会发送） |
| `token` | `{ text: string, agent_id?, agent_name? }` | 文本增量 token |
| `thinking` | `{ text: string, round?: number, agent_id?, agent_name? }` | 思考过程增量 token；`round` 为分段轮号 |
| `tool_call` | `{ id?: string, name: string, input: object, agent_id?, agent_name? }` | AI 发起工具调用 |
| `tool_execution_start` | `{ id?: string, name: string, input: object, agent_id?, agent_name? }` | 工具实际开始执行 |
| `tool_result` | `{ id?: string, name: string, summary: string, artifacts?, agent_id?, agent_name? }` | 工具调用结果 |
| `agent_start` | `{ agent_id: string, agent_name: string }` | 群聊中某个 Agent 开始回复 |
| `agent_done` | `{ agent_id: string, agent_name: string, reply: string, suggestions: string[] }` | 群聊中某个 Agent 回复完成 |
| `group_start` | `{ agent_ids: string[] }` | 群聊开始（含 Agent 顺序） |
| `group_done` | `{ infinite?: boolean }` | 群聊结束 |
| `follow_up` | `{ text: string }` | 无限模式：中立 Agent 生成的追问 |
| `infinite_mode_off` | `{}` | 无限模式已关闭 |
| `done` | `{ reply: string, suggestions: string[], agent_id?, agent_name?, infinite? }` | 对话完成（终止事件） |
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

## 行为约束

### 服务端（chat.ts）

1. **对话归属校验**：传入 `conversation_id` 时校验 `user_id` 是否为当前用户，不匹配则发送 `error` 事件并终止
2. **新建对话**：未传 ID 时以 `randomUUID()` 创建，标题取消息前 40 字符（空则 `New Chat`）。群聊默认标题为 `群组对话`
3. **Agent 选择**：新建对话时记录 `agent_id` 和 `type`（`direct` / `group`）
4. **群聊初始化**：群聊创建时写入 `group_conversation_agents` 关联表
5. **重试去重**：`_retry === true` 时**跳过**保存用户消息，避免重复入库
6. **更新时间**：每次收到用户消息都刷新 `conversations.updated_at`
7. **历史裁剪**：从 DB 读取该对话全部消息后 `slice(0, -1)` 去掉刚插入的当前消息，作为 history 传入 AI 循环
8. **助手消息持久化**：仅当 `reply` 非空才写入，保存 `content`、`thinking`、`suggestions`、`attachments`、`agent_id`
9. **文档附件复制到工作区**：`docx/pptx/xlsx/xls/pdf` 附件会自动复制到对话工作区
10. **无限模式循环**：每次 Agent 回复后由中立 Agent 生成追问，重新加载历史并启动新一轮 AI 循环，直到关闭或达上限

### 服务端（pi-adapter.ts）

Pi Agent Core 适配层，将 Momoi 的工具和流式客户端桥接到 Pi 的 Agent 循环框架。

1. **Agent 选择**：`agent_id` 参数 → `getAgent()`，不存在则回退到第一个非中立 Agent
2. **系统提示词构建**（`buildSystemPrompt`）：
   - 基础内容 = Agent 的 `system_prompt`
   - 若存在技能，追加 `## Available Skills` + 每个技能的名称和描述摘要
   - 思考模式关闭时追加 `/no_think` 指令
   - 追加当前日期时间
   - 无限模式：替换 suggestions 指令为「无限演算模式」指引
   - 非无限模式：追加硬编码的 `## 建议` + suggestions 格式指令（置于末尾保证即使 system_prompt 是强人设也不会吞掉）
   - 群聊模式：追加群组对话规则 + Agent 身份感知 + at_mention 使用指引
3. **工具适配**：12 个 `ToolModule` → Pi `AgentTool`（TypeBox schemas）。群聊时额外添加 `at_mention` 工具
4. **Stream 函数**（`createStreamFn`）：包装 `provider.ts` 为 Pi 兼容的 `StreamFn`，将 Pi 消息格式转换为 `ChatMessage` 格式
5. **Pi `runAgentLoop`**：内置多轮工具调用循环、并行执行、事件流式输出
6. **Suggestions 围栏扣留**：维护 `SUGGESTIONS_FENCE.length` 长度的缓冲区，围栏跨 token chunk 到达时仍然被完整检测
7. **Suggestions 解析**（`parseSuggestions`）：
   - 用 `lastIndexOf` 定位**真正末尾**的 `` ```suggestions `` 块
   - 去除行首空白、`-`、`*`、数字与点等前缀，过滤空行，最多取 3 条
   - 未找到围栏时只做 `trimEnd()`
8. **多轮思考链分段**：每一轮的第一条 thinking 前注入「思考片段 N」分隔符，`thinking` SSE 事件带 `round` 字段
9. **统一收口**：`agent_end` 事件中 flush pending buffer，发送 `done` 事件。兜底为空时固定提示
10. **取消**：`signal.aborted` 时发送 `error` 并返回

### 群聊编排（group-orchestrator.ts）

1. **Agent 顺序随机化**：第一个 Agent 保持原位，其余随机排列（制造自然对话感）
2. **历史格式化**（`prepareGroupHistory`）：将其他 Agent 的 assistant 消息转换为 `[Agent名字]: 内容` 的 user 角色消息，避免模型误认为是自己说过的话
3. **串行执行**：Agent 逐个回复，后续 Agent 能看到前面 Agent 的发言
4. **@mention 检测**：Agent 调用 `at_mention` 工具后，当前轮剩余 Agent 被跳过，被点名者立即应答。最多 5 次重定向
5. **事件标记**：所有 SSE 事件附加 `agent_id` 和 `agent_name` 字段，`agent_start` / `agent_done` 标记 Agent 回复边界
6. **无限模式**：所有 Agent 回复完毕后，中立 Agent 生成追问

### 客户端（useChat.ts）

1. **请求头**：同时携带 `X-User`（encodeURIComponent）与 `Authorization: Bearer <token>`
2. **重试策略**：最多 3 次（`MAX_RETRIES`），指数退避 `2s → 4s → 8s`，上限 `10s`
3. **重试标记**：重试请求带 `_retry: true`，并在重发前清空当前助手气泡内容
4. **空闲超时**：60 秒无数据则 `abort()` 触发重试
5. **部分响应保护**：流结束但未收到 `done`/`error` 时——
   - 已收到过 token → 视为**优雅关闭**，保留已有内容，不再重试
   - 完全没收到 token → 抛错进入重试
6. **取消判定**：通过 `abortRef.current !== abort` 区分「用户主动取消」与「空闲超时中断」
7. **收尾对齐**：整轮结束后重新 `GET /api/conversations/{id}` 拉取真实消息，为本地乐观创建的消息补上服务端 ID
8. **哈希路由**：`#/c/{conversationId}`
   - 首次消息创建对话 → `replaceState` 写入 hash
   - 选中对话 → `pushState`（支持后退）
   - 新建/删除当前对话 → 清除 hash
   - 监听 `hashchange` 支持浏览器前进后退
9. **导出**：客户端拼接 `# 标题` + 每条 `### User` / `### <Agent 名称>`，以 `---` 分隔，生成 `.md` 下载
10. **多轮思考分段渲染**：SSE `thinking` 事件带 `round` 字段时，前端按轮聚合为 `thinkingSegments`；历史消息通过 `decodeThinkingToSegments` 切分
11. **群聊消息渲染**：消息带 `agent_id` / `agent_name` 字段，显示 Agent 头像和名称

### 客户端（useGroupChat.ts）

组合 `useChat` 并扩展群聊专用能力：

1. **Agent 列表**：从 `GET /api/app-name` 加载所有可用 Agent
2. **群聊检测**：切换对话时通过 `GET /api/conversations/:id` 检测 `type === 'group'`，加载群组成员
3. **创建群聊**：`createGroupConversation(agentIds)` 调用 API 创建群组对话
4. **发送消息**：`sendGroupMessage` 携带 `agent_ids` 和 `conversation_type: 'group'`
5. **成员管理**：`addAgentToGroup` / `removeAgentFromGroup` 增删群组成员

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