# Spec -- 群聊系统（Group Chat）

## 概述

群聊系统支持多个 Agent 在同一对话中依次回复，模拟真实群聊体验。Agent 间可通过 `@mention` 工具点名对话。每轮开始前，中立 Agent 会裁决本轮参与成员（已退场或不懂当前话题者可暂不发言，用户点名者强制参与）。无限演算模式（同样适用于个体聊天）开启后，中立 Agent 自动生成追问实现持续对话。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/server/ai/group-orchestrator.ts` | 群聊编排：多 Agent 串行回复 + 上下文格式化 + @mention 处理 |
| `src/server/ai/neutral-agent.ts` | 中立 Agent：无限模式追问 + 回复后追问建议 + 群聊发言调度 |
| `src/server/ai/pi-adapter.ts` | Agent 循环适配层：系统提示词注入群组身份 + @mention 工具注册 |
| `src/server/tools/group-mention-tool.ts` | @mention 工具：Agent 间点名调用 |
| `src/server/routes/chat.ts` | 群聊入口 + 无限模式开关 + SSE 流管理 |
| `src/server/routes/group.ts` | 群聊 Agent 管理 REST API（增删查） |
| `src/server/routes/conversations.ts` | 对话列表含 `agent_count` + 群聊对话详情含 Agent 列表 |
| `src/client/hooks/useGroupChat.ts` | 群聊状态管理（组合 `useChat`） |
| `src/client/hooks/useChat.ts` | 聊天状态管理（含群聊 SSE 事件处理） |
| `src/client/components/chat/MessageBubble.tsx` | 消息气泡（群聊中显示 Agent 头像和名字） |
| `src/client/lib/api.ts` | 客户端 API 封装（`createGroupConversation`、`addGroupAgent`、`removeGroupAgent`） |

## 数据模型

### 对话类型

`conversations.type` 区分：
- `'direct'` -- 单 Agent 对话
- `'group'` -- 群聊对话

### 群聊 Agent 关联

```sql
CREATE TABLE group_conversation_agents (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, agent_id)
);
```

### 消息追踪

`messages` 表新增 `agent_id` 列，记录每条助手消息的发言 Agent（群聊与单聊均记录）。历史加载时保留 `agent_id`，支持回溯发言者身份。

### MentionSignal

```typescript
interface MentionSignal {
  triggered: boolean
  agentNames: string[]
  message: string | null
}
```

### 无限模式状态

```typescript
// 内存态，按 conversationId 索引
const infiniteState = new Map<string, { enabled: boolean; messageCount: number }>()
```

## 群聊编排流程

```
用户发消息 → POST /api/chat (conversation_type: 'group', agent_ids: [...])
  │
  ├─ 创建/获取群聊对话（type: 'group'）
  ├─ 保存用户消息
  ├─ 插入 group_conversation_agents 关联
  ├─ 发送 SSE: conversation_id
  │
  └─ orchestrateGroupChat()
      │
      ├─ 预加载 Agent 名称映射（agentNameById + agentsById，并行）
      ├─ 解析用户消息中的 @提及（userMentionedIds：强制参与且排队首）
      │
      ├─ 中立 Agent 发言调度（详见下节）
      │   ├─ 门控：成员数 > 1、history 非空、非全员被点名
      │   ├─ 输出本轮跳过名单；失败/超时/全跳过 → 全员参与
      │   └─ 记录缺席名单（内存 Map，供下一轮裁决提示）
      │
      ├─ 随机打乱参与者顺序（shuffleArray）
      │   └─ 第一个 Agent 保持原位，其余随机
      │
      ├─ 发送 SSE: group_start { agent_ids: [...本轮参与者] }
      │
      ├─ prepareGroupHistory() — 初始化累计历史
      │   └─ 其他 Agent 的 assistant 消息 → user 角色 + [Agent名字]: 内容
      │
      └─ while (remaining.length > 0):
          │
          ├─ 取出队首 agentId
          │
          ├─ 发送 SSE: agent_start { agent_id, agent_name }
          │
          ├─ 创建 mentionSignal 对象
          │
          ├─ runPiAgentLoop() — 该 Agent 独立回复
          │   ├─ 系统提示词注入 Agent 身份（姓名 + 群组成员列表）
          │   ├─ 注册 @mention 工具（带 mentionSignal 引用）
          │   └─ SSE: token / thinking / tool_call / tool_result
          │       └─ 事件带 agent_id + agent_name 字段
          │
          ├─ 保存该 Agent 的回复到 DB（带 agent_id）
          │
          ├─ 将回复追加到累计历史（user 角色 + [Agent.name]: 内容）
          │
          ├─ 发送 SSE: agent_done { agent_id, agent_name, reply, suggestions }
          │
          ├─ 检查 mentionSignal.triggered
          │   └─ 被点名 Agent 通过 resolveAgentByName() 查找
          │       └─ 精确匹配 → 模糊匹配（contains）
          │   └─ 成功 → 被点名者插入队首（已发言者获准再次回复，其余 Agent 照常发言）
          │   └─ mentionDepth++，超过 MAX_MENTION_REDIRECTS(5) 则停止
          │
          └─ 异常处理：捕获错误，发送 agent_done（含错误信息），继续下一个 Agent

  └─ 发送 SSE: group_done

  └─ 追问建议（非无限模式）：
      └─ 中立 Agent 基于本轮上下文生成一份 suggestions
          → UPDATE 最后一条 assistant 消息的 suggestions 列
          → 补发 SSE: suggestions { suggestions, agent_id }

  └─ 无限模式：
      └─ 若 infiniteState 启用且未达 MAX_INFINITE_MESSAGES(500)
          └─ generateAndSaveFollowUp() → SSE: follow_up
          └─ 重新加载历史 → 再次 orchestrateGroupChat()
      └─ 关闭时发送 SSE: infinite_mode_off
```

## 上下文格式化（prepareGroupHistory）

**问题**：模型会把 `assistant` 角色的消息当作「自己说过的话」，导致后续 Agent 复述/延续他人内容。

**决策**（D22 + D25）：将历史中其他 Agent 产生的 assistant 消息重写为 `role: 'user'` + `[Agent名字]: 内容` 前缀，使模型能区分「他人发言」与「用户提问」。

**两处应用**：

1. **历史初始化**（`prepareGroupHistory`）：将 DB 加载的已有历史中其他 Agent 的 assistant 消息转为 `role: 'user'` + `[名字]: 内容`。无 `agent_id` 的旧消息保持原样。

2. **累计历史追加**（`accumulatedHistory.push`）：当前 Agent 回复后，以 `role: 'user'` + `[Agent.name]: 内容` 追加到累计历史，供后续 Agent 读取。

**连带修复**：
- `chat.ts` 的 `history` 和 `reloadHistory` 均保留 `agent_id` 字段
- 无限模式的中立 Agent 追问上下文显示 Agent 名字而非 UUID

## 中立 Agent 发言调度

每轮群聊开始前，中立 Agent（`NEUTRAL_AGENT_ID`）基于上下文裁决「本轮哪些成员不需要参与回复」，让已退场（睡下 / 离开 / 拒绝）或明确表示不懂当前话题的成员暂不发言。

**触发门控**：成员数 > 1、history 非空、且非「全员都被用户点名」时才调用（首轮新群聊不裁决，省一次 LLM 调用）。

**输入**：
- 成员名册（名字列表；完整名册，不含中立 Agent）
- 上一轮缺席名单（名字 + 原因）：内存 `Map<conversationId, { at, skips }>`，TTL 10 分钟、上限 200 会话（插入序淘汰），服务重启失效
- 对话上下文：最近 20 条历史 + 当前用户消息；逐行截断（行 400 字 / 用户消息 1500 字 / 总量 6000 字，超限保留最近部分），跳过 `tool` / `system` 行

**输出**：每行 `成员名 | 简短原因`，无人需跳过则输出 `无`。解析容忍编号 / bullet / 围栏 / 包裹引号 / 尾部括号注，**保留名字中的裸数字**（如「3号机」）；名字经 `resolveAgentByName` 模糊匹配回成员，匹配不到的忽略。

**规则**：用户点名 / 提及的成员不得跳过且仍排到队首；被跳过者本轮仍可被其他 Agent 的 `at_mention` 唤醒（现有队列重插逻辑）；至少保留一名成员参与。

**降级（失败开放）**：调用失败 / 10s 超时 / 空结果 → 全员参与，且**不更新**上一轮缺席记忆（瞬时故障不清记忆）；模型回显整个名册导致全跳过 → 整体作废、全员参与。

**静默**：不产生任何 SSE 事件与客户端 UI 变化，仅服务端日志（`Group chat: orchestration skipped ...`）。

## 系统提示词（群组规则）

`buildSystemPrompt`（`pi-adapter.ts`）在 `isGroup=true` 时追加以下规则：

```
## 群组对话规则
你正在参与一个群组对话，其他 Agent 也可能回复用户。请遵守：
当前群组有N个Agent：A、B、C，你是其中的 X
- 对话历史中所有以 [Agent名字]: 开头的消息，都是【其他 Agent】或你之前的发言记录，不是用户说的。
- 不要复述、引用或延续其他 Agent 已经说过的内容，也不要假装那些话是你说的。
- 根据用户的最新消息，用你自己的人设独立、自然地回答。
- 如果你需要某个特定 Agent 的专业知识，请使用 at_mention 工具 @他们。
- 被 @ 的 Agent 会在本轮内优先回复，但其他 Agent 仍然会照常发言。
- 只在你确实需要对方回答用户问题或提供互补知识时才使用 at_mention，不要为了社交而 @。
- 不要 @ 你自己。
- 每次对话最多使用一次 at_mention。
```

## @mention 工具

群聊中 Agent 可调用 `at_mention` 工具点名其他 Agent。

**工具定义**（`createMentionTool`）：

- `agent_name` (string, required) -- 被点名 Agent 的精确名称
- `message` (string, required) -- 发送给被点名 Agent 的消息

**行为**：
- 设置 `mentionSignal.triggered = true`，记录 `agentNames` 与 `message`
- 返回 `terminate: false`（工具循环继续，Agent 在回复文本中自然写出 @名字）
- 编排器检测到信号后，通过 `resolveAgentByName` 查找目标 Agent：
  - 第一轮：精确匹配（大小写不敏感）
  - 第二轮：模糊匹配（name 包含搜索词）
- 被点名 Agent 插入到处理队列头部；已发言者清出 `repliedAgents` 以获准再次回复；其余 Agent 照常发言
- 最多 5 次 @mention 重定向（`MAX_MENTION_REDIRECTS`），防止死循环
- 被点名 Agent 的应答再触发 @mention 时，继续递归处理（depth 计数）
- 点名不存在的 Agent 名称时，信号静默忽略，继续处理后续 Agent

**注册方式**：`pi-adapter.ts` 的 `createToolAdapter` 在 `toolCtx.mentionSignal` 存在时动态添加 `at_mention` 工具（非静态模块注册，因为 `MentionSignal` 是运行时创建的引用对象）。

## 无限演算模式

个体聊天或群聊中均可开启，每轮 Agent 回复完毕后，中立 Agent 自动生成追问，以用户口吻触发下一轮对话。

### 开启/关闭

- `POST /api/chat/infinite-mode` -- `{ conversation_id, enabled: true/false }`
- 需用户 JWT，验证对话所有权
- 开启时统计当前消息数存入 `infiniteState`
- 关闭时删除 `infiniteState` 条目
- 状态存储于内存 `infiniteState` Map（key: conversationId），服务重启后需重新开启

### 追问生成（`generateNeutralFollowUp`）

- 中立 Agent 系统提示词：以用户口吻生成自然追问
- 输入：最近 20 条消息的上下文（含 Agent 名字，非 UUID）
- 追问形式：问题、反问、动作描述（如「（托腮思考了一会儿）」）
- 如果对话已自然结束，输出「（继续）」
- 追问通过 `follow_up` SSE 事件下发
- 追问内容以 `role: 'user'` 存入 DB，作为下一轮对话的用户消息
- 支持额外系统提示词注入（从 `neutralAgent.system_prompt` 读取）

### 循环控制

- `MAX_INFINITE_MESSAGES = 500`：达到上限自动关闭
- `checkInfinite()`：检查 `enabled` 状态和 `messageCount` 上限
- 关闭时发送 `infinite_mode_off` SSE 事件
- 循环结束后清理 `infiniteState`

### 无限演算模式下的系统提示词

`buildSystemPrompt` 在 `infiniteMode=true` 时：
- 不注入 suggestions 相关指令（普通 Agent 的提示词已彻底不含建议生成要求，任何模式下均由中立 Agent 单独负责）
- 追加对话规则：自然回复、允许括号动作描述、保持流畅

无限模式下（单聊与群聊）不生成 suggestions，追问由中立 Agent 的 follow_up 负责。

## SSE 事件流

群聊模式下的完整事件序列：

```
conversation_id { id }
  → group_start { agent_ids: [...] }        // 本轮实际参与者（可能少于群成员）
    → agent_start { agent_id, agent_name }
      → token / thinking / tool_call / tool_result  (均带 agent_id + agent_name)
    → agent_done { agent_id, agent_name, reply, suggestions }   // suggestions 正常路径为空数组
    → agent_start { agent_id, agent_name }  // 下一个 Agent
      → ...
    → agent_done
  → group_done
  → suggestions { suggestions, agent_id }  // 非无限模式：中立 Agent 补发一份（挂在最后发言 Agent 的消息上）
  → follow_up { text }      // 无限模式追问（可选）
  → infinite_mode_off       // 无限模式关闭（可选）
```

### 客户端处理（`useChat.ts`）

| 事件 | 处理 |
|---|---|
| `agent_start` | 创建新的 streaming assistant 气泡，带 `agent_id` + `agent_name` |
| `token` / `thinking` / `tool_call` / `tool_result` | 追加到最后一个 assistant 气泡（与单 Agent 模式相同，但事件带 `agent_id`/`agent_name` 辅助字段） |
| `agent_done` | 标记该 Agent 气泡为完成，覆盖 `reply` 和 `suggestions`（正常为空数组） |
| `group_done` | 非无限模式时设置 `loading=false` |
| `suggestions` | 中立 Agent 补发的追问建议：更新最后一条 assistant 气泡的 chips（`agent_id` 为最后发言 Agent）；用户已抢发新消息或 agent_id 不匹配时静默丢弃 |
| `follow_up` | 创建 user 消息气泡；群聊模式下不创建 assistant 占位气泡（由下一轮 `agent_start` 创建） |
| `infinite_mode_off` | 设置 `loading=false` |
| `group_start` | 静默消费（不产生 UI 变化）；`agent_ids` 为本轮实际参与者 |

**气泡渲染**：`MessageBubble` 在非用户消息且 `agentName` 存在时，显示 Agent 名字标签和头像（`agentAvatar` 优先，否则默认 Bot 图标）。

## API 端点

### POST /api/chat (群聊模式)

请求体包含 `conversation_type: 'group'` 和 `agent_ids: string[]`。

**认证**：需用户 JWT（`userAuthMiddleware`）

**请求**：
```json
{
  "message": "用户消息",
  "conversation_id": "可选-已有对话ID",
  "conversation_type": "group",
  "agent_ids": ["uuid1", "uuid2", "uuid3"],
  "thinking_mode": true,
  "infinite_mode": false
}
```

**行为**：
- 新建对话时创建 `type: 'group'` 的 conversation，插入 `group_conversation_agents` 关联
- 复用时校验对话所有权
- 调用 `orchestrateGroupChat()` 执行多 Agent 编排
- 无限模式下循环调用 `generateAndSaveFollowUp()` + `orchestrateGroupChat()`

### POST /api/chat/infinite-mode

开关无限演算模式。需用户 JWT，验证对话所有权。

**请求**：`{ "conversation_id": "uuid", "enabled": true/false }`

**响应**：`{ "success": true, "enabled": true/false }`

**错误**：
- `400` -- `conversation_id` 缺失
- `401` -- 未认证
- `404` -- 对话不存在或无权访问

### GET /api/group/:id/agents

获取群聊对话的 Agent 列表。需用户 JWT，验证对话所有权。排除中立 Agent。

**响应**：
```json
{
  "agents": [
    { "id": "uuid", "name": "Agent名", "avatar": "base64..." }
  ]
}
```

### POST /api/group/:id/agents

添加 Agent 到群聊对话。需用户 JWT，验证对话所有权。

**请求**：`{ "agent_id": "uuid" }`

**行为**：
- 按当前最大 `sort_order + 1` 设置新 Agent 的排序
- 拒绝添加中立 Agent（`NEUTRAL_AGENT_ID`），返回 `403`

### DELETE /api/group/:id/agents/:agentId

从群聊对话移除 Agent。需用户 JWT，验证对话所有权。

### POST /api/conversations (创建群聊对话)

**请求**：`{ "type": "group", "agent_ids": ["uuid1", "uuid2"], "title": "可选标题" }`

**行为**：
- 创建 `type: 'group'` 的 conversation
- 按数组顺序插入 `group_conversation_agents`（`sort_order` 从 0 开始）
- 跳过 `NEUTRAL_AGENT_ID`

### GET /api/conversations/:id (获取对话详情)

群聊对话额外返回 `agents` 数组（含 `id`、`name`、`avatar`）。

列表接口中群聊对话返回 `agent_count` 字段（不含中立 Agent）。

## 行为约束

1. **Agent 回复顺序**：第一个 Agent 保持原位，其余随机打乱（`shuffleArray`），每轮不同
2. **上下文格式化**：前序 Agent 回复以 user 角色 + `[名字]: 内容` 注入后续上下文（防止复述/照抄）
3. **@mention 重定向**：最多 5 次，防止死循环
4. **@mention 优先回复**：被点名 Agent 插入队首，其余 Agent 照常发言（不清空队列）
5. **中立 Agent 不参与群聊回复**：仅生成无限模式追问、回复后追问建议与群聊发言调度；`NEUTRAL_AGENT_ID` 在 Agent 列表 API 中排除，在添加 Agent 时拒绝
6. **无限模式状态存于内存**：`infiniteState` Map，服务重启后需重新开启
7. **无限模式消息上限**：500 条后自动关闭（`MAX_INFINITE_MESSAGES`）
8. **群聊对话创建**：`conversations.type = 'group'`，同时插入 `group_conversation_agents`
9. **每条消息记录 agent_id**：支持历史回溯发言者身份
10. **Agent 异常容错**：单个 Agent 失败时发送错误 `agent_done` 事件，继续处理下一个 Agent
11. **Agent 不存在跳过**：`getAgent` 返回 null 时 `console.warn` 并跳过
12. **SSE 写入链**：`writeChain` 串行化 `writeSSE` 调用，防止尾部事件（`agent_done`、`group_done`）因 `stream.close()` 提前关闭而丢失（D23）
13. **保活**：每 15 秒发送 SSE 注释 `:\n\n`，防止代理/浏览器关闭空闲连接（群聊可能耗时较长）
14. **发言调度失败开放**：裁决失败 / 超时（10s）/ 空结果 → 全员参与；模型回显整个名册导致全跳过 → 整体作废
15. **用户点名强制参与**：用户 @ 或提及的成员不进入跳过集，且仍排到队首
16. **发言调度静默**：不产生 SSE 事件与客户端 UI 变化，仅服务端日志
17. **缺席记忆为内存态**：`Map<conversationId, { at, skips }>`，TTL 10 分钟、上限 200 会话，重启失效

## 客户端状态管理（useGroupChat.ts）

### 状态

| 状态 | 说明 |
|---|---|
| `groupAgents` | 当前群聊的 Agent 列表（`{ id, name, avatar }[]`） |
| `isGroupMode` | 当前对话是否为群聊模式 |
| `allAgents` | 所有可用 Agent（加载于 mount） |

### 方法

| 方法 | 说明 |
|---|---|
| `selectConversation(id)` | 预取对话详情判断群聊模式，再加载消息 |
| `createGroupConversation(agentIds)` | 创建群聊对话，设置 hash，刷新侧边栏 |
| `addAgentToGroup(agentId)` | 调用 API 添加 Agent，更新本地状态 |
| `removeAgentFromGroup(agentId)` | 调用 API 移除 Agent，更新本地状态 |
| `sendGroupMessage(text, thinkingMode, attachments?, infiniteMode?)` | 发送群聊消息（聚合 `groupAgents` 的 ID 数组） |

### 与 useChat 的关系

`useGroupChat` 组合 `useChat`（通过 `...chat` spread），群聊消息最终通过 `chat.sendMessage` 发送，传递 `groupMode: true`、`groupAgentIds`、`infiniteMode` 参数。

群聊模式下 `sendMessage` 不创建 assistant 占位气泡（`groupMode ? [] : [assistantMsg]`），由 `agent_start` SSE 事件动态创建各 Agent 的气泡。

## 验收标准

1. 群聊中多个 Agent 依次回复，不重复、不照抄
2. @mention 被点名 Agent 立即应答，其他 Agent 被跳过
3. 无限模式自动生成追问，对话持续进行
4. 无限模式可随时关闭，前端收到 `infinite_mode_off` 事件
5. 群聊历史消息正确显示发言者头像和名字
6. 刷新页面后群聊历史正确还原（`agent_id` 持久化 + 按 `sort_order` 查询 Agent 列表）
7. 单个 Agent 失败不影响其他 Agent 继续回复
8. @mention 死循环防护生效（最多 5 次重定向）
9. 无限模式消息上限 500 条后自动关闭
10. 群聊与单 Agent 对话可共存，切换对话时正确识别模式
11. 已声明退场 / 不懂当前话题的成员在后续轮次被跳过；用户 @ 后立即回归
12. 发言调度失败 / 超时 / 全员被跳过 → 全员参与（失败开放），不出现未捕获异常
13. 群聊发言调度不产生任何 SSE 事件与客户端 UI 变化