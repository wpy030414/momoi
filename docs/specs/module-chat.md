# Spec — 聊天模块（Chat）

## 概述

聊天模块是 Momoi 的核心，负责用户与 AI 之间的实时对话。包含服务端 SSE 流式端点、多轮工具调用循环（Pi 式并行批执行）、思考模式与附件多模态，以及客户端 React Hook。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/server/routes/chat.ts` | SSE 流式端点 `POST /api/chat`、附件拼装、对话创建 |
| `src/server/ai/loop.ts` | 聊天循环：系统提示词构建 + 工具调用（Pi 式并行）+ 漂移检测 + 多轮思考分段 + 追加收尾轮 + suggestions 解析 |
| `src/server/ai/provider.ts` | OpenAI 兼容 API 流式客户端（含多模态与 thinking 参数） |
| `src/server/ai/tools.ts` | 工具注册表（委托到内置工具 registry） |
| `src/shared/thinking.ts` | thinking 分段的编解码（服务端 loop 注入、客户端解析共用） |
| `src/client/hooks/useChat.ts` | 客户端聊天状态管理 + SSE 解析 + 重试 + 哈希路由 |

## 接口契约

### POST /api/chat

**认证**：需用户 JWT（`userAuthMiddleware`，严格模式）。缺失 → `401`。

**请求**：
```json
{
  "message": "用户消息文本",
  "conversation_id": "可选-已有对话ID",
  "_retry": false,
  "thinking_mode": true,
  "attachments": [{ "url": "...", "name": "...", "size": 123, "type": "image/png" }]
}
```

- `message` 为空或全空白 → `400 { "error": "Empty message" }`
- `thinking_mode` 判定为 `thinking_mode !== false`，即**省略时默认开启**
- `attachments` 见 `module-file-attachment.md`

**响应**：SSE 流（`Content-Type: text/event-stream`），每条事件通过 `event: message` + `data: {json}` 发送。

**事件类型**（`ServerMessage` 联合类型）：

| 事件 | 数据 | 说明 |
|---|---|---|
| `conversation_id` | `{ id: string }` | 对话 ID（新建或复用时都会发送） |
| `token` | `{ text: string }` | 文本增量 token |
| `thinking` | `{ text: string, round?: number }` | 思考过程增量 token；`round` 为分段轮号（多轮思考按段聚合） |
| `tool_call` | `{ id?: string, name: string, input: object }` | AI 发起工具调用（含参数） |
| `tool_execution_start` | `{ id?: string, name: string, input: object }` | 工具实际开始执行 |
| `tool_result` | `{ id?: string, name: string, summary: string, artifacts?: ToolArtifact[] }` | 工具调用结果（含可选产物文件） |
| `done` | `{ reply: string, suggestions: string[] }` | 对话完成（终止事件） |
| `error` | `{ message: string }` | 错误（终止事件） |

**保活**：每 15 秒发送 SSE 注释 `:\n\n`，防止代理/浏览器关闭空闲连接。

**终止保证**：`try/catch/finally` 兜底 —— handler 内任何未捕获异常都会转成 `error` 事件下发，`finally` 中清理心跳定时器。客户端因此总能收到终止事件。

**写入失败容忍**：`send()` 写失败即置 `aborted=true` 并静默丢弃后续事件（终止事件失败会打一条 `console.warn`），避免客户端已断开时抛错污染日志。

### GET /api/chat/health

健康检查，返回 `{ status: 'ok', time: ISO8601 }`。同样受聊天路由认证中间件保护。

## 行为约束

### 服务端（chat.ts）

1. **对话归属校验**：传入 `conversation_id` 时校验 `user_id` 是否为当前用户，不匹配则发送 `error` 事件并终止（不返回 HTTP 403，因为响应头已发出）
2. **新建对话**：未传 ID 时以 `randomUUID()` 创建，标题取消息前 40 字符（空则 `New Chat`）
3. **重试去重**：`_retry === true` 时**跳过**保存用户消息，避免重复入库
4. **更新时间**：每次收到用户消息都刷新 `conversations.updated_at`
5. **历史裁剪**：从 DB 读取该对话全部消息后 `slice(0, -1)` 去掉刚插入的当前消息，作为 history 传入 loop
6. **助手消息持久化**：仅当 `reply` 非空才写入，保存 `content`、`thinking`、`suggestions`（空数组存 null）、`attachments`（工具产物）
7. **文档附件复制到工作区**：`docx/pptx/xlsx/xls/pdf` 附件会自动复制到对话工作区，供 AI 通过 `read_document` 工具访问

### 服务端（loop.ts）

1. **历史裁剪**：`history.slice(-MAX_HISTORY_MESSAGES)`，只发送最近 20 条
2. **工具循环上限**：最多 5 轮（`MAX_TOOL_ROUNDS`）；超出后使用最近一次流式正文兜底，确保有非空回复
3. **系统提示词构建**（`buildSystemPrompt`）：
   - 基础内容 = `config.system_prompt`
   - 若存在技能，追加 `## Available Skills` + 每个技能的名称和描述摘要（完整内容通过 `load_skill` 工具按需加载）；技能列表包含提示：如果用户请求与技能描述不匹配，不要强行加载试探
   - 思考模式关闭时追加 `\n\n/no_think\n请直接回答问题，不要输出任何思考过程或推理步骤。`
   - 追加工具使用规范（防止 write_file 死循环、技能止损等）
   - **最后**追加硬编码的 `## 输出格式（最高优先级，不得省略）` suggestions 指令 —— 置于末尾以保证即使 system_prompt 是强人设也不会吞掉格式要求
4. **Suggestions 围栏扣留**：见 `DECISIONS.md` D10 — 维护 `SUGGESTIONS_FENCE.length` 长度的缓冲区，围栏跨 token chunk 到达时仍然被完整检测
5. **Suggestions 解析**（`parseSuggestions`）：
   - 用 `lastIndexOf` 定位**真正末尾**的 `` ```suggestions `` 块，避免匹配到模型在正文里复述的格式示例
   - 去除行首空白、`-`、`*`、数字与点等前缀，过滤空行，最多取 3 条
   - 未找到围栏时只做 `trimEnd()`，**保留首部字符**（因为 done 的 reply 会覆盖客户端已流式拼接的内容）
6. **Pi 式并行批执行**：
   - 同一轮内所有工具通过 `Promise.all` 并发执行
   - 结果按模型发起顺序回填，上下文不乱序
   - `ToolResult.terminate` 信号：本批所有工具都要求终止时提前收口
7. **漂移检测**：
   - 记录每轮工具调用批次签名：`calls.map(c => `${c.name}:${c.arguments}`).join('|')`
   - 连续两轮完全相同 → 强制终止，注入 `BLOCKED: 你已连续调用完全相同的工具两次`
8. **输出截断终止**：
   - `finishReason === 'length'` 时跳过工具执行，回填错误消息，让模型用文本收尾
   - 防止截断的参数被错误执行
   - 若本轮产出过 thinking，在思考片段尾部追加 `THINKING_TRUNCATED_MARK`（`…（思考被输出长度截断）…`）标记，供前端提示
9. **write_file 软提醒**：
   - `writeFileCount` 计数器追踪写入次数
   - 第 2 次及以后：返回温和提示（"已经是第 N 次调用，写完请回复用户"），但正常执行
   - 不强制拒绝，允许合理的多文件写入场景
10. **多轮思考链分段**：
    - 每一轮的第一条 thinking 前注入「思考片段 N」分隔符（`THINKING_SEGMENT_OPEN + (round+1) + THINKING_SEGMENT_CLOSE`），`thinking` SSE 事件带 `round` 字段
    - DB 存含分隔符的纯文本，编解码见 `shared/thinking.ts`；前端按段分块展示
11. **统一收口**：
    - 每一条路径都有 `done` 事件发送，绝不静默退出
    - 优先尝试「追加纯文本收尾轮」（`runFinalAnswerRound`）：用完整上下文（含全部工具结果）+ 一条 `user` 指令，发起一次**不带工具、不开思考**的请求，让模型整理出完整回答（含 suggestions）
    - 追加轮失败/空回复 → 回退用最近一次流式正文兜底；兜底为空时固定提示："（已完成思考但未能给出有效回答：已中止反复的工具调用。请换一种问法重试。）"
12. **取消**：`signal.aborted` 时发送 `error: '已取消'` 并返回

### 客户端（useChat.ts）

1. **请求头**：同时携带 `X-User`（encodeURIComponent）与 `Authorization: Bearer <token>`
2. **重试策略**：最多 3 次（`MAX_RETRIES`），指数退避 `2s → 4s → 8s`，上限 `10s`
3. **重试标记**：重试请求带 `_retry: true`，并在重发前清空当前助手气泡内容
4. **空闲超时**：60 秒无数据则 `abort()` 触发重试
5. **部分响应保护**：流结束但未收到 `done`/`error` 时——
   - 已收到过 token → 视为**优雅关闭**，保留已有内容，不再重试（重试会重复消息并浪费 token）
   - 完全没收到 token → 抛错进入重试
6. **取消判定**：通过 `abortRef.current !== abort` 区分「用户主动取消」与「空闲超时中断」
7. **收尾对齐**：整轮结束后重新 `GET /api/conversations/{id}` 拉取真实消息，为本地乐观创建的消息补上服务端 ID（回退按钮依赖真实 ID）；此步失败不致命，仅导致回退按钮不显示
8. **哈希路由**：`#/c/{conversationId}`
   - 首次消息创建对话 → `replaceState` 写入 hash
   - 选中对话 → `pushState`（支持后退）
   - 新建/删除当前对话 → 清除 hash
   - 监听 `hashchange` 支持浏览器前进后退；加载失败（越权/不存在）则清除 hash 回到初始页
9. **导出**：客户端拼接 `# 标题` + 每条 `### 🧑 User` / `### 🤖 Assistant`，以 `---` 分隔，生成 `.txt` 下载；文件名过滤 `\/:*?"<>|`
10. **工具调用**：内置工具（`read_file`、`write_file`、`list_files`、`delete_file`、`http_request`、`read_document`、`write_document`、`load_skill`、`list_skill_files`、`bash`）由 AI 通过 function calling 自动调用，结果以独立助手气泡展示。详见 `specs/module-tool-system.md`
11. **多轮思考分段渲染**：SSE `thinking` 事件带 `round` 字段时，前端按轮聚合为 `thinkingSegments`；加载历史消息时，把含分隔符的纯文本 `thinking` 通过 `decodeThinkingToSegments`（`shared/thinking.ts`）切分成段。`ThinkingBlock` 优先渲染分段（每段一个折叠块，标「思考片段 N」），无分段（单段/历史）则回退整段显示；含 `THINKING_TRUNCATED_MARK` 的段显示「思考被截断」徽标

## 上游 API 客户端（provider.ts）

```
POST {api_endpoint}/chat/completions
  Headers: Content-Type, Authorization: Bearer {api_key}
  Body: { model, messages, stream: true, max_tokens: 100000,
          enable_thinking: <bool>, tools?: [...] }
```

- **思考模式**：透传 DashScope 兼容参数 `enable_thinking`；关闭时额外置 `thinking_budget: 0`（用于 Qwen3 等默认常开推理的模型彻底关掉思考阶段）
- **思考内容**：仅当 `thinkingMode` 为真时才 yield `thinking` 事件（读取 `delta.reasoning_content`）；`loop.ts` 注入「思考片段 N」分隔符并附加 `round` 字段后透传
- **工具**：`ToolDefinition.input_schema` 映射为 OpenAI function 的 `parameters`
- **tool_calls 聚合**：按 `index` 累积 `id`/`name`/`arguments`（arguments 跨 chunk 拼接），`finish_reason` 到达时按 index 排序后一次性 yield
- **收尾轮**：追加纯文本收尾请求时传 `tools: []` 且 `thinkingMode=false`（`enable_thinking=false` + `thinking_budget=0`），模型无法调用工具、直接整理最终回答
- **超时**：`AbortController` 120 秒，**`clearTimeout` 在收到响应头后立即执行** —— 该超时只覆盖「建立连接/等待响应头」阶段，不限制流本身的持续时间
- **流完整性**：reader 结束但既无 `[DONE]` 也无 `finish_reason` → 抛 `Upstream API stream closed unexpectedly without [DONE] signal`
- **容错**：跳过无法解析的 JSON 行；非 2xx 响应读取正文抛 `API error {status}: {text}`

## 外部依赖

- OpenAI 兼容的 Chat Completions API（流式 + function calling + 可选多模态）
- 附件解析能力见 `module-file-attachment.md`