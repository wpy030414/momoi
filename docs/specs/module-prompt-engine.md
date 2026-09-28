# Spec — 提示词规则引擎（Prompt Rule Engine）

## 概述

提示词规则引擎（`apps/server/src/prompts/`）把散落在服务端各处的提示词收敛为**可查找、可管理、可组装**的规则片段。三个核心概念：

| 概念 | 类型 | 说明 |
|---|---|---|
| 片段（规则） | `PromptFragment` | 一段带条件的提示词文本 + 它的作用位置 |
| 配方（目标） | `PromptTarget` + `PromptTargetSpec` | 某个调用场景要组装的完整提示词及其层顺序 |
| 引擎 | `PromptEngine` | 注册表 + 组装流水线 + 逐段溯源 |

设计立场：**提示词文本只应存在于 `prompts/fragments/**`**。装配方（pi-adapter、neutral-agent、通知模块等）只保留调用点，不再内联任何指令文本。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `apps/server/src/prompts/types.ts` | 类型契约（片段 / 配方 / 组装结果 / 元信息） |
| `apps/server/src/prompts/engine.ts` | `PromptEngine`：注册表 + 分层组装 + 容错 + 溯源 |
| `apps/server/src/prompts/instance.ts` | 全局单例（打断循环依赖的独立模块） |
| `apps/server/src/prompts/registry.ts` | 内置片段的注册与配方定义（导入即生效） |
| `apps/server/src/prompts/index.ts` | 公共出口（外部一律从此导入） |
| `apps/server/src/prompts/preview.ts` | 管理端预览的上下文白名单归化 |
| `apps/server/src/prompts/fragments/core.ts` | 默认人设兜底 + `resolveAgentPersona()` |
| `apps/server/src/prompts/fragments/chat.ts` | 主对话系统提示词（`chat.system`，14 个片段） |
| `apps/server/src/prompts/fragments/neutral.ts` | 追问 / 建议 / 发言调度（中立 Agent） |
| `apps/server/src/prompts/fragments/notification.ts` | 访问问候 / 离线推送指令 |
| `apps/server/src/prompts/fragments/retry.ts` | 敏感词规避链路的注入消息文本 |
| `apps/server/src/prompts/fragments/tools.ts` | 工具描述目录（`tool/<name>`） |
| `apps/server/src/routes/prompts.ts` | 管理端目录与预览 API |
| `apps/server/src/prompts/__tests__/**` | 引擎单测 + 黄金快照（全文锁定） |

## 片段契约

```typescript
interface PromptFragment<C extends object> {
  id: string                 // 全局唯一，建议 `领域/名称`；重复注册 = 原位覆盖
  targets: '*' | PromptTarget | PromptTarget[]   // '*' = 所有配方（全局规则）
  layer: PromptLayer         // 组装位置（顺序由配方的层顺序定义）
  priority?: number          // 同层排序：数值大者靠前（默认 0）
  description: string        // 用途说明（list()/管理端展示 —— 「找得到」的入口）
  when?: (ctx: C) => boolean // 条件：false 时不产出
  render: (ctx: C) => string | null | undefined  // 产出文本；空串/null = 不产出
  source?: PromptSource      // builtin | override | `skill:<name>` | runtime | tool
}
```

**不变式**

1. `when` / `render` **不得抛错**：引擎对抛错片段做隔离（跳过 + 记日志），一条坏规则不影响其余片段。
2. 片段块首尾空白由引擎统一裁剪；块之间的连接符由配方决定（默认 `'\n\n'`）。
3. `render` 返回空产出（空串 / null / 纯空白）时，该片段在结果中完全消失（不留空行空洞）。
4. 同 id 重复注册 = 原位覆盖（保留注册序号，不改变既有排序）。
5. 引擎为**纯内存、无 IO、无网络**：便于推理与测试（技能清单等外部数据由调用方注入上下文，见下）。

## 组装流水线

```
assemble(target, ctx, opts?) →
  1. 收集：目标匹配（targets）+ 未禁用（enable/disable）
  2. 条件：when(ctx) === true
  3. 排序：层顺序（配方 layers） → 同层 priority 降序 → 注册顺序（稳定兜底）
     未在配方中声明的层，排在显式层之后，按「层首次出现的先后」兜底
  4. 渲染：render(ctx) → 归一化（裁剪首尾空白）；空产出丢弃
  5. 拼接：以配方 separator（默认 '\n\n'）连接
  6. 溯源：parts 逐段给出 id / layer / priority / description / source / content
```

临时片段（`opts.fragments`）随本次组装注入，**不进入注册表**，同样参与层/优先级排序，来源标记为 `runtime` —— 对话记录等「数据块」以此身份参与组装。

## 上下文（chat.system）

`ChatPromptContext` 是主对话配方的组装上下文（等价于旧 `BuildSystemPromptOptions` 的超集）：

| 字段 | 注入的片段 | 说明 |
|---|---|---|
| `agentSystemPrompt` | `chat/persona` | Agent 人设；空值走兜底链（`resolveAgentPersona`） |
| `language === 'ja'` | `chat/language-easter-egg` | 日语界面彩蛋（人设前） |
| `userMemories`（非空） | `chat/user-memories` | 跨会话记忆清单（人设前） |
| `thinkingMode === false` | `chat/thinking-off` | `/no_think` 指令 |
| `memoryEnabled` | `chat/memory-rules` | 跨会话记忆写侧规则 |
| `world` | `chat/world-scene` | 世界模拟块（替代群组规则） |
| `isGroup && !isQqGroup && !world` | `chat/group-rules` | 群组对话规则 |
| `isQqGroup` | `chat/qq-group-rules` | QQ 群聊规则（身份锚定） |
| `speakingRole` | `chat/speaking-role-*` | 本轮主角 / 配角 |
| `infiniteMode` | `chat/infinite-mode` | 无限演算模式说明 |
| （恒注入） | `chat/environment` | 当前时间 + 上次发言距今 |
| `skills`（非空） | `chat/skills` | 可用技能摘要（未显式注入时读技能注册表） |

`chat.system` 的层顺序（`CHAT_SYSTEM_LAYERS`）：

```
memory → persona → rules → scene → environment → capabilities
```

（此顺序复刻自迁移前的实际拼接顺序，含「用户记忆在人设之前」的既有事实；调整顺序只需改 `registry.ts` 中的一处定义。）

## 内置配方清单

| 配方 | 消费方 | 组装入口 |
|---|---|---|
| `chat.system` | 网页 / 群聊 / 世界 / 微信 / QQ 的 Agent 回复 | `buildChatSystemPrompt(ctx)` |
| `neutral.followup.system` / `.user` | 无限模式追问（中立 Agent） | `buildFollowUpSystemPrompt` / `buildFollowUpUserMessage` |
| `neutral.suggestions.system` / `.user` | 回复后 3 条追问建议 | `buildSuggestionsSystemPrompt` / `buildSuggestionsUserMessage` |
| `neutral.orchestration.system` / `.user` | 群聊发言顺序裁决 | `buildOrchestrationSystemPrompt` / `buildOrchestrationUserMessage` |
| `notification.greeting.user` | 访问问候（Web Push 生成） | `buildGreetingInstruction({ sinceLast })` |
| `notification.push.user` | 离线推送（催回消息生成） | `buildPushInstruction()` |
| `persona.fallback` | 人设兜底链末端 | `resolveAgentPersona()` |
| `retry.message` | 敏感词规避链路注入对话流 | `getFabricatedReply()` / `getRetryPlaceholder()` |
| `tool.description` | 工具描述目录（按工具名单独渲染） | `resolveToolDescription(def)` |

## 工具描述目录

工具描述是模型每轮都会读到的提示词（写入工具 schema 的 `description`）。它们以 `tool/<工具名>` 注册进目录：

- **注入路径不变**：仍是工具定义的 `description` 字段；`resolveToolDescription(def)` 解析「实际使用哪段描述」。
- **可覆盖**：`promptEngine.override('tool/read_file', { render: () => '…' })`。
- **同步策略**：`syncToolDescriptions()` 幂等注册（已存在的不重复注册，避免抹掉覆盖）；MCP 工具来自远端、随连接变化，不进入目录（回退远程描述）。

## 管理端接口

挂载于 `adminAuthMiddleware` 之下（`/api/admin/prompts`，见 `routes/prompts.ts`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/prompts` | 配方清单（层顺序/连接符/片段数）+ 片段目录（id/目标/层/优先级/来源/说明/是否带条件/是否禁用） |
| GET | `/api/admin/prompts/fragment?id=<片段 id>` | 单个片段的元信息与当前渲染文本 |
| POST | `/api/admin/prompts/preview` | `{ target, context }` → 组装结果（text + 逐段 parts + 归化后的 context） |

预览上下文按配方**白名单归化**（`normalizePreviewContext`）：未知键、类型不符的值一律丢弃。

## 扩展方式

```typescript
// 1) 注册新片段（技能/插件在加载期调用）
promptEngine.register({
  id: 'skill:my-skill/extra-rules',
  targets: 'chat.system',
  layer: 'rules',
  priority: 5,
  description: '我的技能追加的行为规则',
  when: (ctx) => ctx.isGroup === true,
  render: () => '…',
  source: 'skill:my-skill',
})

// 2) 覆盖 / 禁用 / 调位
promptEngine.override('chat/environment', { render: (ctx) => '…' })
promptEngine.disable('chat/language-easter-egg')
promptEngine.enable('chat/language-easter-egg')

// 3) 自定义配方（新的提示词消费场景）
promptEngine.defineTarget('my.custom.task', { layers: ['body'], separator: '\n' })
```

**未包含在本版**：HTTP 层的持久化改写（存 DB + 管理 UI + 版本化）。引擎 API（register / override / disable）已为扩展预留入口；持久化属后续迭代（见 `DECISIONS.md` D47）。

## 验收标准

1. `pnpm test` 全绿：引擎单测（排序/条件/覆盖/禁用/容错/临时片段/通配目标）+ 黄金快照（全部配方全文）+ 预览归化与路由。
2. **文本等价**：黄金快照由迁移前基线生成（旧实现逐字节比对通过），迁移不改变模型实际读到的内容（唯一差异为段间空行的规范化）。
3. 新增提示词不需要改动任何装配代码：在 `fragments/**` 中定义片段并注册即可。
4. 管理端可列出全部片段、查看单片段文本、预览任一份配方的完整组装结果与逐段来源。
