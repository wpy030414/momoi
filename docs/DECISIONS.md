# DECISIONS — Momoi 设计决策记录

## D1：SSE 替代 WebSocket

**日期**：架构确立时

**背景**：最初项目使用 WebSocket（@hono/node-ws）进行实时通信。

**决策**：迁移到 Server-Sent Events（SSE）。

**原因**：
- SSE 是标准 HTTP 协议，天然兼容代理、负载均衡、CDN
- 无需双向通信（聊天场景服务端单向推送即可）
- 实现更简单，无需维护连接状态
- 自动重连由客户端 fetch + retry 处理
- 源码注释中明确说明："Standard HTTP, no WebSocket needed. Works through any proxy."

**影响**：
- `@hono/node-ws` 已确认零导入并从 dependencies 中移除（D46）
- 客户端使用 `fetch` + `ReadableStream` 解析 SSE

---

## D2：SQLite 替代外部数据库（driver 已由 D61 从 sql.js 换为 node:sqlite）

**日期**：架构确立时

**背景**：需要一个数据库来存储对话历史和配置。

**决策**：使用 SQLite 单文件存储。

> ⚠ 2026-10 更新：SQLite 的**实现 driver 已由 sql.js 换成 node:sqlite**（见 D61）。
> 本决策「用 SQLite 单文件」的内核不变；下文关于 sql.js（WASM、内存态、无需原生模块）的
> 具体理由已被 D61 取代，保留仅作历史。

**原因**：
- 零配置，无需安装/维护外部数据库服务
- 单文件 `data/momoi.db`，易于备份和迁移
- 对于单用户/小团队场景完全足够
- ~~sql.js 提供纯 WASM SQLite 支持，无需编译原生模块~~（D61：改用 Node 内置 node:sqlite，同样无需编译）

**影响**：
- ~~sql.js WASM 执行在单进程中，写入操作自然串行化~~（D61：node:sqlite 同为单连接同步驱动，写入仍串行化）
- 数据文件随使用时间增长，需要定期清理

---

## D3：用户名替代认证系统（已被 D12 取代）

> ⚠️ **本决策已被 [D12](#d12pin-认证取代纯用户名登录) 取代。** 保留原文以记录当时的权衡脉络。

**日期**：架构确立时

**背景**：需要区分不同用户的对话。

**决策**：使用 localStorage 存储用户名，通过 `X-User` 请求头传递。

**原因**：
- 定位为个人/小团队自托管工具
- 不需要复杂的认证/授权系统
- 降低部署和使用门槛
- 通过 user_id 隔离对话数据

**影响**：
- 不提供密码保护，安全性依赖于网络隔离
- 不适合公开部署的场景

---

## D4：技能注入系统提示词（已演进为按需加载）

**日期**：架构确立时，2026-09 演进为按需加载

**背景**：需要为 AI 注入领域知识和行为准则。

**决策**：系统提示词中**仅注入技能摘要**（名称 + 描述），完整内容通过 `load_skill` 工具按需加载。

**原因**：
- 避免系统提示词膨胀（全文注入会占用大量 token，多个技能叠加时尤为严重）
- 按需加载更符合成本效益（AI 只在需要时才读取完整内容）
- 支持复杂技能结构（`references/*.md`、子技能 `skills/*/SKILL.md`），AI 可通过 `list_skill_files` 发现并用 `load_skill` 加载

**实现细节**：
- `buildSystemPrompt()` 中按 `## Available Skills` 格式列出每个技能的名称和描述
- 提供 `load_skill(name, path?)` 工具：加载 `SKILL.md` 或指定子文件（如 `references/guide.md`）
- 提供 `list_skill_files(name)` 工具：列出技能目录下所有可读文件
- 系统提示词末尾追加硬编码的 suggestions 格式指令（最高优先级）

**演进历史**：
- 初版（架构确立时）：全文注入 `SKILL.md` 的 Markdown 内容
- 2026-09：演进为摘要注入 + 按需加载，解决提示词膨胀问题

---

## D5：Suggestions 代码块协议

**日期**：架构确立时

**背景**：需要在 AI 回复中嵌入结构化的后续建议数据。

**决策**：使用 ` ```suggestions ` 代码块作为分隔符。

**原因**：
- 利用 Markdown 代码块语法，AI 模型容易理解和生成
- 流式输出时可以在遇到 fence 后停止转发 token
- 客户端解析简单：找到 fence 后的内容，逐行提取

**实现细节**：
- 流式输出时，遇到 `SUGGESTIONS_FENCE` 前会保留最后 `len(fence)` 个字符的缓冲区
- `parseSuggestions()` 提取 fence 和下一个 ` ``` ` 之间的内容
- 建议行去除 `- `、`* `、数字前缀，最多保留 3 条
- 系统提示词中明确要求以用户第一人称口吻生成建议

---

## D6：插件工具名前缀（已废弃）

> ⚠️ **本决策已废弃。** 插件系统已移除（commit 3530176），工具系统已重建为内置能力（详见 `docs/specs/module-tool-system.md`）。内置工具无需前缀，直接以工具名注册（如 `read_file`、`http_request`）。

**日期**：架构确立时

**背景**：多个插件可能定义同名的工具。

**决策**：工具注册时自动加上 `{插件名}_` 前缀。

**原因**：
- 避免工具名冲突
- AI 调用时能明确知道是哪个插件的工具
- `resolveTool()` 通过前缀反查所属插件

**示例**：
- 插件 `weather` 定义工具 `forecast` → 注册为 `weather_forecast`
- 插件 `search` 定义工具 `web` → 注册为 `search_web`

---

## D7：配置双层覆盖

**日期**：架构确立时

**背景**：配置既需要从环境变量读取（初始值），又需要支持运行时修改。

**决策**：环境变量作为默认值，SQLite settings 表作为运行时覆盖。

**原因**：
- 环境变量提供开箱即用的初始配置
- 管理员面板修改后立即生效，无需重启
- `getConfig()` 每次从 DB 读取（fallback 到 env 值），实现热更新

---

## D8：tsx watch 替代 nodemon

**日期**：架构确立时

**背景**：开发模式下需要服务端文件变更自动重启。

**决策**：使用 `tsx watch` 而非 nodemon + ts-node。

**原因**：
- tsx 是 esbuild 驱动的，启动和编译速度极快
- 原生支持 TypeScript ESM
- 单一工具完成 watch + 执行，减少依赖

> 相关：Windows 管道 stdio 环境下的一个限制及其规避方式见 [D15](#d15手写静态托管替代-hononode-serverserve-static)。

---

## D9：tsup 构建服务端

**日期**：架构确立时

**背景**：服务端 TypeScript 需要编译为 JavaScript 才能在生产环境运行。

**决策**：使用 tsup（esbuild）构建服务端，输出 ESM 格式。

**原因**：
- 与 tsx 共享 esbuild 生态
- 构建速度极快
- `--clean` 自动清理输出目录
- `--dts` 生成类型声明

---

## D10：流式输出中的 Suggestions 缓冲区策略

**日期**：架构确立时

**背景**：流式输出 token 时，需要在 suggestions 代码块出现时停止转发，但不能丢失已发送的内容。

**决策**：维护一个长度为 `SUGGESTIONS_FENCE.length` 的安全缓冲区。

**原因**：
- suggestions fence 可能跨越多个 token chunk 到达
- 如果直接转发每个 token，fence 的前几个字符可能已经发送给客户端
- 缓冲区确保 fence 完整出现前不会发送可能被 fence 截断的内容
- 一旦检测到 fence，后续 token 不再发送（但仍累积到 fullText 供解析）

**影响**：
- 用户端最后几个字符会有轻微延迟（可忽略）
- 代码中有详细注释说明此策略

---

## D11：Vite 8（Rolldown）与构建产物目录分离

**日期**：2026-08-31

**背景**：升级到 Vite 8 后，其默认打包器由 Rollup + esbuild 换成 Rolldown + Oxc，CSS 压缩改用 Lightning CSS。同时排查发现 `pnpm build` 产出的 `dist/client` 为空。

**决策**：
1. 升级 `vite` → `^8.2.2`、`@vitejs/plugin-react` → `^6.1.1`（v6 改用 Oxc 做 React Refresh，不再依赖 Babel）。
2. `build` 脚本顺序由 `build:client && build:server` 改为 `build:server && build:client`。

**原因**：
- `build:server` 的 `tsup --clean --outDir dist` 会清空整个 `dist`，客户端先构建就会被一并铲掉；把服务端放到前面、客户端最后写入，即可在同一 `dist` 下共存，无需改动 `dist/index.js`、`dist/client` 等既有路径约定与文档。
- 该缺陷早于本次升级存在于 `build` 脚本中，并非 Vite 8 引入。
- 项目未使用 `rollupOptions` / `esbuild` / `manualChunks` / `import.meta` 等受破坏性变更影响的配置，故无需引入 `rolldownOptions` 改写；仅将 `vite.config.ts` 中的 `__dirname` 改为 `import.meta.dirname`，以消除面向 `configLoader: 'native'` 的弃用告警。

**影响**：
- 客户端构建耗时由约 11.9s 降至约 1.05s（含进程启动的完整命令由 11.9s 降至 2.1s）。
- 生产模式静态托管（`/`、`*.css`、`*.js`）与开发模式 HMR、React Refresh 边界注入均已实测通过；`tsc --noEmit` 无错误。
- 客户端 chunk 体积告警仍存在（mermaid/cytoscape 等），属既有问题，未在本次改动范围内。

---

## D12：PIN 认证取代纯用户名登录

**日期**：2026-08-31（文档同步时确认已在代码中实现）

**背景**：D3 的纯用户名方案无任何验证，任何人改一下 `X-User` 头即可冒充他人、读取其对话。随着功能增长（附件上传、消息回退、导出）这一风险被放大。

**决策**：引入轻量级用户认证 —— 用户名 + 4 位数字 PIN，PBKDF2 哈希存储，登录换取 JWT（现为 14 天，见 D32）。

**原因**：
- 在「零部署门槛」与「最低身份保护」之间取平衡：4 位 PIN 对个人/小团队自托管场景足够，又不引入邮箱/密码等重资产
- PBKDF2（SHA-512、10000 次迭代、随机 16 字节盐）+ `timingSafeEqual`，成本极低但挡住字典与时序侧信道
- JWT 14 天有效期（D32 从 30 天缩短），兼顾安全与「免反复登录」体验
- 复用管理员的签名密钥（`ADMIN_KEY`），通过 `role` 字段区分，无需额外密钥管理

**备选与权衡**：
- ❌ 完整密码系统：与「轻量自托管」定位冲突
- ❌ 保留纯用户名：无法防冒充，附件/回退等新能力使其风险不可接受
- ⚠️ 已知残留：`auth.ts` 中仍导出一版允许 `X-User` 回退的 `userAuthMiddleware`，但当前无路由引用它（实际生效的是 `middleware/userAuth.ts` 的严格版）。属可清理的死代码，实现细节见 `specs/module-auth.md`。

**影响**：
- AGENTS.md 的 Non-Goals 已相应移除「多用户认证/登录系统」条目
- `settings` 表新增 `pin:{username}` 键值行
- 登录流程从 1 步变 2 步（用户名 → PIN），新增 `LoginScreen` 三步 UI 与 `ChangePinDialog`

---

## D13：文件附件按类型降级为多模态或内联文本

**日期**：2026-08-31

**背景**：需要让 AI 消费用户上传的图片、Excel、PDF、文本等文件。

**决策**：附件先落盘 `data/workspaces/{convId}/__uploads__/`（UUID 重命名），再由 `files/parser.ts` 按类型转换 —— 图片转 base64 走 `image_url` 多模态通道，Excel/PDF/文本转纯文本内联进消息正文（`--- 附件: 名称 ---` 分隔），二进制仅存元信息摘要。整个能力由管理员开关 `support_attachments`，默认关闭。

**原因**：
- 只有图片真正需要多模态；表格/PDF/文本转成文本即可被任意 OpenAI 兼容模型消费，最大化兼容性
- 内联文本而非结构化字段，使不支持 vision 的模型也能处理大部分附件
- UUID 命名 + `path.basename()` 防路径穿越与文件名冲突；下载端点因此可 `immutable` 永久缓存
- 解析失败回填错误文本而非抛异常，保证对话不中断

**备选与权衡**：
- ❌ 全部走多模态：非 vision 模型直接报错
- ❌ 附件存 DB BLOB：撑大单文件库，且无法用简单 URL 直链
- ❌ 下载端点加认证：URL 需能塞进 `<img src>`，加认证会使图片显示不了。**实际实现与此描述相反**——下载端点最终处于用户 JWT 保护之下，前端全部走带 JWT 的 fetch + Blob，没有 `<img src>` 直链需求。UUID 能力链接模型的隐私边界随之消失（无 token 无法下载）

**影响**：
- `messages` 表新增 `attachments` 列（JSON 数组）
- 新增 `data/workspaces/{convId}/__uploads__/` 目录与 `/api/workspace/{convId}/file/__uploads__/` 下载路由
- 上传/下载端点均在用户 JWT 保护之下；URL 因此不能直接嵌入 `<img src>`，前端一律经带 JWT 的 fetch → Blob → ObjectURL（见 `specs/module-file-attachment.md`）
- **曾存在阻断性缺陷**（上传/下载 fetch 未带 JWT 导致 401、失败无提示），已修复并实测验证，过程记录见 `specs/module-file-attachment.md` 的「已修复」章节

---

## D14：思考模式（Reasoning）作为每消息开关

**日期**：2026-08-31

**背景**：Qwen3、DeepSeek 等模型支持扩展推理，但推理会增加延迟与 token 成本，且并非所有场景都需要。

**决策**：在输入框提供思考模式开关，逐消息传递 `thinking_mode`；服务端在 API 层透传 DashScope 兼容参数 `enable_thinking`，关闭时额外置 `thinking_budget: 0`，并在系统提示词追加 `/no_think` 指令。

**原因**：
- 双保险：既在 API 参数层关闭（`enable_thinking=false` + `thinking_budget=0`），又在 prompt 层提示（`/no_think` + 中文强化），兼容「支持该参数」与「仅靠 prompt 控制」两类模型
- 默认开启（`thinking_mode !== false`，省略即为真），让支持推理的模型开箱即用
- 思考内容单独以 `thinking` 事件流式下发，客户端折叠展示，不混入正文

**影响**：
- `messages` 表 `thinking` 列持久化推理过程
- 关闭思考时 provider 不 yield `thinking` 事件
- 该参数为 DashScope 约定，对严格 OpenAI 规范的端点可能被忽略（无副作用，模型自行决定）

---

## D15：手写静态托管替代 @hono/node-server/serve-static

**日期**：2026-09-03

**背景**：`pnpm dev`（concurrently 并行启动前后端）时后端静默挂死——零输出、端口不监听，而单独 `pnpm dev:server` 完全正常。隔离实验（平凡入口 + 逐模块二分）定位为：Windows 上当 stdout 是管道（concurrently 的标准接法）时，入口模块图引用 `@hono/node-server/serve-static` 会使 `tsx watch` 在执行任何代码前挂死。上游 [privatenumber/tsx#623](https://github.com/privatenumber/tsx/issues/623) 记录了同类现象（chalk、prom-client 等「可疑模块」触发），至今未修复。

**决策**：新增 `src/server/static.ts` 手写极简静态中间件（`/assets/*` 文件 + SPA fallback + 路径穿越守卫），依赖图彻底移除 `@hono/node-server/serve-static`。

**备选与权衡**：
- ❌ 升级 `@hono/node-server` 1.19.17 → 2.1.1：实测 2.1.1 的 serve-static 照样触发挂死
- ❌ 改为动态 `import()`：tsx watch 启动时即解析整个模块图，动态导入同样挂死
- ❌ 换 `node --watch --import tsx`：管道下能启动，但 Windows 重启存在 EADDRINUSE 竞态（旧进程端口未释放 → 新进程绑定失败 → 服务停摆，需再改一次文件才能恢复）
- ❌ 换 nodemon + tsx（no watch）：可行，但为规避单个子模块引入整个新工具链，且偏离 D8 已选定的 tsx watch 路线

**影响**：
- dev 行为不变：`dist/client` 不存在时中间件完全不注册
- 生产行为对齐原 serveStatic 语义（含未命中路径回落 `index.html`——未知 `/api/*` 路径也会返回 SPA，与原 `app.get('*', serveStatic({ path: 'index.html' }))` 行为一致）
- 附带修复：vite 代理端口改为跟随 `.env` 的 `PORT`（原先写死 3001，`.env` 配置其他端口时前端请求全部 502）

---

## D16：bash 工具——受限沙盒执行

**日期**：2026-09-03

**背景**：宜搭等技能需要执行 CLI 命令（如 openyida），纯文件操作工具不足以支持。

**决策**：新增 `bash` 工具，在沙盒工作区 cwd 下执行 shell 命令，带超时、输出截断、破坏性命令黑名单。

**原因**：
- cwd 锁定在沙盒内，防止访问宿主文件系统
- 黑名单（rm -rf /、format c:、shutdown 等）+ 超时 + 输出截断三重防护
- Windows 用 cmd.exe，其余用 /bin/sh，自动切 UTF-8 代码页

**影响**：新增 `src/server/tools/bash-tool.ts`；`registry.ts` 新增 bashTool 引用

---

## D17：Pi 式并行批执行——工具调用并发执行（已被 D21 取代）

> ⚠️ **本决策已被 [D21](#d21pi-agent-core-迁移) 取代。** Pi 的 `runAgentLoop()` 原生支持 `toolExecution: 'parallel'`，无需自研并发执行逻辑。保留原文以记录自己实现时的权衡脉络。

**日期**：2026-09-04

**背景**：传统 AI Agent 每轮工具调用串行执行，模型需要 N 轮才能完成 N 个工具，延迟高。

**决策**：采用 Pi 式设计——同一轮内所有工具通过 Promise.all 并发执行，但结果按模型发起顺序回填，上下文不乱序。

**原因**：
- 并发执行：无依赖的工具并行跑，减少总轮次
- 顺序回填：`tool_call_id` 保证上下文不乱序，即使并行执行也按顺序回填
- 批量终止：`ToolResult.terminate` 信号——本批所有工具都要求终止时提前收口

**影响**：新增 `ToolResult.terminate` 字段；`loop.ts` 中 `Promise.all` + 顺序回填 + 批量终止判断

---

## D18：write_file 防循环从硬拒绝改为软提醒（已被 D21 取代）

> ⚠️ **本决策已被 [D21](#d21pi-agent-core-迁移) 取代。** write_file 节制现在通过系统提示词中的硬性规则约束，不再需要在代码中维护写文件计数器。

**日期**：2026-09-04

**背景**：原设计（D5/T05）write_file 第 2 次硬拒绝、第 3 次强制退出，但真实场景中用户确实需要写多个文件。

**决策**：改为软提醒——第 2 次调用返回温和提示（"已经是第 2 次调用，写完请回复用户"），但正常执行，不强制拒绝。

**原因**：硬拒绝阻塞了合理的多文件写入场景（如生成报告含多个图表）；软提醒既防止无限循环，又允许合法多文件写入。

**影响**：`loop.ts` 中 `writeFileCount` 从硬拒绝改为提示 + 正常执行

---

## D19：嵌套技能递归扫描

**日期**：2026-09-03

**背景**：聚合技能包（如 yida-skills）包含嵌套子技能（yida-login、yida-app 等），需要递归发现。

**决策**：递归扫描整个 `skills/` 目录树，任何含 `SKILL.md` 的目录都注册为技能。

**原因**：支持技能包嵌套结构，无需用户手动注册每个子技能；父技能和子技能各自独立注册。

**影响**：`loader.ts` 从扁平扫描改为递归 `walk()`；新增 `list_skill_files` 工具让 AI 探索技能目录

---

## D20：漂移检测——连续重复工具批次终止（已被 D21 取代）

> ⚠️ **本决策已被 [D21](#d21pi-agent-core-迁移) 取代。** 漂移检测现在通过系统提示词中的「防漂移·硬性规则」约束，不再需要代码中维护 `lastToolBatchSig` 变量。

**日期**：2026-09-04

**背景**：模型可能陷入死循环，反复调用同一个工具（如反复 load_skill 同一个技能）。

**决策**：在 loop.ts 中检测连续重复的工具批次签名，发现后强制终止并注入 BLOCKED 消息。

**原因**：系统提示词约束不够强，需要硬性检测；签名基于 (name + arguments) 的联合字符串，避免误判参数不同的合法重复调用。

**影响**：新增 `lastToolBatchSig` 变量；`batchSig === lastToolBatchSig` 时 break 收口

---

## D21：Pi Agent Core 迁移——用成熟内核替换自研 Agent 循环

**日期**：2026-09-07

**背景**：项目自研 496 行 Agent 循环 (`src/server/ai/loop.ts`) 包含大量代码补丁：漂移检测 (`lastToolBatchSig`)、write_file 计数 (`writeFileCount`)、批量终止 (`terminate` 信号)、`finishReason='length'` 保护、收尾轮追加 (`runFinalAnswerRound`)、空回复兜底 (`lastFullText`)。这些补丁存在恰说明系统提示词不够强——一个真正好的 Agent 循环应让模型通过提示词自控，而非靠代码硬控。

**决策**：用 `@earendil-works/pi-agent-core` 的 `runAgentLoop()` 生成器替换自研循环，将代码补丁翻译为系统提示词硬性规则。

**原因**：
- `runAgentLoop()` 工业级成熟度：多轮工具调用、并行执行、事件流、compaction 全部内置，无需自研
- 代码量从 496 行自研循环 → 741 行适配层（含强提示词、工具适配、事件映射、消息转换），后者是声明式胶水代码而非控制流逻辑
- 代码补丁逻辑转为提示词规则后，模型行为由「程序硬控」变为「AI 自觉遵守」，更符合 Agent 设计哲学
- 移除自研循环消除了 5 个代码补丁类别的维护负担（漂移、写文件计数、终止、length 保护、兜底）
- 工具参数校验从自研 JSON Schema 升级为 TypeBox 严格类型校验

**技术细节**：
- `pi-adapter.ts`（741 行）为适配层，包含：
  - `buildSystemPrompt()`：系统提示词，新增防漂移、写文件节制、工具节制三条硬性规则
  - `createToolAdapter()`：将 10 个 ToolModule 包装为 Pi AgentTool（TypeBox 参数 schema）
  - `createStreamFn()`：包装 `provider.ts` 为 Pi 兼容 `StreamFn`
  - `createEventEmitter()`：Pi `AgentEvent` → SSE `ServerMessage` 映射（含 suggestions fence 缓冲、思考片段注入）
  - `chatHistoryToAgentMessages()`：`ChatMessage[]` → Pi `AgentMessage[]` 转换
  - `runPiAgentLoop()`：入口函数，编排以上所有组件
- `chat.ts` 仅替换一行 import 和调用（`runChatLoop` → `runPiAgentLoop`），其余逻辑不变
- Pi 的 `AgentLoopConfig` 无 `maxToolRounds` 字段——模型自行决定何时停止，系统提示词中的「工具节制」规则替代了硬性轮次上限

**取代的决策**：D17（Pi 式并行）、D18（write_file 软提醒）、D20（漂移检测）

**备选与权衡**：
- ❌ 继续修补自研循环：代码补丁会越积越多，与「用提示词引导行为」的设计哲学背道而驰
- ❌ 使用 `pi-coding-agent`（TUI/CLI 完整框架）：引入 ModelRuntime、ResourceLoader、CLI 等不需要的依赖，过度耦合
- ⚠️ 移除 `maxToolRounds` 硬性安全网：模型可能无限循环——但系统提示词中的「工具节制」规则 + Pi 自身的 compaction 机制提供了替代保护

**影响**：
- 删除 `src/server/ai/loop.ts`（496 行）
- 新增 `src/server/ai/pi-adapter.ts`（741 行）
- 新增依赖：`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@sinclair/typebox`
- `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 更新
- 冒烟测试通过：流式对话、思考模式分段、工具调用、多轮工具、suggestions 解析全部正常

---

## D22：群聊上下文传递规范——他人发言以 user 角色 + 名字前缀注入

**日期**：2026-09-07

**背景**：群聊模式下用户发一条消息、多个 Agent 相继回复时，后回复的 Agent 经常复述/照抄前一个 Agent 的内容，出现「两个 Agent 回复一模一样」的现象。E2E 抓流对比确认：香子兰的回复开头与巧克力的回复逐字相同（先完整复述，末尾才加上自己的话）。

**根因**：`group-orchestrator` 把前一个 Agent 的回复以 `role: 'assistant'` 注入后续 Agent 的上下文 —— 模型会把 assistant 角色的消息视为「自己之前说过的话」，于是把自己的回答写成对那段话的复述/延续。

**决策**：
1. 群聊上下文中，其他 Agent 的发言一律以 `role: 'user'` + `[Agent名字]: 内容` 前缀注入（`prepareGroupHistory` + 累计历史 push），模型据此区分「他人发言」「用户提问」与「自己该说的」。
2. 系统提示词（`buildSystemPrompt` 的群组规则）明确说明 `[名字]: ` 开头的消息是他人/自己的历史发言，禁止复述、引用或延续，要求给出自己视角的独立回答。
3. 连带修复：历史加载（`chat.ts`）保留 `agent_id` 字段，第二轮及以后仍能还原发言者身份；无限模式的中立 Agent 追问上下文同样显示 Agent 名字而非 UUID。

**影响**：
- `provider.ts`：`ChatMessage` 增加可选 `agent_id` 字段
- `group-orchestrator.ts`：新增 `prepareGroupHistory`；累计历史改用 user 角色
- `chat.ts`：history 与 reloadHistory 保留 agent_id；中立追问上下文显示名字
- `pi-adapter.ts`：群组规则提示词重写

---

## D23：SSE 写入串行化——防止流关闭时尾部事件丢失

**日期**：2026-09-07

**背景**：E2E 测试发现群聊 SSE 流总是缺少最后一个 Agent 的 `agent_done` 与 `group_done` 事件（服务端日志显示 `send` 已调用成功，客户端却收不到），导致客户端一直处于 loading 状态。

**根因**：Hono 的 `SSEStreamingApi.writeSSE` 是异步的，而 `chat.ts` 的 `send` 同步调用且不等待其完成；`streamSSE` 回调一结束，`finally` 中立即 `stream.close()`，**尚未 flush 的尾部事件被直接丢弃**（`agent_done`、`group_done` 是连续同步入队的最后几个事件，最容易丢失）。

**决策**：`send` 内部维护串行写入链（`writeChain`），每条消息排队等待前一条真正写入完成后才写入；`streamSSE` 回调在 `finally` 中 `await writeChain`，保证所有事件 flush 后才关闭连接。

**影响**：
- `chat.ts`：`send` 重写为串行 promise 链；回调末尾 `await writeChain`
- 消除了 SSE 事件乱序与尾部丢失的一类竞态（此前 `writeSSE` 并发 fire-and-forget 也可能乱序）

---

## D24：Agent 多智能体系统 — 独立 Agent 替代全局配置

**日期**：2026-09-07

**背景**：原先 `model` 和 `system_prompt` 是全局配置，所有对话共享同一个模型和提示词。随着群聊功能需求出现，需要支持多个不同角色、不同模型的 Agent 同时存在。

**决策**：引入 Agent 概念——每个 Agent 独立拥有 name/model/system_prompt/avatar/role，存储于 `agents` 表。全局配置 `model` 和 `system_prompt` 字段移除。

**原因**：
- 群聊需要多个不同人格的 Agent 同时参与，全局配置无法满足
- 用户可能希望不同对话使用不同模型（如日常对话用便宜模型、代码生成用强模型）
- Agent 级别的配置更灵活，对齐 chat.com 等主流产品的多 Agent 设计

**实现细节**：
- `agents` 表：`id`、`name`、`model`、`system_prompt`、`avatar`、`role`（`'default'` | `'neutral'`）、`created_at`
- `config.ts` 新增 Agent CRUD：`listAgents()`、`getAgent(id)`、`createAgent()`、`updateAgent()`、`deleteAgent()`
- `migrateDefaultAgent()`：首次启动时从旧 settings 表读取 `model`/`system_prompt`，创建默认 Agent（Momoi）和中立 Agent
- 中立 Agent 固定 ID 为 `neutral-agent`，不可删除、不可改名/换头像，仅可修改 model 和 system_prompt
- `conversations` 表新增 `agent_id` 列，`messages` 表新增 `agent_id` 列
- 管理面板新增 `AgentManager` 标签页（增删改 Agent），`GatewaySettings` 标签页（全局 API 地址/密钥）

**影响**：
- `AppConfig` 移除 `model` 和 `system_prompt` 字段
- `pi-adapter.ts` 的 `buildSystemPrompt()` 从 `getAgent()` 读取提示词而非 `getConfig()`
- 旧数据兼容：`migrateDefaultAgent()` 自动迁移

---

## D25：群聊串行编排 — 多 Agent 依次回复

**日期**：2026-09-07

**背景**：需要支持多个 Agent 在同一对话中交流，用户发一条消息，多个 Agent 各自回复。

**决策**：Agent 串行依次回复（非并行），前序 Agent 的回复以 `role: 'user'` + `[Agent名字]: 内容` 前缀注入后续 Agent 的上下文。

**原因**：
- 串行编排简单可控，无需处理并发竞态
- 以 user 角色注入前序回复（而非 assistant），防止模型把自己当作前一个 Agent 的延续（D22 已验证）
- 随机打乱 Agent 顺序增加对话趣味性
- 每条消息 tagging `agent_id` 支持历史回溯

**实现细节**：
- `group-orchestrator.ts`：`orchestrateGroupChat()` 入口函数
- `prepareGroupHistory()`：将历史中其他 Agent 的 assistant 消息重写为 `[名字]: 内容` 的 user 角色消息
- 每个 Agent 独立调用 `runPiAgentLoop()`，SSE 事件带 `agent_id`/`agent_name`
- `group_conversation_agents` 表存储群聊内的 Agent 关联
- `conversations.type` 区分 `'direct'`（单 Agent）和 `'group'`（群聊）

**影响**：
- 新增 `routes/group.ts`、`ai/group-orchestrator.ts`、`hooks/useGroupChat.ts`
- SSE 新增 `agent_start`、`agent_done`、`group_start`、`group_done` 事件
- 前端 `MessageBubble` 显示 Agent 头像和名字（群聊模式）

---

## D26：无限演算模式 — 中立 Agent 自动追问

**日期**：2026-09-07

**背景**：Agent 回复完毕后对话即结束，缺乏持续互动。用户希望对话能自动延续——无论个体聊天还是群聊。

**决策**：引入"无限演算模式"——个体聊天或群聊中均可开启，中立 Agent 在每轮对话结束时自动生成追问，以用户口吻触发下一轮对话。

**原因**：
- 创造"Agent 自主对话"的沉浸式体验
- 中立 Agent 固定角色：不参与群聊回复，只负责生成追问
- 追问以用户口吻（问题、反问、动作描述）生成，自然融入对话流
- 可随时开关，避免无限消耗 token

**实现细节**：
- `neutral-agent.ts`：`generateNeutralFollowUp()` 调用中立 Agent 模型生成追问
- 追问以 `follow_up` SSE 事件下发，内容为纯文本
- 开关状态以 `infiniteState` Map 管理（内存中，按 conversationId 索引）
- `POST /api/chat/infinite-mode` 端点切换开关
- 关闭时发送 `infinite_mode_off` 事件

**影响**：
- 新增 `ai/neutral-agent.ts`、`NEUTRAL_AGENT_NAME`/`NEUTRAL_AGENT_ID` 常量
- 前端 `InputBar` 新增无限模式开关按钮
- SSE 新增 `follow_up`、`infinite_mode_off` 事件

---

## D27：钉钉 Token 工具 — 移除，迁移至 MCP 服务

**日期**：2026-09-09

**背景**：钉钉 Token 管理原为内置工具，但此类外部服务集成的职责更适合作为 MCP 服务提供。

**决策**：移除 `dingtalk_token` 内置工具，后续通过 MCP 客户端连接外部钉钉 MCP 服务来获取 token。

**影响**：删除 `tools/dingtalk-token.ts`；`registry.ts` 移除引用；环境变量 `DINGTALK_APP_KEY`/`DINGTALK_APP_SECRET` 移除。

---

## D28：IP 速率限制 — 内存级 PIN 暴力破解防护

**日期**：2026-09-08

**背景**：4 位 PIN 只有 10000 种组合，无任何防护时攻击者可通过暴力枚举破解。需要轻量级速率限制，不引入 Redis 等外部依赖。

**决策**：内存级 IP 速率限制器——同一 IP 连续 5 次 PIN 错误即封禁 5 分钟。状态仅存于内存，重启即清除。

**原因**：
- 4 位 PIN 熵值低，必须有限速防护
- 内存级方案零外部依赖，对齐"轻量自托管"定位
- 5 次/5 分钟参数对正常用户误触容忍度高，对暴力破解有效阻断
- 定时清理过期条目，防止长时间运行内存泄漏

**实现细节**：
- `src/server/rateLimiter.ts`：`checkIpBlocked()`、`recordPinFailure()`、`clearPinFailures()`、`getClientIp()`
- 封禁期内的失败不再累加，防止攻击者探测封禁阈值
- 验证成功后调用 `clearPinFailures()` 清除记录
- `x-forwarded-for` 头优先，兜底 `socket.remoteAddress`
- 每分钟定时清理已过期封禁条目

**影响**：新增 `src/server/rateLimiter.ts`；`routes/user.ts` 集成限速检查

---

## D29：@mention 工具 — Agent 间点名调用

**日期**：2026-09-08

**背景**：群聊中 Agent 按随机顺序依次回复，但某些场景需要特定 Agent 优先应答（如被点名回答问题）。

**决策**：新增 `at_mention` 内置工具，Agent 可调用它点名其他 Agent，被点名者立即应答，本轮其他 Agent 被跳过。

**原因**：
- 模拟真实群聊中的 @ 点名行为
- 被点名 Agent 应优先于随机顺序，让对话更自然
- 工具参数仅需 agent_name 和 message，简单直接

**实现细节**：
- `tools/group-mention-tool.ts`：`createMentionTool(mentionSignal)` 工厂函数
- 返回 `MentionSignal { triggered, agentNames: string[], message }` 信号
- `group-orchestrator.ts` 检测 `mentionSignal.triggered`，插入被点名 Agent 到队列头部（其余 Agent 照常发言）
- 最多 5 次 @mention 重定向（`MAX_MENTION_REDIRECTS`），防止死循环

**影响**：新增 `tools/group-mention-tool.ts`；`registry.ts` 动态创建（`createMentionTool` 非静态模块）

## D30：群聊发言调度 — 中立 Agent 裁决每轮参与成员

**日期**：2026-09-09

**背景**：群聊每轮把全部成员串行跑一遍。即使某成员上一轮已明确表示「已经睡下 / 退下了 / 这个不懂」，下一轮仍被拉出来发言，破坏群聊真实感。

**决策**：每轮开始前由中立 Agent 做一次轻量裁决，输出「本轮不需要参与的成员」；用户点名 / 提及者强制参与；被跳过者仍可被其他 Agent 的 @mention 唤醒。

**原因**：
- 中立 Agent 已有基础设施（固定 ID、管理端可配 model/system_prompt）与 LLM 调用范式（追问、建议），复用它做编排成本最低
- 采用「每轮重判 + 上一轮缺席名单提示」：既让「睡着了 / 退下了」自然延续，也让「不懂」这类话题性判断在换话题后自动回归，无需持久化状态
- 完全静默（仅服务端日志）：不引入 SSE 事件与客户端改动，协议面最小
- 失败开放：裁决失败 / 超时 / 全跳过一律退回全员参与，绝不让编排错误导致无人回复

**实现细节**：
- `ai/neutral-agent.ts`：`decideGroupParticipants()`（`ORCHESTRATION_SYSTEM_PROMPT` 含 `[group-orchestration]` 标记；额外指示排在输出格式之前；行级容错解析，保留名字中的裸数字）
- `ai/group-orchestrator.ts`：决策相位位于 shuffle 之前，10s 超时、整体 try/catch；生效跳过集 = 名字解析 ∩ 名册 − 用户点名者；全跳过整体作废；缺席记忆 `Map<conversationId, { at, skips }>`（TTL 10min、上限 200 会话，重启失效）
- 上下文截断：最近 20 条、行 400 字 / 用户消息 1500 字 / 总量 6000 字，跳过 tool/system 行
- 门控：成员数 > 1、history 非空、非全员被点名（首轮不裁决，省一次调用）

**被否方案**：
- 粘滞跳过（判定退场后持续沉默，直到被点名）：「不懂」这类话题性判断会被过度沉默
- 客户端可见事件（`agents_skipped`）：需新增 SSE 事件 + 前端渲染（现有收尾 refetch 会抹掉客户端临时行），与「静默」取向不符
- JSON 输出格式：行格式 + 容错解析 + 名册交集已足够安全

**影响**：新增 `decideGroupParticipants()`；`group-orchestrator.ts` 决策相位与内存缺席记忆；每轮群聊 +1 次轻量 LLM 调用（位于首个 `agent_start` 前，约 1-3s 首字延迟）

## D31：管理员改为 ADMIN 用户名名单 — 废除 ADMIN_KEY 与管理员 JWT

**日期**：2026-09-09

**背景**：原设计以 `ADMIN_KEY` 密钥登录管理面板（`POST /api/admin/auth` 换 24h 管理员 JWT），该密钥同时兼作两套 JWT 的签名密钥。实际使用中管理员与普通用户本就是同一批登录用户，密钥成为纯多余的一层。

**决策**：`ADMIN_KEY` 取缔，改为 `ADMIN` 环境变量（逗号分隔用户名名单，如 `ADMIN=xrl,咕咕,k3p0`）。管理员端点复用用户 JWT，由 `adminAuthMiddleware` 逐请求校验 `isAdmin(username)`；废除管理员 JWT 与 `/api/admin/auth`。JWT 签名密钥改由 `JWT_SECRET`（可选）或首启随机生成并持久化到 `settings` 表提供。客户端经 `GET /api/user/me` 获知自身管理员身份：入口按身份显隐，`#/settings` 路由守卫遣返非管理员。

**原因**：
- 「管理员 = 一组用户名」语义直接对齐使用场景：无需额外凭证，登录即知是否管理员
- 逐请求名单校验使撤销即时生效（停机改 `.env` 重启即收权），不留 24h 残留 token
- 用户名非机密信息，不可再充当签名密钥——签名密钥独立来源（`JWT_SECRET` / DB 持久化随机值），用户 token 30 天有效期在重启后依然有效
- `ADMIN` 留空/缺省 = 无管理员，应用照常运行（无后台入口而已），零配置可跑

**备选与权衡**：
- ❌ 保留双 token（`/me` 换发管理员 JWT）：多一次往返、撤销有残留窗口，且密钥登录已无存在理由
- ❌ 用 `ADMIN` 名单派生签名密钥：用户名是公开信息，等于无密钥，任何人可伪造 token
- ⚠️ `JWT_SECRET` 未配置时首启生成并落库：换库/删库会使全部 token 失效（用户需重新登录），属可接受代价；显式配置 `JWT_SECRET` 可避免

**影响**：
- 删除 `signAdminToken` / `verifyAdminKey`、`POST /api/admin/auth`、`useAdmin` hook 与后台密钥输入 UI
- `env` 新增 `ADMIN`（名单）与 `JWT_SECRET`；`settings` 表新增 `jwt_secret` 键
- 新增 `GET /api/user/me`；bash 工具子进程环境剔除名单由 `ADMIN_KEY` 改为 `ADMIN`（防泄露管理员身份）
- 文档同步：`module-auth.md`、`module-admin.md`、`module-config.md`、`ARCHITECTURE.md`、`AGENTS.md`、`PRD.md`、README、`.env.example`；D12 中「复用管理员签名密钥」的表述自此作废

## D32：用户 JWT 改为 14 天 + 半衰自动续期

**日期**：2026-09-09

**背景**：原 30 天 token 有效期过长——泄露的 token 在一个月内都无法自然失效，与 PIN 这类轻量认证的风险面不匹配。但直接大幅缩短又会让活跃用户频繁重新输 PIN。

**决策**：`signUserToken` 有效期 30 天 → 14 天；新增 `POST /api/user/refresh`（需用户 JWT）换发新 14 天 token。客户端（`App.tsx`）在 token **剩余寿命不足一半**（< 7 天）时自动刷新：登录/挂载时调度定时器、`visibilitychange`/`focus` 唤醒时复查（应对休眠唤醒）、失败 5 分钟后重试（401 则走既有 `auth:expired` 登出链路）。

**原因**：
- 滑动会话语义：活跃用户（应用保持打开，或每次回访间隔 < 7 天）永不再登录；连续 14 天未使用才会话过期重输 PIN——把「免登录时长」与「实际活跃度」绑定，而非签发时刻
- 「半衰续期」是滑动会话的经典取法：续期点与过期线之间天然隔着半个 TTL 的容错（此处 7 天），对休眠唤醒、网络抖动、后台标签页定时器节流都有巨大余量；且单用户续期频率上限约每 7 天一次，签名开销可忽略
- 14 天对 30 天：暴露窗口直接砍半，同时保留「两周一用」的低频用户免登录体验
- 续期复用 `signUserToken`，服务端零新增状态：无刷新令牌、无会话表，仍是纯无状态 JWT

**备选与权衡**：
- ❌ 双 token（短 access + 长 refresh）：引入第二凭证与会话存储，与「零状态」架构相悖，超出需求
- ❌ 响应头透明续期（每个中间件检查并回传新 token）：侵入所有路由与 SSE 流，复杂度高且收益与定时刷新相同
- ❌ 24 小时短有效期：风险面更小，但迫使隔天使用的用户频繁输 PIN，与「轻量自托管」的体验取向不符
- ⚠️ 多标签页各自刷新：无服务端会话，两个 token 均有效，localStorage 末次写入胜出——无锁死风险，可接受
- ⚠️ 无单用户吊销能力不变：要强制某人/全员下线仍需轮换 `JWT_SECRET`（见 D31）

**影响**：
- `expires_at` 随 token 一并持久化到 localStorage（`token_expires_at`），登出/401 统一经 `clearSession()` 清理
- `LoginScreen.onLogin` 增加第三参 `expiresAt`；`setToken(token, expiresAt?)` 扩展签名
- 文档同步：`module-auth.md`（JWT 表 + `/refresh` 契约 + 行为约束 9）、`module-admin.md`、`AGENTS.md`、`ARCHITECTURE.md`、`PRD.md`、README；D12 的「JWT 30 天有效期」表述自此作废

## D33：JWT 迁移至 HttpOnly Cookie 传输，唯一凭证载体

**日期**：2026-09-09

**背景**：安全为本项目的高优先级诉求。此前 JWT 存于 localStorage 并以 `Authorization: Bearer` 传输——任何 XSS 都能读取并外传 token，实现会话劫持与持久化植入。

**决策**：JWT 改经 **HttpOnly Cookie `momoi_token`** 下发与携带：`HttpOnly; SameSite=Lax; Path=/; Max-Age=14d`，HTTPS 部署（含 `x-forwarded-proto` 判定）自动加 `Secure`。`/verify`、`/set-pin`、`/refresh` 响应体不再含 token，仅返回 `expires_at`；localStorage 只留用户名与过期时间戳（均非机密）。`Authorization: Bearer` 头**被完全移除**（`getAuthToken()` 只读 Cookie）——安全无小事，不留后门。新增 `POST /api/user/logout` 服务端清除 Cookie（JS 无法删除 HttpOnly Cookie）。

**原因**：
- HttpOnly 使 token 对 JS 完全不可见：XSS 最坏只能以受害者身份当次会话内发起请求，无法窃取凭证外传或长期冒充——把「一次 XSS = 永久失守」降级为「一次 XSS = 会话内受限」
- SameSite=Lax 阻断跨站 POST 携带 Cookie，配合全 JSON `Content-Type` 的写接口构成 CSRF 防线，无需引入 CSRF token 基建
- Bearer 回退虽然方便 curl/脚本运维，但留了一个不经过 Cookie 属性保护（HttpOnly/SameSite/Secure）的凭证入口——攻击者若能通过任意方式获取 JWT 明文（如日志泄漏），就能绕过 Cookie 的全部安全边界直接用 Bearer 头冒充。安全的原则是「只有一个门，守好它」
- 生产部署（Hono 托管前端）与开发（Vite `/api` 代理）均为同源，Cookie 自动携带，客户端代码反而简化（删除全部手动 Authorization 附加逻辑）

**备选与权衡**：
- ❌ 继续 localStorage + Bearer：XSS 可窃取 token，与安全诉求冲突
- ❌ 双通道（Cookie + Bearer 并存）：多一条路径多一个攻击面；日志/代理误泄 token 后 Bearer 可绕过 HttpOnly；curl 运维可改用浏览器 DevTools 复制 Cookie 或用 `--cookie` 参数，无实质功能损失
- ❌ CSRF token 基建：SameSite=Lax + JSON-only 写接口下收益边际，复杂度高
- ⚠️ Secure 标志按请求协议动态判定而非强制：纯 HTTP 局域网部署（自托管常态）强制 Secure 会导致 Cookie 被浏览器丢弃；HTTPS 反代场景经 `x-forwarded-proto` 正确识别
- ⚠️ XSS 仍可当次冒充（发起请求）：彻底防御需 CSP 等输出编码体系，超出本次范围

**影响**：
- `auth.ts` 新增 `setAuthCookie`/`clearAuthCookie`/`getAuthToken`；`userAuthMiddleware` 与 `adminAuthMiddleware` 统一改走 `getAuthToken()`（只读 Cookie）
- 客户端删除 `getToken`/`setToken` 与全部手动 Authorization 附加点（`request()`、SSE fetch、上传、附件下载）；`LoginScreen.onLogin` 签名变为 `(username, expiresAt)`
- 所有 auth 相关 spec 文档中 Bearer/回退/迁移期 表述同步清除
- D32 的续期机制不变，仅传输载体从 Bearer 变为 Cookie 且不可逆

---

## D34：新会话草稿态 + 多设备实时同步（SSE 事件通道）

**日期**：2026-09

**背景**：① 点击「新会话」/「新群聊」即调用 `POST /api/conversations` 预建记录，导致侧边栏出现空会话；② 同账号多设备登录时，A 设备对话 B 设备必须手动刷新才能看到进展。

**决策**：

1. **新会话改为草稿态，不落库**：`createConversation`（单聊）与 `createGroupConversation`（群聊）只进入本地草稿态（`draftType: 'direct' | 'group'`，`activeId` 为 null），不调建会接口、不写 DB。会话记录在**发出第一条消息**时由 `POST /api/chat` 服务端创建（无 `conversation_id` 分支已存在），收到 `conversation_id` SSE 事件后清除草稿态。群聊选好 Agent 后侧边栏不再自动收回。
2. **多设备实时同步走 SSE 事件通道**：新增 `GET /api/events?device_id=xxx`（SSE 长连接，`userAuthMiddleware` 认证，15s 心跳），服务端进程内事件总线（`Map<userId, Set<subscriber>>`）把以下事件实时推送给同账号其他设备：
   - `stream`：聊天流中继（`user_message` / `token` / `thinking` / `tool_call` / `agent_start` / `done` / `suggestions` / `voice_segment` 等），跳过发起方 `device_id`
   - `conv_sync`：会话列表变更（新建/删除/重命名/群成员数）
   - `conv_changed`：回退消息 → 正在查看该会话的设备整条重拉
   - `group_members`：群成员变更
3. **设备标识**：客户端在 `localStorage` 持久化随机 `momoi_device_id`，`POST /api/chat` 携带 `device_id` 供服务端跳过对源设备的中继；`GET /api/events` 用它维护每设备唯一长连接。

**原因**：
- 草稿态契合「没有对话就没有记录」的心智模型（类 ChatGPT 未发送草稿），侧边栏保持干净；服务端 `POST /api/chat` 的「无 `conversation_id` 即建会」分支已存在，改动集中在客户端
- 多设备同步需求是**服务端单向推送**（A 设备产生、B 设备消费），SSE 是标准 HTTP、兼容代理/CDN，与既有 D1 架构决策一致；WebSocket 被 AGENTS.md 列为非目标
- 进程内事件总线对单实例部署足够简单；多实例需 Redis pub/sub（列为已知边界）

**备选与权衡**：
- ❌ 多设备改用 WebSocket：被项目非目标排除（D1 已迁移到 SSE）；且本场景是单向推送，双向能力用不上
- ❌ 客户端定时轮询：实时性差（思考中/流式内容要求亚秒级）、浪费请求
- ❌ 草稿态仍预建会但延迟删除空会话：逻辑复杂、易残留脏数据；直接不建更干净
- ⚠️ 上传附件例外：草稿态上传需要真实会话 ID（workspace 落盘），经 `ensureConversation` 按草稿类型预建真实会话（技术必要，可接受的边缘行为）
- ⚠️ 同一浏览器多标签页共享 `device_id`：后开标签页会顶掉先开的订阅（避免事件双发）；用户需求是多设备同步，多标签页场景不额外引入 BroadcastChannel
- ⚠️ 仅限单实例部署：多实例/横向扩容需替换为 Redis pub/sub

**影响**：
- 新增 `src/server/realtime.ts`（内存事件总线）与 `src/server/routes/events.ts`（SSE 通道路由）；`chat.ts` / `conversations.ts` / `group.ts` 在关键写路径广播事件
- `useChat.ts` 新增草稿态、`device_id` 携带、实时订阅与中继事件应用；`useGroupChat.ts` 群聊草稿化 + 实时群成员刷新；`api.ts` 新增设备 ID 与实时连接管理
- `shared/types.ts` 新增 `RealtimeEvent` 与 `user_message` 事件；`module-chat.md` spec 同步更新

---

## D35：OIDC 第三方登录与账号绑定

**日期**：2026-09-10 ~ 2026-09-11（原 OAuth2 版）· 2026-10-29 修订为 OIDC（见 D72）

**背景**：项目仅支持用户名 + PIN 登录（D12），但多用户场景下每人需独立注册 PIN，且无法接入已有身份体系。需要引入标准 OIDC 协议以降低注册门槛，同时允许已有账号绑定 OIDC 身份实现免 PIN 登录。

**决策**：
1. **OIDC 多提供商架构**：支持配置任意 OIDC 提供商（通过 `oidc_providers` 配置数组，管理员面板增删）。主字段为 `id`、`name`、`issuer`、`client_id`、`client_secret`、`scopes`；`authorize_url` / `token_url` / `userinfo_url` 保留为**可选覆盖项**（仅非标 Provider 才填）。
2. **端点由 discovery 自动获取**：`${issuer}/.well-known/openid-configuration`，进程内缓存 1 小时；拉回后比对 `doc.issuer === 配置 issuer`，不一致即拒绝。
3. **三态回调路由 `GET /api/oidc/callback`**：
   - **已有绑定**：OIDC 身份已关联某用户 → 直接签发 JWT，设置 HttpOnly Cookie，重定向到首页（`oidc_user` + `oidc_expires` 查询参数供客户端读取）。
   - **已登录 + 无绑定**：用户已持有有效 JWT Cookie → 自动将当前 OIDC 身份绑定到当前账号。
   - **全新用户 + 注册开放**：重定向到首页带 `oidc_register=1` 参数，前端引导完成注册（选"关联已有账号"或"创建新账号"）；注册关闭时直接报错。
4. **`user_oidc_bindings` 表**：`(provider_id, provider_user_id)` 唯一约束，每 OIDC 身份只绑定一个用户；绑定后可免 PIN 直接登录。`provider_user_id` 取**验签后 id_token 的 `sub`**。
5. **独立注册开关**：`oidc_registration_open` 设置（默认开启），管理员可独立关闭 OIDC 新用户注册，不影响已有绑定用户登录。

**原因**：
- 标准 OIDC Authorization Code 流程，安全性依赖 state 参数防 CSRF（`randomBytes(32)` 存在 HttpOnly Cookie 中，回调时校验）
- 身份锚定于**签名 id_token 的 `sub`**：iss / aud / exp 由密码学校验，而非信任 userinfo 返回的裸 JSON
- Referer 头推导 SPA 真实 origin（开发模式 Vite 代理下 `c.req.url` 指向后端端口，Referer 才携带前端地址）
- 三态回调一个端点处理全部情况，减少 URL 管理复杂度

**备选与权衡**：
- ✅ OIDC 标准模式（**当前选定**）：discovery + id_token 验签。早期以「国内私有提供商不兼容」为由否决过，后因自建 `oidc-dingtalk` Provider 提供了标准锚点而推翻——详见 D72
- ✅ 可选覆盖项：对不发 discovery 的非标 Provider 保留手填 URL 逃生舱；`authorize_url` 与 `token_url` 同时填写时完全跳过 discovery
- ❌ 每个提供商独立回调 URL：增加注册复杂度，统一回调可复用 redirect_uri
- ⚠️ state 仅存 HttpOnly Cookie 10 分钟（`maxAge: 600`），超时后回调 state 校验失败——用户体验为跳回首页带 `oidc_error_code`，需重新发起登录
- ❌ ~~`remoteId` 解析 fallback 到 `randomUUID()`~~（D72 已移除）：旧实现会让非标 Provider 每次回调都生成不同 ID，重复触发注册页；现在无 `sub` 直接报错

**影响**：
- 新增 `apps/server/src/routes/oidc.ts`（`/providers`、`/:providerId/login`、`/callback`、`POST /register`）
- 新增 `apps/server/src/lib/oidc-discovery.ts`（discovery 拉取与缓存）、`oidc-verify.ts`（id_token 验签）
- `user_oidc_bindings` 表（含 PG 双方言 schema）；`users` 表新增 `banned` 列
- `AppConfig` 新增 `oidc_providers` 字段；`config.ts` 新增 `isOidcRegistrationOpen` / `setOidcRegistrationOpen`
- `LoginScreen` 新增 OIDC 登录入口（按提供商列表渲染按钮）与 OIDC 注册流程（`oidc_register` 参数触发）
- `GET /api/user/status` 新增 `oidc_registration_open` 字段

---

## D36：微信绑定与 iLink Bot 集成

**日期**：2026-09-13 ~ 2026-09-15

**背景**：用户希望在微信中与 Momoi Agent 对话，而非局限于 Web 界面。微信通过 iLink Bot 协议提供接入能力，需要完整的绑定-轮询-消息桥接链路。

**决策**：
1. **单表 `wechat_bindings` 承载全部状态**：`user_id`（主键，1:1 绑定）、`bot_token`（扫码后获得）、`wechat_user_id`（微信侧用户 ID）、`conversation_id`（路由目标会话）、`pending_conversation_id`（扫码期间暂存的目标会话 ID，确认后写入 `conversation_id`）、`updates_buf`（轮询游标）、`session_expired`（会话过期标记）。
2. **QR 码绑定流程**：`POST /api/wechat/bind` 调用 iLink `get_bot_qrcode` → 用 `qrcode` 库服务端生成 QR data URI → 前端轮询 `GET /api/wechat/bind/status` 检测扫码状态 → `confirmed` 时写绑定行。支持绑定到已有会话（传 `conv_id`，经验证为有效直接非群聊后锚定）。
3. **覆盖转移**：重新扫码即自动换绑——新 QR 扫描后 `conversation_id` 写入目标，旧会话自然不再路由。
4. **iLink 协议客户端**（`ilink.ts`，纯函数、零框架依赖）：`getUpdates()` 长轮询拉取消息、`sendMessage()` 发送文本回复、`parseIncoming()` 解析入站消息，全部使用 Node 18+ 标准库（fetch + crypto）。
5. **定时轮询器**（`poller.ts`）：每 5 秒遍历所有已绑定用户，逐用户调用 `getUpdates`，解析后桥接到 `handleWechatMessage`。双防护：`busyUsers` Set 防同用户并发轮询；`writeGuard`（`eq(bot_token, 快照值)`）防换绑期间游标/会话过期标记误写入新绑定行。
6. **消息桥接**（`chat.ts`）：接收微信文本 → 查 `wechat_bindings` 获取目标 `conversation_id` → 校验 sender 身份（合法 sender 即扫码者本人）→ 写入 user message → 调用 `runPiAgentLoop` 生成回复 → 写 assistant message → 通过 iLink `sendMessage` 回复微信。

**原因**：
- 单表承载全状态避免双表 join 与数据一致性问题（原设计 `bot_tokens` + `bindings` 双表在 57bc339 合并）
- `pending_conversation_id` 允许用户在扫码期间先选目标会话，扫码完成后自动关联——整个绑定+锚定体验为一次连续操作
- `writeGuard` 解决换绑竞态：`getUpdates` 是长轮询（35s 超时），期间如果用户重扫 QR 换了 `bot_token`，旧轮询的 cursor 写入或 `session_expired` 标记会误伤新绑定行
- 轮询器 per-user guard + writeGuard + 会话存活校验三重防御，确保每个用户的绑定状态是自愈的
- `parseIncoming` 只处理 `message_type === 1`（文本消息），picture/voice/video 等富媒体类型静默跳过

**备选与权衡**：
- ❌ Webhook 推送模式：iLink 不提供 Webhook 能力，必须客户端长轮询
- ❌ 全局单轮询器（一次性拉取所有用户消息）：iLink `getupdates` 是 per-bot-token 的，每个 token 独立的 `updates_buf` 游标
- ❌ 双表分离（bot_tokens + bindings）：游标过期/会话过期需跨表更新，一致性复杂且易出 bug
- ⚠️ `sendMessage` 失败 3 次重试（指数退避 1s/2s/4s），区分「会话过期」（`errcode=-14`，标记 `session_expired` 不再重试）与「瞬时故障」（HTTP 5xx/fetch failed/timeout，重试后仍失败落 system 消息告知用户）
- ⚠️ 会话级别自动解绑：当绑定指向的 conversation 被软删除或不存在时，`poller.ts` 主动删除绑定行（自愈），用户侧重新扫码即可

**影响**：
- 新增 `src/server/wechat/ilink.ts`（iLink 协议纯函数客户端）、`src/server/wechat/chat.ts`（消息桥接与 AI 路由）、`src/server/wechat/poller.ts`（定时轮询器）、`src/server/routes/wechat.ts`（绑定/解绑 HTTP 端点）
- `wechat_bindings` 表（含 PG 双方言 schema）；`db.ts` 导出
- `POST /api/wechat/bind`、`GET /api/wechat/bind`、`GET /api/wechat/bind/status`、`DELETE /api/wechat/bind` 四个端点
- 前端新增微信绑定 UI（QR 码展示 + 扫码状态轮询 + 解绑按钮）

---

## D37：TTS 语音合成 — GPT-SoVITS / CosyVoice 双引擎

**日期**：2026-09-13

**背景**：AI 文字回复对语音交互场景不友好。需要将 Agent 文本回复自动合成为语音，支持多个 TTS 引擎。语音需与 Agent 人格一致（音色注册 → 合成 → 前端播放）。

**决策**：

1. **Phase 分阶段交付**（共 5 阶段）：
   - Phase 1：`agents` 表新增 `voice_enabled` / `voice_sample_url` / `voice_settings` 三列，管理端 CRUD
   - Phase 2：流式回复完成后按标点分句，逐句调用 TTS 合成，WAV 落盘 `data/voice/{agentId}/{messageId}/`，生成 `manifest.json`
   - Phase 3：前端 `VoicePlayButton` 嵌入聊天气泡，`AudioPlaybackManager` 管理播放队列
   - Phase 4-5：管理端扩展（TTS 接入点/提供商配置）+ i18n 补齐
2. **双引擎 TTS Provider 接口**（`TtsProvider`）：
   - `registerVoice(audioPath): Promise<string>` — 上传参考音频注册音色，返回 speakerId
   - `synthesize(text, speakerId, settings): Promise<Buffer>` — 逐句合成，返回 WAV buffer
3. **GPT-SoVITS 引擎**：`/set_refer_audio` 注册音色（speakerId 为文件名 stem），`/tts` 合成（参数：`text`、`refer_wav_path`、`speed`、`top_k=5`、`top_p=1`、`temperature=1`）
4. **CosyVoice 引擎**：`/register_voice` 注册返回 `voice_id`，`/synthesize` 合成（参数：`text`、`voice_id`、`speed`）
5. **流式后置合成**：AI 回复完整流式结束后，按 `。！？；\n` 分句，逐句异步合成，`voice_segment` SSE 事件实时推送每段音频 URL + 时长给客户端
6. **TTS 配置**：`tts_api_endpoint` 和 `tts_provider`（`gpt-sovits` / `cosyvoice`）settings 键，管理端 GatewaySettings 标签页配置

**原因**：
- 双引擎解耦：provider 接口抽象使切换/新增引擎零代码改动，仅配置变更
- 流式后置而非流式逐 token 合成：token 级合成太碎片化、延迟不可控；按句合成既保证自然停顿又避免延迟爆炸
- WAV 无损落盘 + CDN 不适用：语音文件体积小（<100KB/句），本地直接 serve 更简单
- `manifest.json` 记录每句文本与完成状态，支持断点续传与服务端重启后恢复

**备选与权衡**：
- ❌ 单引擎锁定（仅 GPT-SoVITS）：CosyVoice 音色克隆质量在特定场景更优，双引擎给予用户选择自由
- ❌ 流式逐 token 合成：Token 级片段太短（<500ms），TTS 引擎调用频率过高，而且 token 合成后无法修改——后续 token 可能改变整句语义
- ❌ 服务端混音（多句合并为单文件）：播放进度不可控，用户无法跳句
- ⚠️ TTS 引擎为外部服务依赖（需单独部署），服务不可用时语音功能静默降级（无语音但对话正常）
- ⚠️ 分句策略简单（按标点），对英文/混合语言可能切分不准——当前项目以中文为主，可接受

**影响**：
- 新增 `src/server/ai/tts.ts`（TTS provider 接口 + GPT-SoVITS / CosyVoice 实现 + `synthesizeAndSave` / `markVoiceComplete` 辅助函数）
- `agents` 表新增 `voice_enabled` / `voice_sample_url` / `voice_settings` 三列（含 PG 方言 ADD COLUMN IF NOT EXISTS）
- `config.ts` 新增 `getTtsConfig()` / `updateTtsConfig()`；`shared/types.ts` 新增 `VoiceSettings` 接口
- 前端新增 `AudioPlaybackManager`、`VoicePlayButton`、`useVoice` hook；管理端新增 TTS Gateway 配置 + Agent voice 编辑
- `voice_segment` SSE 事件在流式完成后逐句下发音频 URL

---

## D38：ask_user — 阻塞式 Agent 询问用户工具

**日期**：2026-09-09

**背景**：Agent 在遇到不确定的决策点（文件命名、技术选型、参数选择）时，要么猜测（可能猜错，用户不满意），要么中断对话（需要用户重新输入）。需要一个机制让 Agent 在工具调用过程中暂停、向用户提问、等待回答后继续执行。

**决策**：新增 `ask_user` 内置工具——Agent 调用后通过不 resolve 的 Promise 阻塞 Pi 循环，外部通过 `POST /api/chat/:conversationId/answer` 端点唤醒。整个生命周期：
1. **Agent 调用 `ask_user`**：传入 `questions` 数组（每项含 `header`、`question`、`options`（2-4 个）、`multiSelect`）
2. **服务端挂起**：`execute()` 返回永不 resolve 的 Promise（存入 `questionMap`），Pi 循环自然等待
3. **客户端展示**：通过 `ctx.onUpdate` 触发 `tool_execution_update` 事件，type 为 `ask_user`，客户端弹出 QuestionCard 组件
4. **用户回答**：客户端调 `POST /api/chat/:id/answer` 传入 `questionId` + `answer` + `selectedOptions`
5. **唤醒 Agent**：`resolveQuestion()` resolve 挂起的 Promise，结果 `{ answer, selectedOptions }` 作为工具输出回传 LLM 继续推理
6. **超时兜底**：120 秒无回答 → reject（"用户未在 120 秒内回答，问题已过期。"），Agent 自行处理

**原因**：
- Promise 阻塞方案而非轮询/事件循环：Pi 循环在工具执行期间自然等待 Promise resolve，无需引入额外的暂停/恢复状态机——现有 Agent 循环的并发模型天然适合
- questionId（UUID v4）唯一标识每个问题，防止多问题串扰
- 支持单选/多选/自由文本三种模式：有选项时用户更快决策（点按即答），无选项时（`options: []`）用户自由输入
- Pi adapter 中 `ask_user` 工具标记为 `executionMode: 'sequential'`——该工具阻塞时其他工具不并发，防止 UI 同时弹出多个问题弹窗
- SSE 连接断开时自动 `cleanupConversationQuestions()` 清理该会话所有挂起问题

**备选与权衡**：
- ❌ 客户端事件驱动恢复：需要额外的"继续对话"协议与思考中断/恢复机制，复杂度高
- ❌ 纯文本追问（Agent 直接用自然语言提问、用户文本回复）：信息结构不足——选项让用户一键作答，避免"回答不符合预期"的来回纠错
- ❌ 多问题并发展示（同时弹出多个 QuestionCard）：UI 混乱，用户先答哪个不可预期；`sequential` 模式每次只展示一个问题
- ⚠️ Promise 挂起期间进程内存占用：挂起状态极轻（一个 Promise + timer 引用），不会有内存压力
- ⚠️ `questionMap` 为内存 Map：重启丢失所有挂起问题——当前为单实例部署，可接受；横向扩容需迁移到共享存储

**影响**：
- 新增 `src/server/tools/ask-user-tool.ts`（`askUserTool`、`resolveQuestion`、`rejectQuestion`、`getPendingQuestion`、`cleanupConversationQuestions`）
- `registry.ts` 注册 `askUserTool`
- `pi-adapter.ts`：`ask_user` 标记 `executionMode: 'sequential'`；`tool_execution_update` 事件处理中识别 `type === 'ask_user'`
- `chat.ts` 新增 `POST /api/chat/:conversationId/answer` 端点；SSE 断开时调用 `cleanupConversationQuestions`
- 前端新增 `QuestionCard` 组件（单选/多选/自由文本三种 UI）；`useChat.ts` 处理 `ask_user` SSE 事件

---

## D39：PostgreSQL 远程数据库模式 — 本地 SQLite / PG 远程双后端

**日期**：2026-09-10（初版多数据库支持）→ 2026-09-14（精简为 SQLite + PG 双后端）

> ⚠ 2026-10 更新：本地 SQLite 的 driver 已由 sql.js 换成 node:sqlite（见 D61），
> **本决策立项时作为动因之一的「内存态写入 + 30 秒持久化间隔数据丢失窗口」已被 D61 根治**。
> PG 远程模式因此回归为纯粹的「横向扩容 / 团队生产」选项，不再兼任「规避本地丢数据」的职责。
> 下文提及 sql.js、30s 持久化、SIGTERM flush 的具体描述均已被 D61 取代，保留仅作历史。

**背景**：sql.js（SQLite WASM）零配置轻量，但内存态写入 + 30 秒持久化间隔有数据丢失窗口，且单实例无法横向扩容。需要可选的生产级远程数据库支持。

**决策**：
1. **双后端架构**：根据 `DATABASE_URL` + `DATABASE_USER` + `DATABASE_SECRET` 三个环境变量自动选择：
   - 任一缺失 → SQLite（sql.js），保持 D2 的零配置体验，自动创建 `data/momoi.db`
   - 三者齐全且 URL 为 `postgres://` 或 `postgresql://` → PostgreSQL（`pg` + `drizzle-orm/node-postgres`），连接池 max 5
2. **双 schema 文件**：`schema.ts` 为 SQLite 方言（`INTEGER` 布尔/`AUTOINCREMENT`），`schema.pg.ts` 为 PG 方言（`SERIAL`/`BOOLEAN`）；`db.ts` 按方言动态导入对应 schema
3. **迁移策略**：
   - SQLite：`MIGRATION_SQL` 常量（`CREATE TABLE IF NOT EXISTS`）+ `ADDITIVE_MIGRATIONS` 数组（`ALTER TABLE` 逐条 try/catch）
   - PG：`pool.query()` 执行完整 DDL（含 `ADD COLUMN IF NOT EXISTS`，原生支持）
4. **环境变量注入**：`DATABASE_URL` 缺省 `username`/`password` 时，从 `DATABASE_USER`/`DATABASE_SECRET` 补齐

**原因**：
- SQLite（sql.js）零配置覆盖开发/个人部署；PG 覆盖生产/团队/高可用场景——一个 `DATABASE_URL` 即可切换，不改代码
- 双 schema 文件而非运行时方言判断：编译期隔离更安全（选错方言不会静默出 bug）且代码更清晰
- `node-postgres` 而非 `pg-promise`：Drizzle ORM 官方推荐，pool + 原生 SQL 足够
- SQLite ADDITIVE_MIGRATIONS 每条 try/catch：SQLite 不支持 `IF NOT EXISTS` 的 ALTER TABLE，逐条 try 避免了"迁移失败则库不可用"的一级事故（node:sqlite 下同样适用，见 D61）
- ~~30 秒自动持久化 + SIGINT/SIGTERM 退出时同步 `writeFileSync` 落盘（SQLite 模式）~~（**D61 已删除**：node:sqlite 每 commit 自动 fsync，无需定时 export，也不依赖退出 flush）

**备选与权衡**：
- ❌ 单 SQLite（不引入 PG）：被视为性能/部署场景的限制而非 bug——生产部署需求是真实存在的，PG 支持干净地解决了这个问题
- ❌ ORM 自动迁移（Drizzle Kit）：引入额外工具链 + 迁移文件管理；DDL 常量直接内联 code 更简单，项目表结构稳定，不需要版本化迁移
- ❌ 保留 MySQL/MariaDB（原 `refactor: 多数据库支持` 中有支持）：2026-09-14 的 5f11714 移除——三个方言维护成本高且 MySQL 用户群体与"轻量自托管"定位重叠度最低
- ⚠️ `pg` 驱动需额外安装（`pnpm add pg`）：检测到 PG 模式时启动报错并提示安装——首次使用需手动操作一次
- ⚠️ SQLite ↔ PG schema 差异需人工同步：`schema.ts` 和 `schema.pg.ts` 是两个独立文件，新增字段需两边同步——当前项目 schema 变动频率已很低，可接受

**影响**：
- `src/server/db.ts` 重写为方言工厂：`detectRemoteDialect()` → `initSqlite()` / `initPg()` 二选一
- 新增 `src/server/schema.pg.ts`（PG 方言 schema）
- `package.json` 新增 `pg` 可选依赖；移除 MySQL/MariaDB 相关 schema 与依赖
- `.env.example` 新增 `DATABASE_URL` / `DATABASE_USER` / `DATABASE_SECRET` 说明

---

## D40：多设备实时同步事件通道（补充 D34）

**日期**：2026-09-14

**背景**：D34 已将多设备同步纳入 SSE 事件通道体系，但未单独记叙事件总线本身的架构细节。此处作为 D34 的技术深度展开：事件总线是草稿态 + 多设备同步的底层基础设施，值得独立记录。

**决策**：
1. **内存事件总线（`realtime.ts`）**：`Map<userId, Set<RealtimeSubscriber>>` 进程内广播，每个 subscriber 含 `deviceId`、`aborted` 标志、`writeChain`（串行写入链，同 D23 机制防乱序/尾部丢失）、`onEvent` 回调。
2. **四种事件类型广播**：
   - `stream`：聊天流实时中继，`broadcastStream(userId, originDeviceId, data)` 跳过来源设备
   - `conv_sync`：会话列表变更，`broadcastConversationSync(userId)` 无差别广播
   - `conv_changed`：指定会话内容变更（如消息回退），携带 `conversation_id`，客户端按需重拉
   - `group_members`：群成员变更，携带 `conversation_id`
3. **设备自跳过**：`subscribeRealtime` 中同 `deviceId` 重复订阅自动顶掉旧订阅（React StrictMode 双挂载 / 网络重连防护）
4. **惰性清理**：广播时移除 `aborted` 的 subscriber，防止异常断线时订阅泄漏
5. **SSE 防缓冲头**：`Cache-Control: no-cache` + `X-Accel-Buffering: no`，阻止 Nginx/CDN 缓冲区攒事件
6. **统一 data-only 格式**：只发 `data:` 字段不设 `event:` 别名——老内核 WebView（钉钉内置等）的 EventSource 对自定义事件名支持不可靠，仅触发默认 `onmessage`

**原因**：
- 进程内 Map 对单实例足够简单零依赖；多实例需 Redis pub/sub（列为已知边界）
- 设备自跳防止同设备收到双份事件：源设备已通过 POST /api/chat 的 fetch 流直接消费，SSE 通道只服务其他设备
- 惰性清理 + 订阅顶掉双保险：异常断线不会泄漏、React StrictMode 不会双发——都是生产环境真实踩过的坑

**备选与权衡**：
- ❌ 每个事件类型独立 channel：开销大、维护四套 subscriber 集合；统一总线 + type 字段更简洁
- ❌ 全设备广播（不跳过来源）：源设备收到双份相同事件，UI 刷新闪烁/重复渲染
- ⚠️ 多实例需升级为 Redis pub/sub：当前显式排除，横向扩容前必须改造此模块

**影响**：
- 新增 `src/server/realtime.ts`（内存事件总线 + 四种广播函数）、`src/server/routes/events.ts`（SSE 长连接端点）
- `chat.ts`、`conversations.ts`、`group.ts` 在关键写路径调用广播函数
- 前端 `api.ts` 新增 `connectRealtime()` SSE 连接管理；`useChat.ts` / `useGroupChat.ts` 应用事件处理

---

## D41：CDN 外挂图床 — 自动转存 cloudflareimg.cdn.sn

**日期**：2026-09-11（2026-10-29 修订：域名迁移与默认值翻转）

**背景**：管理后台允许上传自定义 favicon 和背景图，但这些图片以 base64 data URL 存入 `settings` 表（`app_favicon` / `app_background`），体积大（一张背景图可能 > 2MB）。base64 膨胀 `settings` 表、拖慢 `getConfig()` 读取，且浏览器渲染 base64 图片性能差、无法缓存。

**决策**：引入外部 CDN 图床——管理后台上传图片时自动转为 CDN 永久 URL，`settings` 表仅存 URL 而非 base64。通过 `use_external_image_hosting` 管理员开关控制，**默认开启**。

**原因**：
- `settings` 表存储的 data URL 字符串长度可达 2-4MB，一条配置撑大整个 SQLite 文件（每条设置都完整序列化到 WASM heap）
- CDN URL 仅几十字节，对 settings 表几乎无体积影响，getConfig 读取速度也有保障
- 浏览器可直接以 `<img src>` 加载 CDN URL，利用浏览器缓存、无 base64 解码开销
- `cloudflareimg.cdn.sn` 免费、无需 API key（`/api/v1.php` multipart 上传）

**域名选型（实测结论，非偏好）**：同一套接口在三个域名下都存在，但只有 `cloudflareimg.cdn.sn` 全链路可用——`img.scdn.io` 整站不可达（TCP 443 直接超时约 20s），`img.cdn1.vip` 的 `/api` 前有验证码 WAF（返回 `_guard/html.js`）。三者共享同一份 `/i/<file>` 路径，故服务端即便返回 `img.cdn1.vip` 链接，把 host 改写为 `cloudflareimg.cdn.sn` 后实测同样 200。

**实现细节**：
- `base64ToBuffer(dataUrl)`：解析 base64 data URL 为 Buffer + MIME type
- `uploadToCdn(buffer)`：multipart/form-data 上传到 `https://cloudflareimg.cdn.sn/api/v1.php`，返回 host 已归一的公开 URL
  - 文件字段 `image`，文件名固定 `upload`（服务端按内容嗅探格式）；另带 `cdn_name=cloudflareimg.cdn.sn` 表单字段，把目标域名表达在协议层
  - 内置节流（两次请求间隔 >= 1000ms），匹配服务端 5 次/5s、120 次/60s 限制
  - **5xx 与网络错误重试 1 次；4xx 不重试**，服务端中文原因（如「图片无法被解码」）原样透传到 `CdnUploadError.message`
  - undici 的 `UND_ERR_*` 连接类错误一并归入可重试；建连超时放宽到 30s（默认 10s 对跨洋线路偏紧）
- 管理端保存 favicon/background 前检测 `use_external_image_hosting` 开关：开 → 先上传得 CDN URL，关 → 保留 base64 data URL
- 聊天附件上传同样遵循该开关；CDN 失败时**回退到工作区 URL**，不阻断消息发送

**备选与权衡**：
- ❌ 本地 serve 静态文件：需要额外的文件服务端点 + 备份管理，且 `data/` 目录无版本化
- ❌ 自建图床/MinIO：引入外部服务依赖，与"轻量自托管"定位冲突
- ⚠️ 默认开启的取舍：外部 URL 会把自定义资源与聊天附件暴露到公网。原始决策为默认关闭，现按产品要求翻转为开——代价是开箱即用与省体积，风险由管理员在网关页一键关闭兜住（关闭后只影响新上传，已转存图片仍在 CDN）
- ⚠️ CDN 服务可用性不可控：第三方免费服务，SLA 无保障，60 天无人访问的图片会被自动删除。不可用时上传失败并回退，不影响已生成 URL 的图片。可替换 `cdn.ts` 的 `CDN_HOST`

**影响**：
- 新增 `src/server/cdn.ts`（`base64ToBuffer` + `uploadToCdn`）
- `config.ts` 新增 `isExternalImageHostingEnabled()`；`AppConfig` 新增 `use_external_image_hosting` 布尔字段
- 管理端 `BrandingSettings` 在保存时按开关决定调用 CDN 转存流程
- `GET /api/app-name` 返回 `use_external_image_hosting` 供前端判断

---

## D42：直连注册开关 — 独立控制用户名 + PIN 注册

**日期**：2026-09-11

**背景**：部署者可能希望仅通过 OIDC 登录（如企业微信内部使用），关闭直接注册入口。原无此能力——注册页面始终可用。需与 OIDC 注册开关（见 D35）独立控制——可同时开启、仅 OIDC、仅直接注册、全部关闭。

**决策**：新增 `direct_registration_open` settings 键（默认 `true`），与 D35 的 `oidc_registration_open` 各自独立。`LoginScreen` 注册表单的可见性由 `direct_registration_open` 控制；`GET /api/user/status` 同时返回两者的当前值。

**原因**：
- 两扇独立门：部署者可按需组合——企业内部全走 OIDC（关直连）、公网双通道（全开）、维护模式（全关）
- 默认开启保持 D12 的零配置体验（用户名 + PIN 始终可用）
- 与 `oidc_registration_open` 对称设计：一个模板 `getSetting` / `setSetting` / admin API（`GET + PUT /api/admin/direct-registration`）

**备选与权衡**：
- ❌ 单一注册总开关（一处关闭所有注册方式）：粒度太粗——关闭全部注册等于关闭应用，不够灵活
- ❌ 环境变量控制（启动时固定）：无法运行时切换，管理员面板热更新更符合 D7 的双层配置原则
- ⚠️ 关闭注册不影响已有用户登录：仅隐藏注册 UI + 注册端点校验拒绝——已有账号照常使用

**影响**：
- `config.ts` 新增 `isDirectRegistrationOpen()` / `setDirectRegistrationOpen()`
- `routes/admin.ts` 新增 `GET + PUT /api/admin/direct-registration`
- `GET /api/user/status` 返回 `direct_registration_open`
- `LoginScreen` 按 `direct_registration_open` 显隐注册表单；`UserManager` 管理界面新增直连注册开关

---

## D43：微信消息去重与会话锁

**日期**：2026-09-13（消息去重）→ 2026-09-15（会话锁完善）

**背景**：iLink 消息投递保障"至少一次"——同一条微信消息可能被 `getUpdates` 多次投递（网络重试、轮询间隔重叠）。缺乏去重会导致同一条用户消息生成多次 AI 回复。同时，每个用户需确保 AI 调用不交叉执行（前一条消息的 AI 回复未完成时后一条消息到达）。

**决策**：

1. **内存级消息去重**（`chat.ts`）：`dedupCache: Map<messageId, timestamp>`——收到消息时按 `messageId`（iLink 原生字段）查重，5 分钟过期窗口（`DEDUP_WINDOW_MS = 5 * 60_000`），命中直接跳过。惰性淘汰：每次查重前遍历清除过期条目。
2. **并发会话锁**（`chat.ts` + `routes/wechat.ts`）：
   - `handleWechatMessage`：per-user mutex（`withLock(userId, ...)`）——同一用户的前一条消息处理未完成时，新消息排队等待
   - `GET /api/wechat/bind/status`：per-user binding lock（`withBindingLock(userId, ...)`）——两个并发的 QR 扫码确认串行化，防止互相 clobber `bot_token` / `conversation_id`
3. **去重优先于加锁**：`isDuplicate()` 在 `withLock()` 之前执行——重复消息不排队，直接丢弃

**原因**：
- 去重窗口 5 分钟覆盖 iLink 最长重试周期；惰性淘汰避免内存泄漏（定时器方案会累积）
- 会话锁防止交叉执行：`handleWechatMessage` 内包含"读 history → AI 生成回复 → 写 DB → sendMessage 微信回复"，完整链条必须在单次执行中完成，并发交叉会导致回复嵌错对话、消息顺序颠倒
- 去重优先：重复消息无需排队等锁——直接 return，不阻塞后续合法消息

**备选与权衡**：
- ❌ 持久化去重（DB 列 `message_id` + 唯一约束）：iLink `message_id` 可能跨 bot 实例重复（非全局唯一），且 DB 查询比内存 Map 慢
- ❌ 单用户全局信号量（`Mutex` from async-mutex）：引入额外依赖；自实现 `Map<string, Promise<void>>` 排队链已足够
- ❌ 消息队列（如 BullMQ / Redis）：引入外部基础设施，与"轻量自托管"定位冲突
- ⚠️ 内存锁重启丢失：重启后若两个请求同时到达，排队链重建——`while (locks.has(key)) await locks.get(key)` 保证顺序，不会交叉执行
- ⚠️ `dedupCache` 无限增长风险：惰性淘汰只在新消息到达时执行——理论上如果长时间无新消息，过期条目不会被清理。实际场景中不会出现（微信轮询每 5s 触发一次，总有新消息触发淘汰）

**影响**：
- `src/server/wechat/chat.ts`：`isDuplicate()`、`withLock()`、`dedupCache`、`DEDUP_WINDOW_MS`
- `src/server/routes/wechat.ts`：`bindingLocks`、`withBindingLock()`
- 消息去重在 `handleWechatMessage` 最外层调用，before lock；会话锁包裹完整 AI 调链路

## D44：QQ 渠道接入（手写最小协议客户端 + 双渠道正交绑定）

**日期**：2026-09-17

**背景**：微信绑定（D36）为单一硬编码渠道。需求：「在微信上继续」升级为「在 IM 上继续」（渠道选择 Dialog），新增 QQ 渠道——用户仅需提供自己在 q.qq.com 创建的机器人的 AppID + AppSecret；一个会话可同时绑定微信与 QQ（完全正交）。

**决策**：

1. **手写最小协议客户端，不集成 `@tencent-connect/qqbot-nodejs` SDK**：`src/server/qq/{api,gateway,manager,chat}.ts` 平行于 `src/server/wechat/` 实现，协议事实逆向自 SDK v1.0.4 源码（token / C2C 发送 / stream_messages / WS 网关）。唯一新增依赖 `ws`（已在依赖树中，经 `@hono/node-ws` 传递）。
2. **无认领模型**：QQ 个人机器人未发布态只有创建者本人能私聊（1 用户 : 1 机器人 : 1 会话），发送者必然是用户本人——不存储、不校验 openid 归属。
3. **C2C 单次发送（2026-09-17 更新：放弃流式）**：AI 回复最初通过 `stream_messages` 流式回显，后统一改为 `sendC2CText` / `sendGroupText` 单次发送——删除了整个 `QqStreamSender` 类（~130 行）+ `sendStreamFrame` + `isQqRateLimitError` + `QqStreamFrameRequest`。C2C 与群聊行为一致：`sendTextWithRetry`（3 次退避 + >4000 字符自动分片）
4. **凭证保留式解绑**：软删会话仅清 `qq_bindings.conversation_id`，保留凭证与连接（AppSecret 遗失需重新生成，成本远高于微信重扫码）；显式解绑才删行断连。
5. **跨渠道共享用户锁**：抽取 `src/server/im/locks.ts`（原 wechat/chat.ts 与 routes/wechat.ts 各一份的重复实现），微信与 QQ 消息处理共用裸 userId 锁——双渠道绑同一会话时 AI 调用串行，防历史交叉。
6. **状态落库阈值**：DB `status='error'` 仅由凭证校验失败 / 启动失败 / 致命关闭码（4914/4915）触发；瞬时 WS 错误仅日志 + 自动重连（退避 [1s..60s]、快断保护），防状态抖动。

**原因**：
- 弃 SDK：完整框架（中间件系统 / webhook 传输 / 媒体上传 / 频道群聊支持）对 Momoi 所需子集（token、C2C、流式、WS）过重；微信渠道 `ilink.ts` 已确立"纯函数手写协议客户端"的先例与风格
- `ws` 而非原生 WebSocket：无法在原生 API 上自定义 User-Agent 头（QQ 网关可能要求）；且 `ws` 已在依赖树中，零新增下载，tsup 外置即可
- 跨渠道锁是正确性需求而非风格偏好：两渠道绑定正交可指向同一会话，独立锁会导致并发 `runPiAgentLoop` 写同一会话

**备选与权衡**：
- ❌ `@tencent-connect/qqbot-nodejs` SDK：重（框架级）；协议细节黑盒，排障依赖上游
- ❌ `@tencent-connect/openclaw-qqbot` 插件：为 OpenClaw 框架设计（peer 依赖 openclaw），不可独立使用
- ❌ Webhook 传输：需公网 IP 与签名校验，与"轻量自托管"冲突；WS 出站连接零网络要求
- ❌ 认领流程（验证码 / 首条消息认领 openid）：个人机器人语义下多余（私聊者必然是本人）
- ❌ 原生 WebSocket（Node ≥ 22 零依赖）：无法设置 UA 头，网关兼容性未知
- ⚠️ 手写协议的维护责任：平台协议变更需自行跟进（微信 iLink 同模式，风险已接受）
- ⚠️ WS 会话状态仅内存：重启后放弃 RESUME 重新 IDENTIFY，停机期间消息丢失（与微信轮询停机同级语义）
- ⚠️ app_secret 明文入库：与 `wechat_bindings.bot_token` 同威胁模型；API 永不回显、日志不打

**影响**：
- 新增：`src/server/qq/{api,gateway,manager,chat}.ts`、`src/server/im/locks.ts`、`src/server/routes/qq.ts`、`qq_bindings` 表、`ImBindDialog.tsx`、`QqBindPanel.tsx`
- 重构：`WechatBindDialog` → `WechatBindPanel`（去 Dialog 壳）、wechat 侧锁实现改用共享模块、侧栏入口改「在 IM 上继续」
- 后续变更（2026-09-17）：D45——QQ 群聊支持与 C2C 放弃流式

---

## D45：QQ 群聊支持（opt-in + 单 Agent 对多真人 + 放弃流式统一单次发送）

**日期**：2026-09-17

**背景**：QQ 渠道（D44）仅支持 C2C 私聊，群聊 @机器人 事件被静默忽略。主人在群里 @机器人 发现没反应后要求支持群聊（方案 B —— 每群独立群组会话，单 Agent 面对多真人）。同时决定 C2C 私聊也放弃流式，统一走单次发送。

**决策**：

1. **Opt-in 群聊**：`qqBindings` 新增 `group_enabled` (boolean, default false)。Gateway 的事件订阅（`INTENT_GROUP_AND_C2C`）不变——群事件始终到达，但仅在 `group_enabled` 开启时处理。绑定时或绑定后可在面板 toggle，即时生效无需重启连接。
2. **独立路由表**：新建 `qq_group_conversations(app_id, group_openid, conversation_id)` 表，映射 QQ 群 → Momoi 群组会话。复合主键 `(app_id, group_openid)` 保证每群至多一个会话。C2C 私聊路由（`qqBindings.conversation_id`）与群聊路由完全隔离。
3. **懒创建群组会话**：首次收到群消息时自动创建 `type:'group'` 会话（标题「QQ群聊」）+ 注册默认 Agent 为唯一成员 + 写入 `qq_group_conversations` 映射。会话归属用户（非独立实体）——群成员发言均以该用户的群组会话为存储载体。
4. **单 Agent 模式**：不走 `orchestrateGroupChat`（Web UI 的多 Agent 串行编排器 + 中立 Agent 裁决 + @mention 链），直接 `runPiAgentLoop({ isGroup: true, isQqGroup: true })`。只有一个 AI Agent 面对多个 QQ 群成员，无 Agent 间交互需求。
5. **消息格式 `[昵称]: 内容`**：与 Web 端群聊中 Agent 间消息格式一致，AI 通过系统提示词（`isQqGroup` 规则块）区分不同群成员。
6. **C2C 与群聊统一单次发送**：删除 `QqStreamSender` 类（~130 行）+ `sendStreamFrame` + `isQqRateLimitError` + `QqStreamFrameRequest`。C2C 回发从 `streamer.complete() → 降级 sendTextWithRetry` 简化为直接 `sendTextWithRetry`。群聊用 `sendGroupTextWithRetry`（`POST /v2/groups/{group_openid}/messages`，无流式 API）。
7. **去 group 类型 guard**：`POST /api/qq/bind` 不再拒绝 `conv.type === 'group'`——群聊路由走独立表，C2C 路由到 group 类型会话也没有理由被禁止。

**原因**：
- 群聊 opt-in：大部分用户只想要私聊，群聊是风险更高的场景（群成员都可能 @机器人），默认关闭更安全
- 独立路由表：一对多关系（一个机器人 → 多个 QQ 群）天然不适合扩展单主键 `qqBindings` 表；软删自愈（映射指向已软删会话 → 自动重建）比硬编码更从容
- 不走编排器：`orchestrateGroupChat` 面向 Web UI 多 Agent 场景（中立 Agent 决定发言顺序、Agent 间 at_mention 工具、SSE 广播），QQ 群聊是单 Agent 对多真人——`runPiAgentLoop` 直调即可
- 放弃流式：① 群消息不支持流式 API；② C2C 也统一后回发路径一致（`sendTextWithRetry` / `sendGroupTextWithRetry`），代码大幅简化，删除约 160 行

**备选与权衡**：
- ❌ 扩展 `qqBindings` 表加 `group_openid` 列：单机器人只能绑一个群（违反一对多现实）
- ❌ 走 `orchestrateGroupChat`：编排器强依赖 SSE send 回调 + 中立 Agent 模型调用 + Agent 间状态机——QQ 群无需这些，引入只会增加复杂度和延迟
- ❌ 群名自动获取：网关事件不含群名，需额外 API 查询，首版不引入
- ⚠️ 群消息被动回窗口仅 5 分钟（C2C 是 60 分钟）：`sendGroupTextWithRetry` 在彻底失败前尝试不带 `msg_id` 的主动推送

**影响**：
- 新增：`qq_group_conversations` 表（双方言迁移）、`sendGroupText`（api.ts）、`handleQqGroupMessage` / `resolveGroupConversation` / `sendGroupTextWithRetry`（chat.ts）、`onGroupMessage` 回调（gateway.ts / manager.ts）、`isQqGroup` 系统提示词块（pi-adapter.ts）、group_enabled toggle（QqBindPanel + i18n 三语）
- 删除：`QqStreamSender` 类、`sendStreamFrame`、`isQqRateLimitError`、`QqStreamFrameRequest`、`SUGGESTIONS_FENCE` 引用（chat.ts）
- 简化：`handleQqMessageInner` 回发链路（streamer.complete → 降级 → 直接 sendTextWithRetry）
- 更新：`docs/specs/module-qq.md`（数据模型/消息流程/行为约束/验收标准/协议附录）

## D46：pnpm Monorepo 工作区——apps/* + packages/* 三层分离

**日期**：2026-09-18

**背景**：项目源码集中在单包全仓（src/client、src/server、src/shared），构建配置（tsup/tsconfig/vite/tailwind/postcss）与运行时数据（data/skills/.env）全部耦合在根目录。随着功能增长，依赖边界需要显式化；标准 monorepo 布局也为未来扩展（CLI、小程序等）预留空间。

**决策**：

1. **apps/server + apps/web + packages/shared** 三层结构（非统一 packages/*，区分为可部署应用与被引用库）
2. **纯 pnpm workspaces**：`pnpm-workspace.yaml` 的 `packages:` 声明；**无 Turborepo**（三包规模、构建链简单，任务图缓存收益微小但增加工具链与配置维护成本）
3. **`@momoi/shared` 以 TS 源码直引**：`exports` 指向 `./src/*.ts`，零构建；tsup 通过 `noExternal` 内联到 server bundle 使 `apps/server/dist/` 自包含可部署；web 端由 vite 自然消费
4. **运行时数据原地不动**：`data/`、`skills/`、`.env`、`docs/` 在仓库根目录；服务端新增 `paths.ts`（`repoRoot()` — 从 `import.meta.url` 向上找 `pnpm-workspace.yaml` 标记 → 兜底 `process.cwd()`）替换所有 `path.resolve('data',...)` 等 cwd 相对路径
5. **生产产物 = apps/server/dist/**：vite outDir 指向 `../server/dist/client/`，tsup + copy-docs → 自包含 dist（index.js+chunks + client/ + docs/），部署时拷贝整目录 + `.env` + `data/` 即可
6. **构建顺序 server 先 web 后**：`tsup --clean` 会清掉之前 vite 写入的 `client/` 子目录，强制 server 先在根脚本中执行

**原因**：
- `@/` 别名仅用于 shared 导入——证明客户端对 shared 的耦合天然是一层有名称的边界
- 服务端需要 cwd 独立性（monorepo 下 cwd 不再是仓库根）→ `path.resolve('data')` 会静默新建空 data 目录，必须重锚定
- shared 零运行时依赖——TS 源码直引无编译开销，开发循环即时生效
- pnpm workspaces 已在用（`allowBuilds`），加入 `packages:` 零额外工具

**备选与权衡**：
- ❌ Turborepo：三包、两构建步骤，工作区协议编排已足够；远程缓存在当前规模下无实质收益
- ❌ shared 独立构建：多一步构建循环，shared 仅 3 文件且无外部依赖——独立构建的边际收益为零
- ❌ 统一 packages/* 扁平化：不区分应用与库，语义模糊

**影响**：
- 新增：`pnpm-workspace.yaml`（合并 `packages:`）、`tsconfig.base.json`、四个 `package.json`（根瘦编排 + 三个子包）、四个 tsconfig、`paths.ts`、`env.ts`（显式 dotenv 路径替代三处 `import 'dotenv/config'`）、`scripts/copy-docs.mjs`（跨平台替代 POSIX `cp -r`）
- 移动（git mv 保留历史）：`src/server → apps/server/src`、`src/client → apps/web/src`、`src/shared → packages/shared/src`；`tsup.config → apps/server/`；`vite/tailwind/postcss.config → apps/web/`
- 导入重写：client `@/shared/ → @momoi/shared/`（11+30 处）；server `'../shared/*.js' → '@momoi/shared/*'`（去 .js，~20 处 + pi-adapter 3 处 inline type import）；`thinking.ts` 补 `.js` 后缀
- 服务端路径重锚定：~20 处 `path.resolve('x') → path.resolve(repoRoot(), 'x')`
- 弃用：`rehype-highlight`、`@hono/node-ws`（核实零导入）
- 首次 typecheck：补 DOM lib + `@types/node` + `dotenv` devDep（web 侧），三个包全绿
- 文档：README/AGENTS/ARCHITECTURE/DECISIONS 同步更新

## D47：提示词规则引擎——片段化注册表 + 分层组装

**日期**：2026-09-28

**背景**：提示词分散在服务端各处的代码里——`pi-adapter.ts` 的 `buildSystemPrompt()` 约 180 行条件拼接、`neutral-agent.ts` 的 6 段提示词常量、`visit-greeting.ts` / `push-scheduler.ts` 的内联指令、12 个工具模块的描述文本；人设兜底串在 3 个文件里各写一遍。后果：任何提示词改动都要在代码里「考古」；无法集中检视「模型到底收到什么」；扩展（技能追加规则、按 Agent 定制）没有入口。

**决策**：

1. **引入 `apps/server/src/prompts/`**：片段（`PromptFragment` = 文本 + 条件 + 位置）注册进单一注册表；配方（`PromptTarget`）按层顺序组装。装配方只保留调用点。
2. **组装语义**：目标匹配 → `when(ctx)` 过滤 → 层顺序/同层 priority 降序/注册顺序排序 → 渲染归一化（裁剪首尾空白、空产出丢弃）→ 按配方 separator 拼接（默认 `\n\n`）。
3. **提示词文本只应存在于 `prompts/fragments/**`**；装配代码（pi-adapter / neutral-agent / 通知模块）不再内联指令文本，原设计注释随文本一并迁移。
4. **工具描述纳入目录**（`tool/<name>`）：注入路径不变（工具 schema 的 description），解析经 `resolveToolDescription`，可被 `override()` 覆盖；MCP 工具描述来自远端，不进入目录。
5. **段间空行规范化**：旧实现中 `\n` 与 `\n\n` 混用（同一份提示词里两种分隔并存），引擎统一为 `\n\n`。迁移时以「迁移前基线」逐字节比对确认：去掉换行后**内容完全一致**，唯一差异是段间空行。
6. **变更留痕**：黄金快照（`test/golden/prompts.golden.json`）锁定全部配方的最终文本；提示词改动必须在快照中显形（`UPDATE_PROMPTS_GOLDEN=1` 重新生成）。测试框架选定 vitest（`pnpm test`）。

**原因**：

- 片段函数即模板（`render: (ctx) => string`）：类型安全、可单测、无模板语法解析成本；插值只发生在有 `ctx` 的地方，条件与文本天然同处一室
- 层（layer）+ 优先级（priority）把「为什么这段在这个位置」变成声明式数据；此前它散落在代码顺序与注释里（例如「写侧规则必须落在人设之后的行为规则区」）
- 引擎纯内存、无 IO、无网络：可测试性与可推理性是扩展性的前提；单个片段 `when/render` 抛错只跳过自身并记日志，一条坏规则不能弄瘫整条提示词
- 溯源（`AssembledPart[]`）让「这段文字从哪来」可回答，管理端预览直接消费

**备选与权衡**：

- ❌ 单一 `prompts.ts` 常量文件：文本收敛了，但条件仍在调用侧，扩展性不变
- ❌ 模板引擎（mustache/handlebars 等依赖）：引入依赖换取插值语法，收益低于成本（模板即函数）
- ❌ 提示词存 DB + 管理 UI 热改：自然的演进方向，但需要持久化、校验、回滚与鉴权设计——本版以引擎 API（register/override/disable/defineTarget）预留入口，持久化留待后续迭代
- ⚠️ 段间空行规范化是**刻意的行为变更**（对模型语义中性）：换来的是「分隔符由配方统一定义」，片段作者不必再关心自己前面是谁

**影响**：

- 新增：`prompts/`（types / engine / instance / registry / index / preview / fragments×6）、`routes/prompts.ts`（管理端目录与预览）、`specs/module-prompt-engine.md`、vitest 接入
- 迁移：`pi-adapter.ts`（-180 行，改为调用 `buildChatSystemPrompt`，工具描述经 `resolveToolDescription`）、`neutral-agent.ts`（提示词外迁，解析逻辑保留）、`visit-greeting.ts` / `push-scheduler.ts`（指令与兜底人设外迁，兜底链收敛为 `resolveAgentPersona` 单一入口）
- 新增接口：`GET /api/admin/prompts`、`GET /api/admin/prompts/fragment?id=`、`POST /api/admin/prompts/preview`（均走管理员鉴权）
- 测试：62 → 70 项（引擎单测 / 黄金快照 / 预览归化与路由）
- 既有文档中 `buildSystemPrompt()` 的引用指向 `prompts/`（见 `specs/module-prompt-engine.md`）

## D48：业务错误码契约——助记字符串枚举、wire 不发 message、全量一次迁移

**日期**：2026-09-29

**背景**：后端约 179 个 HTTP 错误点 + 7 个 SSE 错误发送点无错误码机制——9 种响应体形状变体、~90% 英文硬编码 + 15 条中文 + 中英混合插值，多处把 `err.message` 原样透传给终端用户，且无 `app.onError`（未捕获异常走 Hono 纯文本 500）。前端 `st()` 用 en locale `serverSide` 段（~200 条三语对照）做「英文句子 → i18n 键」反向翻译，中文消息与动态消息永远匹配不上；另有 5 处裸 fetch 绕过 `st()` 英文直出。

**决策**：

1. **助记字符串枚举**（`ErrCode.CONV_NOT_FOUND = 'CONV_NOT_FOUND'`，148 码 + `ERR_REGISTRY` 元数据），code 直接作为前端 i18n 键后缀 `errors.<CODE>`。
2. **wire 不发 message**：错误响应体只有 `{ code, params? }`；动态细节进 `params.detail`（截断 ≤300 字符），人类可读描述只在三语 locale，调试细节只在服务端日志。
3. **全量一次迁移**（8 个 commit 整批合入）：全部路由 + SSE + 前端消费端（含裸 fetch 收编、`st()` 与 `serverSide` 整体删除）。

**原因**：

- 字符串码 vs 数字位段（`0x10000000` 式）：码即 i18n 键、日志可 grep、curl/网络面板自解释，省掉一层注册表外的前缀解析；枚举成员名保留助记性与 IDE 补全
- 不发 message vs 附带默认英文句：避免「code 与 message 双真相」漂移与泄漏面（未捕获异常的 err.message 曾直接上屏）；代价是三语全覆盖——由一致性测试把关 + `errors.__unknown` 兜底（未知码显示 `操作失败（{{code}}）`）
- 全量 vs 渐进双形状：自部署同仓同发、web 是 REST 错误体唯一消费者（im 渠道与 SSE 中继均无外部消费），过渡期兼容层是纯成本；`st()` 与 errorCode 并存是最差状态
- status 放 shared 的 `ERR_REGISTRY`：错误码的 HTTP 语义就是 API 契约的一部分，server 默认状态 / web 状态分支 / 一致性测试三处共用单一来源

**备选与权衡**：

- ❌ 数字位段错误码：紧凑但不可 grep，i18n 键需额外映射层
- ❌ wire 保留英文 message 作兜底：双真相必然漂移；未知码场景用 `__unknown` 模板 + code 展示已足够
- ❌ 渐进迁移（先核心模块、`st()` 保留兜底）：双轨期两套翻译机制并存，中英混杂问题只有全量才能清干净
- ⚠️ 行为变化点：`upload` 路由会话不存在 403→404（统一语义）；`WECHAT_QR_FAILED` 与 `AI_*` 引入精确 502/504；群聊降级气泡去掉动态英文后缀

**影响**：

- 新增：`packages/shared/src/errors.ts`（148 码 + 注册表）、`apps/server/src/lib/apiError.ts`、`apps/web/src/lib/apiError.ts`、`i18n` 的 `errT()`、`docs/specs/module-errors.md`、`errors.contract.test.ts` + `error-registry-i18n.test.ts`
- 迁移：20 个路由文件 + 2 个中间件 + `provider`/`pi-adapter`/`group-orchestrator` + `config-transfer`（ImportIssue 换 code）+ `rateLimiter`（结构化秒数）；前端 16 个展示文件 + 5 处裸 fetch；三语 locale 增 `errors.*`（~150 键，约 60 条自 `serverSide` 平移）删 `serverSide` 整段
- 修复顺带：`ChangePinDialog` 无视真实错误固定显示「PIN 不正确」；`workflow.lawsFailed` 单花括号
- 详见 `docs/specs/module-errors.md`

---

## D49：会话文件下载路由 /api/workspace → /api/files 让路 + 永久别名

**日期**：2026-09-30

**背景**：新增「会话分组工作区」功能需要 `/api/workspaces` 命名空间，与既有「会话文件沙箱」下载路由 `/api/workspace/:conversationId/file/*` 存在词汇冲突。用户明确授权「必要时原 /api/workspace 要让路」。

**决策**：旧路由迁移为 `GET /api/files/:conversationId/file/*`（`routes/files.ts`，前身为 `routes/workspace.ts`）；旧前缀 `/api/workspace` 作为**永久别名**挂载同一路由；新功能用 `WS_*` 错误码前缀（`WS_NAME_REQUIRED`/`WS_NOT_FOUND`），文件沙箱沿用 `WORKSPACE_*` 错误码**不改名**。

**依据**：
- 旧 URL 被持久化在用户数据里：`routes/upload.ts` 生成的 `/api/workspace/...` 存入 `messages.attachments` JSON，`document-tools.ts` 的 `downloadUrl` 随 tool_calls/trace 落库——直接改名不保留别名则历史消息里的图片/工具产物全部 404
- 改写存量 JSON 列（REPLACE）违背「零数据迁移」哲学，且用户正文可能粘贴过该前缀字符串，误伤风险不可控
- 前端零改动成本：全仓核实无任何前端硬编码 `/api/workspace`，只透传服务端返回的 downloadUrl
- 错误码是 wire 契约标识符而非词汇表：改字符串值只产生 churn（errors.ts + 注册表 + 三语 ×3 + 一致性测试），无功能收益

**影响**：
- 新生成的 URL 一律 `/api/files/` 前缀；历史 URL 靠别名 + `parseWorkspaceUrl` 正则双前缀兼容
- **移除别名前必须先做数据迁移**（此为永久承诺，见 `docs/specs/module-workspace.md`）
- 顺带修复存量缺陷：`chat.ts` 的 `parseWorkspaceUrl` 旧实现按 `split('/')` 位置解析，与上传 URL 实际形态（`/file/__uploads__/`）自诞生起即不匹配、恒返回 null（AI 侧附件解析静默失败为「文件未找到」）——重写为显式正则并兼容新旧前缀

---

## D50：会话工作区——workspace_id 创建时锁定永不 UPDATE、删除悬空渲染、磁盘永不迁移

**日期**：2026-09-30

**背景**：需要会话分组（文件夹）能力，且**同一工作区内的会话共享文件沙箱**。会话是否可移动到工作区、删除工作区时文件怎么办，是本决策的核心权衡。

**决策**：
1. `conversations.workspace_id` **只在创建时写入，永不 UPDATE**——会话创建时锁定一个工作区（或未分组），之后不可移动（用户明确要求：「因为产生的文件都在工作区里」）
2. 删除工作区 = 单行 `DELETE FROM workspaces`；成员会话的 `workspace_id` **悬空**（原样保留），前端按未分组渲染（防御性过滤）；沙箱仍锚定原 `ws-<id>` 目录——文件照旧可访问、旧共同体成员之间仍共享
3. 沙箱根解析：`workspace_id` 非空 → `data/workspaces/ws-<id>/`（共享），NULL → `data/workspaces/<convId>/`（私有）；磁盘目录**永不删除、永不迁移**
4. 会话「删除」在 UI/API 语义上改称**归档**（本就是 `deleted_at` 软删除，名实相符）

**依据**：
- **移动会话 = 文件迁移困境**：共享目录中的文件无法归属单一会话，迁移要么同名覆盖（灾难）、要么全量拷贝到每个成员（配额爆炸），且（sql.js 时代）本地库无可用事务、中途失败产生半迁移状态——「不可移动」从根上消灭了这一类问题。（注：D61 换 node:sqlite 后本地已具备事务能力，但为同步回调，与现有 async 迁移结构不兼容；「不可移动」决策的核心理由是文件归属，不受影响）
- **删除工作区不置 NULL 会话行**：保持「单行 DELETE」的原子性（无事务下最安全）；悬空值 + 前端防御渲染达到与「UPDATE 置 NULL」相同的 UI 语义，却不触碰成员数据
- **磁盘永不删**：避免不可逆数据丢失；重建同名工作区 = 新 id 新目录，无复活歧义
- `ws-` 前缀隔离 workspace id 与 conversation id 两个 UUID 命名空间，人肉可辨可 grep

**影响**：
- 新增 `workspaces` 表 + `conversations.workspace_id` 列（双方言幂等迁移）；`/api/workspaces` CRUD + 三处会话创建链路注入（chat 首条消息 / worlds / conversations）+ `GET /api/conversations/search`
- `SandboxFS` 构造函数私有化，改经 `forConversation()` 工厂解析沙箱根（6 个调用点全部切换）；配额（100MB/500 文件）语义变为**每共享目录一份**（全组共享额度，同名文件后写覆盖先写——共享文件夹的本意）
- 草稿态（单聊/群聊）以 `draftWorkspaceIdRef` 随首条消息锁定工作区；草稿上传附件提前建会话时同样携带
- 详见 `docs/specs/module-workspace.md`

---

## D51：移除思考模式开关（恒开）+ 输入框工作区下拉取代侧边栏工作区内新建

**日期**：2026-09-30

**背景**：两个 UI 冗余：① 输入框的「深度思考」开关在实践中从不关闭（推理质量普遍优于省下的延迟），却占据常驻按钮位；② 侧边栏工作区行的「在此工作区新建会话」+ 按钮，与输入框的常驻操作位功能重叠。

**决策**：
1. 移除输入框「深度思考」开关，`thinking_mode` 客户端恒发 `true`（服务端本就 `thinking_mode !== false` 默认开启，wire 契约不变，IM 渠道不受影响）
2. 原位替换为**工作区下拉**：草稿态（无活动会话）选择新会话的目标工作区；已有会话禁用并展示归属（`workspace_id` 锁定不可移动，D50）
3. 删除侧边栏工作区行的「在此工作区新建会话」按钮——其职能由下拉完全接管
4. 前端状态从「每草稿一把锁」（`draftWorkspaceIdRef`，建草稿时写入）改为**单一选择**（`useChat.newChatWorkspaceId`，state + ref 镜像）：显式新建草稿、首页隐式草稿、群聊草稿（新工作流对话框的选择同步进来）共用；选择是粘性的（记住上次选择），登出重置

**依据**：
- 恒开思考：删除开关比保留「永远为真的开关」诚实；服务端默认语义（省略即真）早已覆盖所有非 Web 渠道
- 下拉取代侧边栏按钮：新建会话的意图发生在输入侧（写第一条消息时），工作区选择放在输入框里离决策点最近；侧边栏按钮要求先建工作区再悬停找 +，可发现性差
- 单一选择替代草稿锁：草稿本来就无法回访（无 hash、无切换入口），「每草稿一把锁」与「全局一个选择」在可观察行为上等价，后者少一个状态源、下拉展示值与建会路径天然一致（无错位窗口）
- `asWorkspaceId` 运行时守卫保留：下拉 onValueChange 与「(id?) => void → () => void」的宽松赋值仍可能漏进 DOM 事件（337e83e 的教训），守卫是唯一兜底

**影响**：
- `useChat`：`draftWorkspaceIdRef` 移除，导出 `newChatWorkspaceId` / `setNewChatWorkspace`；`createConversation` 去掉 workspaceId 形参（目标工作区读全局选择）；`startGroupDraft` 的显式选择同步进全局选择
- `App.ensureConversation`（草稿态上传提前建会）改读 `newChatWorkspaceId`，与首条消息建会路径同源
- i18n：删 `chat.deepThinking`、`sidebar.newInWorkspace`，增 `chat.workspacePicker`
- 已有会话的下拉禁用展示悬空工作区时按未分组渲染（与侧边栏防御语义一致）


---

## D52：会话状态条——会话累计消耗 + 「最近一次生成」的耗时/上下文快照（估算退化 + 服务端权威发放）

**日期**：2026-09-30

**背景**：输入框下方要回答四个问题——这个会话**一共烧了多少 token**、这一轮等了多久、生成有多快、上下文有多满。三个约束把这件事变复杂：① OpenAI 兼容网关**大多不在流式响应里带 usage**（`include_usage` 不是通用约定），部分数据得同时有「真值 / 估算」两条路径；② 空回复搬迁重试会让「同一轮生成」内部出现一次报废的尝试；③ 状态要在多设备上显示，而任何两份并存的快照都会立刻引出「谁更新」的问题。

**决策**：
1. **快照口径 = 最近一次生成**（耗时 / 上下文 / tok/s / 轮 / 步 每轮覆盖写，同一会话连发两条消息不累加）；**唯一例外是累计消耗 `totalTokens`，它跨生成累加且只增不减**（见 8）
2. **状态条显示 `durationMs`（本轮生成墙钟），而不是轮/步**：单聊 = AI 循环段（含工具执行与重试），群聊 = 整轮编排（含发言裁决）。轮/步 作为**诊断字段**保留在快照里（将来做生成中实时进度或诊断面板要用），但不上 UI
3. **轮 = LLM 调用次数（`streamFn` 调用次数），步 = 工具执行次数（`tool_execution_start`）**：都是「发生即计数」，不看 `turn_end` / `tool_execution_end`——成败不改变计数；无工具调用的会话步数恒为 0，属正常而非计数缺失
4. **上游无 usage 时退化为字符估算**（`tokens.ts`：CJK ≈0.6 tok/字、其余 ≈1 tok/4 字符）：估算只体现为数据里的标记（`estimated` / `totalEstimated`），**状态条不渲染任何 `≈`**（只列裸数字）；**`estimated` 必须与 `contextTokens` 同源**（群聊聚合里一处取 last、一处取 some 就会把真值错标成估算）
5. **空回复搬迁重试 = 整体作废**：轮/步/用量累计器（`GenUsageAcc`）一起清零
6. **上下文窗口单一真源**：管理端 `context_window`（缺省 128000）同时喂 Pi 循环的 `model.contextWindow` 与状态条百分比的分母
7. **状态由服务端权威发放，客户端不参与裁决**：快照只在两处发放——生成结束的 `stats` SSE 事件、会话详情 `GET /api/conversations/:id`；**列表端点不携带 stats**。客户端一律原样覆盖（`storeServerStats`），不比较、不合并、不判新旧，快照里因此**没有时间戳字段**
8. **累计消耗 = 账单口径**：`totalTokens` = Σ 每一次 LLM 调用的（输入 + 输出），跨所有生成、所有轮次累加——**含每轮重发的整个上下文**，含思考（属 completion）。快照每次覆盖写，而该值**只增不减**
9. **首次落库用历史粗估回填**：存量会话从 0 起算会明显偏小 → 快照里还没有 `totalTokens` 时用 `estimateHistoricalBill` 粗估历史起点，并让该会话的累计**永久标记为含估算**（`totalEstimated`，只进数据不上 UI）
10. **各渠道共用同一个落库入口**（`lib/stats-store.ts`）：网页 / QQ / 微信——累计必须覆盖所有渠道的生成，否则绑定 IM 的会话在网页端会显示偏小的数

**依据**：
- **重试并入会一连算错四个字段**：作废轮的轮数被计入；tok/s 用「作废轮 completion ÷ 重置后的时长」虚高；上下文取到作废值；`hasUsage` 残留让估算标记消失——一个没清干净的残留值污染整个状态条
- **发放权不下放客户端**：最初想过让客户端在「实时值 vs DB 快照」之间判新旧（时间戳晚者胜），也想过给列表响应加请求序号。两者都是把「谁更新」的判断交给客户端——一旦状态有两个来源、又要客户端裁决，就得为它设计一套排序规则，而这套规则的每个边界都得再论证一遍。真正的根因是**发放面太宽**：列表刷新频繁（`conv_sync` / `unread_update`），把快照塞进列表就等于给状态条开了第二个来源。收窄到「生成结束事件 + 会话详情」两个发放点后，客户端只需原样接收，时间戳与序号都不需要了
- **代价明写在契约里**：客户端不纠正乱序（迟到的详情响应可能带着上一代快照），等下一次发放收敛；有序性由服务端负责。这是「客户端不替服务端裁决」的自觉代价，不是遗漏
- **为什么不显示轮/步**：`步` 与界面**重合**——它恰好等于本轮工具气泡数（`tool_execution_start` 与气泡一对一），用户能自己数；`rounds` 反而**制造疑问**——界面上没有它的对应物，唯一沾边的是 thinking 里的「思考片段 N」，而那只覆盖**产生思考的轮**，于是会出现「条上 4轮 vs 正文片段 1..3」的自相矛盾；群聊下它是各成员之和（3 个 Agent 各 2 轮 → `6轮`），可用户并未经历「6 轮」。且两者都**不能当进度用**：快照只在生成**结束**时发放一次，生成中显示的是上一轮的数。换成 `durationMs` 后自解释、零歧义、不冗余，与上下文占用%一起回答「为什么等这么久 / 花了多少」。字段仍留在快照里，因为代价近乎为零（同一列 JSON 里两个整数）而诊断价值真实
- **哪些字段是「当场捕获」而非「算出来的」**：`tokensPerSecond` 的分母（每轮纯流式时长）、`durationMs`（墙钟——请求早已结束，事后无从复得）与 `contextTokens` 的真值（上游 usage）在 DB 里没有任何别的痕迹，只能当场捕获；`steps` 事后可从 `messages.trace` 精确数出，`rounds` 只能靠 thinking 分段近似（没产生思考的轮会漏）。整份落库不是因为「算不出来」，而是口径是「最近一次生成」——这个边界只有当场知道，且列表/详情要 O(1) 读出
- **估算而非留空**：状态条的价值在趋势；token 估算误差（±20%）远小于「这一格没有数」
- **窗口只留一处**：Pi 侧与前端百分比分母各持一份，会出现条上写着 45% 而循环按另一套窗口判断的自相矛盾
- **为什么是账单口径（而非「内容各计一次」）**：模型 API 计费的就是「这次请求带了多大的输入 + 产出多少」，而 agent 循环每轮都要把整个上下文重发一遍——一轮里调 3 次工具再回答，同一段上下文就被计了 4 遍。按「内容总量」口径（会话内容各计一次）更符合直觉，但那**不是消耗**，两者能差一个数量级（同一例：约 50K vs 约 190K）。状态条要回答「这个会话烧了多少」，所以取账单口径
- **为什么回填而不是从 0 起算**：累计是这项能力上线后才开始记录的，存量会话（几十条历史）从 0 起算会显示明显偏小的数——那不是「精确」，是缺了一半还装作完整。回填只是粗估（字符估算、缺历史 thinking、系统提示词取当前值），所以该会话的累计**永久标记为含估算**（`totalEstimated`）
- **为什么不做用量流水表**：累计是「读旧值 → 加增量 → 写回」的 RMW，同一会话真并发两个生成（网页双设备同时发；IM 侧有 `im/locks.ts` 的会话锁、网页侧无锁）理论上会丢一次增量。彻底的解法是「每次生成追加一行用量流水、总额读时求和」（无竞态、可审计），代价是新表 + 双方言迁移 + 读取聚合；而这里丢一次增量的概率极低、影响面仅一个会话的一个数字。取舍记录在此，真出问题时按此改造

**影响**：
- `ConversationStats` 进入 `packages/shared/src/types.ts`；新增 `conversations.stats` TEXT 列（SQLite / PG 双方言幂等迁移）
- 新增 `apps/server/src/ai/tokens.ts`（字符级估算）、`apps/server/src/ai/conversation-stats.ts`（累计口径纯函数）与 `apps/server/src/lib/stats-store.ts`（落库口，三渠道共用）
- `genUsage` 扩展为 `{ outputTokens, streamMs, billTokens, billEstimated, priorBillEstimate }`，群聊编排器返回同形聚合体
- 新增 `stats` SSE 事件；`GET /api/conversations/:id` 反序列化返回（**列表端点不返回**，见上）；`AppConfig.context_window` + 管理端「模型上下文窗口」设置项
- 计时点：`pi-adapter` 记 `loopStartedAt`（AI 循环前）→ `durationMs`；`group-orchestrator` 记 `groupStartedAt`（整轮编排）→ 群聊口径
- IM 三处（QQ C2C / QQ 群 / 微信）：回复落库后广播 `stats` 事件并调落库口——IM 侧的消耗计入会话累计
- `useChat`：新增 `storeServerStats`（唯一的写入点，原样覆盖），在 SSE `stats` 事件、`loadConversation`、`conv_changed` 对账、流收尾对账四处接收；`renamePartition` 迁移该分区
- `InputBar` 状态条：`工作区 | 累计 N tok | 耗时 · tok/s | 上下文 P%`；`formatTokenCount` 支持 `M` 级；存量快照缺字段的簇整簇隐藏
- 回归测试：`apps/server/test/stats.test.ts`（15 断言，伪造 fetch 驱动真实 `runPiAgentLoop`）+ `apps/server/test/conversation-stats.test.ts`（12 断言，纯函数），均不依赖 .env / 数据库 / 磁盘
- 契约见 `docs/specs/module-chat.md`〈会话状态条〉


---

## D53：配置导入导出纳入网关段（含明文 api_key）+ 端到端 PIN 二次校验

**日期**：2026-09-30

**背景**：`buildExportBundle` 只导出 `experience / agents / users` 三段，并在代码、类型、文档、测试四处明文写着「**绝不导出** api_endpoint/api_key」。结果是换机器或灾备时，最关键的网关配置（端点、密钥、上下文窗口、4 个开关）反而要手抄——bundle 自称「跨实例迁移」工具，却恰好搬不走迁移时最需要的那部分。另外两处版式问题同类：后台「配置」页挂在「网关」下方，而它承担的是整机迁移这类更高层动作；网关页的「模型上下文窗口」被 4 个功能开关与「端点/密钥」隔开，同属连接参数的两项不挨着。

**决策**：
1. 新增顶层 `gateway` 段（7 字段，与网关页一一对应），导出**生效值**（`map.get(key) || env.*`），**含 `api_key` 明文**
2. `BUNDLE_VERSION` 保持 1——新段是可选增量，旧文件照常通过校验；升到 2 会让 `version !== BUNDLE_VERSION` 拒收所有既存文件
3. 应用顺序改为 `gateway → experience → users → agents`，且 gateway 单独占一次 `updateConfig`，**不可与 experience 合并**
4. 导出与导入的**正式落库**都需 PIN 二次校验；**每次导出都重新验**，导入的 dry-run 不验
5. 导出端点 `GET` → `POST`（PIN 放请求体，不进 URL/日志）；导出/导入两个端点加入前端 `CREDENTIALS_ENDPOINTS`
6. 侧边栏「配置」上移到「网关」之上（默认落地页仍是网关）；网关页 `context_window` 上移到 `api_key` 之下
7. `gateway.api_endpoint` **不做** URL 形态校验

**依据**：
- **为什么要推翻「绝不导出密钥」**：那条不变量的收益是「文件可安全分享」，代价是灾备不完整——而真正被需要的是换机，两者不可兼得时取迁移完整性。且这**不是新增暴露面**：`GET /api/admin/config` 早已明文回传 `api_key`（`module-config.md`〈API Key 未脱敏〉记录了这条既有事实）。既然密钥在会话里本就明文可见，旧不变量掩盖的其实是「导出」这个**动作**，而不是密钥的存在——真正该补的是对这个动作的身份确认，而不是假装密钥不外流
- **为什么是 PIN**：复用既有的 `verifyPin` + IP 失败计数，零新错误码、零新表、零新失效逻辑。代价必须承认：导出把密钥从「会话内的一个响应」变成「落盘的文件」——可离线传播、永不过期，风险等级确实更高，所以门禁加在动作上
- **为什么每次导出都验（否掉「验一次发短期令牌」）**：令牌需要新的存储与失效规则，而导出的频率本就极低（迁移/备份时），每次重输的摩擦可以忽略——用一套状态机换来的便利不值
- **为什么 dry-run 不验**：它不写库，摘要也只承载字段名（`ImportSummary` 的类型注释里写死这条）。把门禁挪到预检只会让反复试导变得难受，防线却一寸未增
- **为什么 gateway 必须最先落库**：`use_external_image_hosting` 决定后面 favicon/background/avatar 的 base64 是否转 CDN，而 `maybeUploadDataUrl` 实时调 `isExternalImageHostingEnabled()`——**直读 `settings` 表，不走 config 缓存**。上传判定发生在任何写入之前，因此「同一份文件既开图床又带 base64 图片」只有在开关先落库时才成立；合并成一次 `updateConfig` 会静默失效
- **为什么 `api_endpoint` 不校验 URL 形态**：`PUT /api/admin/config` 本身零校验，且 `.env` 里 `localhost:11434/v1` 这类无 scheme 写法很常见——强求 http(s) 会让**自家导出的文件被自家拒收**。`isHttpUrl` 是给图片值与 OIDC URL 写的，不该扩用到此处
- **为什么导出「生效值」而不是 `settings` 原始行**：后者不泄露 `.env` 密钥，但 `.env`-only 实例导出的文件对迁移毫无用处，与需求直接冲突。代价（`.env` 密钥被带走 + 目标实例的该值被钉住、此后改 `.env` 不再生效）记录在 `module-config.md` 的导出范围一节与本条决策里，而不是留作暗坑——**不**占用界面文案：导出页的警示只保留一句「导出文件含 API 和 OIDC 密钥，请谨慎保管该文件。」（三语同款短句）
- **为什么 `BUNDLE_VERSION` 不升**：新段可选，v1 文件（无 gateway）仍全部有效；反之升 2 会拒收所有既存文件，而「向前兼容」本来就做不到——新文件打到旧服务端会撞顶层白名单报 `UNKNOWN_TOP_KEY`，报错信息比 `BAD_VERSION` 更具体，没有损失

**影响**：
- `packages/shared/src/types.ts`：新增 `ConfigExportGateway`、`ConfigExportBundle.gateway`、`ImportSummary.gateway`
- `packages/shared/src/errors.ts`：新增 4 个 `CONFIG_IMPORT_*` 码（`UNKNOWN_GATEWAY_KEY` / `BAD_API_ENDPOINT` / `BAD_API_KEY` / `BAD_CONTEXT_WINDOW`）；**`BAD_API_KEY` 刻意不带 params**，避免模板插值把密钥回显进错误消息。`error-registry-i18n.test.ts` 的码数基线 150 → 154
- `lib/config-transfer.ts`：`GATEWAY_KEYS`、`validateGateway`、`computePlan`/`planToSummary` 增 gateway、`applyImportBundle` 首步写 gateway
- `routes/admin.ts`：`requirePin`（standAlone 短路）、export 改 POST 并加 `Cache-Control: no-store`、import 在落库前 `requirePin`
- `lib/api.ts`：`exportConfig(pin)` / `importConfig(content, pin)`；`CREDENTIALS_ENDPOINTS` 增两条（否则一次 PIN 打错会被通用 401 路径清会话登出）
- `ConfigTransfer.tsx`：新增 `PinForm`——导出用独立弹窗，导入在预检弹窗内**原地切换**到 PIN 视图（不叠 Radix 弹窗）
- `AdminSidebar.tsx`：`ADMIN_TABS` 顺序；`GatewaySettings.tsx`：`context_window` 上移
- i18n 三语：4 个 `errors.*`、`configSummaryGateway`、`configPin*`；**改写** `configExportDesc` / `configExportSecretWarn`（原文写着「不包含网关密钥与 API Key」，已为假）
- 测试：`config-transfer.test.ts` 48 项（导出白名单断言由「不含」翻转为「含」；**fake 的 `updateConfig` 必须联动 `externalHosting`**，否则顺序断言测不出东西）
- 文档：`module-config.md`（导出范围/校验规则/接口契约/应用顺序/PIN 门控；顺带订正 `support_attachments`、`support_infinite_mode` 的默认值——代码是 `!== 'false'` 即默认 true，文档原写 false）、`module-admin.md`（面板小节已过期：写「6 个标签页」且含 `Branding`，更正为当前 8 个 tab 与实际顺序）

---

## D54：生成式卡片（Intelligent UI）——Chat Components 范式、每组件族一工具、trace 零迁移持久化

**日期**：2026-10-09

**背景**：OpenAI 2026-10 随 GPT-6 推出 "Intelligent UI"（模型在聊天流中直接渲染交互式界面）。Momoi 计划以此统一 mermaid 绘图、数据卡片、minigame 三类能力的交付底座，并补齐「用户与 AI 生成的 UI 交互后回流模型」能力。OpenUI 逆向显示 ChatGPT 的实现是专用声明格式（DIL = Markdown + JSX 风格标签 + 内嵌状态逻辑）+ 服务端周期性全量重编译 + `issueNewTurn` 回流——该路线以模型针对性训练为前提，且已知缺陷多（重发冗余、刷新丢状态、逻辑错误静默）。

**决策**：
1. 采用 **Chat Components 范式**：模型经 `ui_*` 工具调用声明卡片（组件名 + schema 约束的结构化 props），服务端权威校验，SSE 推送 + trace 持久化，前端注册表懒加载渲染
2. **每组件族一个工具**（ui_chart / ui_stat / ui_table / ui_diagram，分期扩至 form / app / character），统一 `createCardTool(spec)` 工厂 + `catalog.ts` 单源（工具定义 / 提示词目录 / 文档三处同源）
3. **捕获点唯一**：`tool_execution_end` 分支捕获 `details.data.card` → trace 条目 + SSE `card` 事件（先于同次 `tool_result`）；不用 onUpdate 通道（执行 <1ms 无挂起前推送需求，且与持久化点分离会成双源）
4. **持久化零迁移**：复用 `messages.trace` JSON 列新增 `{ type: 'card' }` 条目变体——重放链路（conversations 解析 → mapServerMessage → groupAndRenderTrace）全部既存
5. **交互回流（M2）**：card-action 以 ```` ```card-action ```` 围栏进 user 消息 content（D5 suggestions 先例），**不建新端点**——前端合成协议消息走既有 `POST /api/chat` 的 SSE 管道
6. 前端注册表手写轻校验（**否决 zod**）；图表颜色由前端固定色板分配（模型不可指定），双模式过 dataviz 校验器

**原因**：
- **LLM 只能看到文本**——任何结构化 JSON 列在回喂时都要再序列化成文本注入，列只是冗余副本；围栏方案模型回喂天然可见、多设备中继免费、零迁移（决策 5 的决定性论据）
- 交互回流的新一轮响应就是 `POST /api/chat` 的既有 SSE 流——专用端点要么把 650 行 streamSSE 抽出为共享函数（高风险重构），要么前端复制约百行流处理
- typed schema 对弱模型的约束显著优于自由形状 props；每组件族一工具的独立描述可经 `tool/<name>` 片段单独覆盖
- trace 列已存在；新列方案需 4 处迁移 + 回填 + 导出/中继适配，收益为零

**备选与权衡**：
- ❌ DIL 式专用格式：需模型针对性训练，与多模型 OpenAI 兼容平台定位冲突
- ❌ 单一 `render_ui` 工具（component enum + 自由 props）：props 只能映射为自由对象，弱模型字段名幻觉率高；**协议层已按此兼容设计**——未来 ui 工具超 ~12 个时收敛为单工具，只换进料口
- ❌ 新 JSON 列存交互事件：冗余且多处适配（见「原因」）
- ❌ zod 前端校验：新依赖 + 与服务端 ToolSchemaProperty 双 schema 维护；唯一权威校验在服务端
- ❌ recharts 系 manualChunks（vendor-chart）：Rolldown 会把强制块的**传递依赖闭包**（实测含 react / react-dom / clsx）吸入该块，导致入口静态预载整个图表块；交给默认拆分后 recharts 随卡片懒加载（~99KB gzip，仅首个图表卡拉取）
- ⚠️ 回喂注入（M2）：模型现状连历史工具调用都不可见（saveAssistantMsg 不写 tool_calls 列）——卡片摘要注入是补齐 UI 状态感知而非泄漏，否则「把刚才的柱状图改成折线」类请求无法完成；每卡 ~15 token

**附带修复**：`jsonSchemaToTypeBox` 忽略 `required` 参数——TypeBox 默认所有属性必填，多可选字段工具（如 ui_chart）必然校验失败且无法执行；现按声明包裹 `Type.Optional`（既有工具一并恢复声明语义）

**影响**：
- `packages/shared/src/types.ts`：CardComponent / CardDescriptor / CardActionPayload；TraceEntry card 变体；ServerMessage card 事件
- `packages/shared/src/{constants,schema-validate}.ts`：CARD_ACTION_FENCE；ToolSchemaProperty 子集通用校验器（新导出入口 `@momoi/shared/schema-validate`）
- `apps/server/src/tools/ui-cards/`：catalog 单源 + card-tool 工厂；registry 注册 4 个工具
- `apps/server/src/ai/pi-adapter.ts`：tool_execution_end 捕获；TypeBox Optional 修复
- `apps/server/src/prompts/fragments/chat.ts`：chat/ui-cards 片段（capabilities 层；golden 快照全量更新）
- `apps/web/src/components/cards/`：注册表 + CardRenderer / CardFrame / CardErrorBoundary + chart/stat/table/diagram 四组件；MessageBubble trace 分支；useChat card case；globals.css 色板；useDarkMode
- 测试：schema-validate / card-tool / card-sse 三个新测试文件（server 213 全绿）
- 文档：`specs/module-intelligent-ui.md`（新，M1-M5 完整契约）、`module-chat.md`（SSE 表 + 行为约束 18）、ARCHITECTURE / PRD 增量

---

## D55：表单卡本地实时计算——受限公式 DSL（parse/eval 同源）、无 eval、本地交互不回传

**日期**：2026-10-09

**背景**：M2 交互闭环将一切表单提交都回传给模型。但「无状态工具」类卡片（汇率换算、单位换算、贷款月供等）的本质是**确定性小工具**：模型在声明期提供数据（汇率/系数）与公式，用户交互在卡片内即可算出结果——回传模型既慢（一个完整 LLM 往返）又贵（消耗轮次），且与 ChatGPT Intelligent UI 的既有事实相悖（其本地交互完全不离开响应，只有显式新回合动作才回流）。

**决策**：
1. `ui_form` 增加可选 `compute` 配置：`{ formula, tables?, resultLabel?, resultUnit? }`——配置后卡片进入**计算模式**：输入变化即时求值、结果行实时显示（**不消耗对话轮次**）；提交按钮变为「发送给 AI」，把字段值与 `result` 一并带回模型
2. 公式为**自研受限 DSL**：数字、字段名变量、`+ - * / ^`、括号、一元负号、`ROUND(x, n)`、`LOOKUP(字段, 表名)`；数据经 `tables` 内联（键 = select 选项值）
3. **解析器与求值器置于 `packages/shared/src/formula.ts`**——服务端声明期校验（语法/未知字段/未知表/表名重复 → 自修复错误），浏览器端求值；单源同构
4. 求值失败（缺值/非数值/除零/查无键/溢出）一律返回 `null`，UI 显示「—」——绝不上屏半成品数值、绝不抛错
5. 计算模式**不锁定已消费**（常驻小工具，可反复调参、随时再发送）；结果经 `CardActionPayload.result` 随协议回传

**原因**：
- 无状态工具的正确形态是「模型声明数据与公式，UI 本地计算」——回传模型对这类场景是纯浪费；计算是确定性的，本地结果与模型算的别无二致，且即时
- 不用 `eval`/`Function`：手写词法 + 递归下降约 250 行，产物只有算术，天然无注入面；同时因为要**同源**（服务端校验 + 浏览器求值），字符串替换类偷懒方案不可维护
- 刻意不做通用表达式语言（无比较/条件/字符串运算）：语法面每大一分，模型作者错误率与自修复成本就涨一分；长尾计算需求留给 AppBlock 逃生舱（M4）

**备选与权衡**：
- ❌ eval/Function 求值：注入面，且服务端无法安全校验
- ❌ 固定算子库（汇率/单位专用组件）：组合爆炸，每个新工具都要发版
- ❌ 自由 JS/自然语言公式：违背 Chat Components 的 schema 约束原则
- ⚠️ 字段/表名沿用标识符 pattern，故字段名不可为 `ROUND`/`LOOKUP`（工具描述已提示）

**影响**：
- `packages/shared/src/formula.ts`（新）与 package.json 导出；`types.ts` 的 `CardActionPayload.result`
- `apps/server/src/tools/ui-cards/catalog.ts`：compute schema + 声明期校验 + 描述更新（golden 重生成）
- `apps/web/src/components/cards/form/FormCard.tsx`（计算模式）；`cardInteractionStore` / `useGroupChat` / `CardActionChip`（result 透传）；i18n 三语 3 键
- 测试：`formula.test.ts`（12 例）+ card-tool compute 5 例，server 242 全绿

---

## D56：生成式卡片仅限网页版——IM 渠道结构性关闭（工具 / 提示词 / 历史三重门）

**日期**：2026-10-09

**背景**：M3 原设计是「补齐 IM 渠道 trace 持久化，让 IM 触发的卡片刷新不丢」。产品决策反转：IM 渠道（微信 / QQ）**不开放**生成式卡片——卡片是网页版独享能力。IM 的载体（微信 / QQ 消息流）没有卡片渲染位，触发卡片对 IM 用户意味着「回复里少了一段内容」，只会制造困惑与无效的工具轮次。

**决策**：
1. **撤回 M3**（`git revert`）：微信 / QQ 链路恢复为不写 trace、不做卡片历史注入（回到卡片特性之前的语义）
2. `RunPiAgentLoopOptions` 增加 `uiCards?: boolean`（缺省 true）——IM 渠道传 `false`，**三重门**同时生效：
   - **工具**：`createToolAdapter` 剔除全部 `ui_*`（`ToolContext.uiCardsDisabled`，仿 `memoryDisabled` 模式）
   - **提示词**：`chat/ui-cards` 片段不注入（上下文 `uiCards: []`）
   - **历史**：`augmentRowsWithCards` 不套用（模型看不到历史卡片摘要）
3. 网页版（单聊 / 群聊 / 世界）不受影响，全量能力保留

**原因**：
- **结构性关闭优于「触发但不显示」**：模型不知道卡片存在 → 不会承诺、不会调用、不会产生「看不到」的 UI；IM 用户始终拿到完整可读的文本回复
- 三重门缺一不可：只关工具，模型仍会从目录 / 历史知道卡片并试图讨论；只关提示词，模型仍有工具可调
- 闸门走既有 `memoryDisabled` 同款模式（ToolContext 标记 + adapter 过滤），验证成本最低

**备选与权衡**：
- ❌ 保留 M3（IM 触发、仅 web 端可看）：链路可行但产品上割裂——同一会话两个渠道能力不一致且用户难以理解
- ❌ 保留 IM trace 持久化（web 透明性收益）：与「IM 不开放」的叙事冲突，且会把渠道差异搅浑（web 端渲染 IM 消息的思考 / 工具栈）；已随 M3 一并撤回
- ⚠️ M1-M3 窗口期的 IM 会话可能已落库含卡 trace——保留不动：网页端渲染无碍，模型侧因三重门不再注入

**影响**：
- `git revert` M3 提交（820c4d1）；`ai/pi-adapter.ts`（选项 / 提示词上下文 / toolCtx / 工具过滤）、`tools/types.ts`（ToolContext）、`im/wechat/chat.ts` 与 `im/qq/chat.ts`（三处调用传 `uiCards: false`）
- 测试：card-sse 增 IM 闸门双用例（关闭 → 无法触发；缺省 → 仍触发）；golden 增结构性断言（`uiCards: []` → 目录块消失）
- 文档：module-intelligent-ui.md 的分期 / 工具面 / 行为约束 / 验收同步；`D55` 的 compute 能力同样仅网页版可用（受同一闸门约束）

---

## D57：AppBlock 沙箱——模型 HTML 按不可信内容处理（sandbox 最小集 + CSP + source 校验）

**日期**：2026-10-09

**背景**：M4 让模型交付自包含 HTML/CSS/JS 小应用（AppBlock 逃生舱）。模型生成的代码从安全视角看是**不可信内容**——可能因幻觉、提示注入或用户诱导而包含数据外传、凭据索取、越权访问。需要「即便内容恶意也不出事」的边界。

**决策**：
1. `ui_app` 工具：html（必填）/ css / js / height（64-960，默认 320）；三者合计 ≤64000 字符（工具级拒绝 + 精简指引）
2. **iframe 隔离**：`sandbox="allow-scripts"`（仅此一项）——无 `allow-same-origin` 即不透明源（无 cookie / localStorage / DOM 访问）；无 allow-forms / allow-popups / allow-top-navigation
3. **CSP**（srcDoc 内 meta）：`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: https:; font-src data:`——**无网络**（fetch/XHR/WebSocket 落 default 全断）、无外部脚本/样式；图片限 data: 与 https: 直链（与 markdown 图片现状同级）
4. **postMessage 校验**：不透明源 origin 恒为 `'null'` 无法鉴别，改以 `event.source === iframe.contentWindow` 身份校验；仅接受 resize 消息；height clamp [64,960]；v1 无 parent→app 通道
5. 主题变量（含 `--chart-1..8`）注入沙箱；主题切换重建 srcDoc（状态重置——v1 接受）
6. 自动高度：沙箱助手定义 `momoiResize()` + 加载/尺寸变化自动上报；`escapeClosers` 防 `</script>`/`</style>` 序列提前闭合注入块

**原因**：
- 三层边界各司其职：sandbox 防「越权」（跨源 / 存储 / 导航）；CSP 防「外传」（网络）；source 校验防「伪造」（其他窗口冒充 resize 消息）
- **无网络是关键取舍**：模型需要数据时内联（工具描述明示），换来数据外传与信标追踪的结构性不可能——即便脚本被诱导索取凭据，也没有网络可送达
- 与整体路线一致：模型输出永不进入可信执行路径（对照 ChatGPT DIL 的 sandbox + lockdown，用平台原生最小能力集达成同等级隔离）

**备选与权衡**：
- ❌ `allow-same-origin`（或省略 sandbox）：同源可达父文档 / cookie——等同于放弃边界
- ❌ 网络白名单代理：引入服务端中转与额外攻击面；内联数据已覆盖逃生舱的绝大多数场景
- ❌ `<webview>` / 自绘渲染器：平台兼容与工程量都不划算
- ⚠️ srcDoc 重建（主题切换）重置应用状态——v1 接受；未来若需保留，可为应用提供 postMessage 主题通道（v2 议题）

**影响**：
- `apps/server/src/tools/ui-cards/catalog.ts`：app spec + 64K 合计校验；golden 重生成（含目录行）
- `apps/web/src/components/cards/app/AppBlockCard.tsx`（新）+ registry 注册；独立懒加载 chunk
- 测试：ui_app 五用例（合法 / 合计超限 / 单字段超长 / 缺 html / height 越界），server 251 全绿
- 文档：module-intelligent-ui.md 增〈AppBlock 沙箱〉节与验收项

---

## D58：3D 角色卡——VRM + 三级降级、零资产默认示例、沿用无 manualChunks

**日期**：2026-10-09

**背景**：M5 收官——让模型在聊天里展示 3D 虚拟角色（VRM 模型 + 表情 + 动作动画）。Momoi 是角色扮演平台，3D 形象与角色扮演场景天然契合。

**决策**：
1. 技术栈：three@0.186 + @pixiv/three-vrm@3.5（含 three-vrm-animation）+ @types/three；全部经 `CharacterCard` 懒加载组件模块静态引入
2. **不做 manualChunks**（沿用 D54 的 Rolldown 依赖闭包教训）——默认拆分下三件套（约 195KB gzip）留在 CharacterCard 块内，无 3D 卡的会话永不加载
3. 资产约定：`apps/web/public/vrm/` 目录（文件名引用，随构建拷贝、不入 git）；`model`/`animation` 支持 https 直链；**省略 model 时加载 three-vrm 官方示例模型**——零资产开箱可验收
4. 动画优先级：`.vrma` → AnimationMixer 循环；失败/缺省 → 程序化 idle（正弦呼吸 + 微摆）
5. 降级三级：WebGL 探测（内联提示）/ 模型加载失败（局部错误视图 + 原因）/ 动画失败（warn + 回落 idle）
6. 性能与生命周期：DPR ≤2、离屏暂停 RAF、包围盒自动取景、卸载 deepDispose、路径禁 `..`
7. v1 无轨道控制（避免与页面滚动 / 触摸手势冲突）

**原因**：
- VRM 是动漫系虚拟角色的事实标准（人形骨骼 + 表情预设 + MToon 材质），three-vrm 是成熟的开源加载链路——表情/动作开箱即得；裸 glTF 则要自建全部人形约定
- 零资产默认示例模型让 3D 链路在没有用户资产的实例上也可验收（手工验收即依赖它）
- 三级降级把最坏情况限制成一张提示卡而非崩溃——与全项目容错基线一致

**备选与权衡**：
- ❌ Live2D：Cubism SDK 授权约束更强、工具链更封闭，且非 3D
- ❌ 裸 glTF + 手写骨骼动画：放弃 VRM 人形/表情标准，工程量爆炸
- ❌ 强制用户先放资产才可用：开箱不可验证；默认示例模型解决
- ⚠️ 示例模型托管于 pixiv.github.io——离线环境走 load-failed 降级（放本地资产即可消除外网依赖）
- ⚠️ 主题切换不重建 3D（透明背景自然适配明暗）——与 AppBlock 的 srcDoc 重建策略不同：场景重载代价过高，透明度已足够

**影响**：
- `apps/server/src/tools/ui-cards/catalog.ts`：character spec（required 为空——全可选）+ `..` 路径校验；golden 重生成
- `apps/web/src/components/cards/character/CharacterCard.tsx`（新）+ registry；`apps/web/public/vrm/README.md`（新）；i18n 三语 2 键
- 依赖（web）：three / @pixiv/three-vrm / @pixiv/three-vrm-animation / @types/three
- 测试：ui_character 五用例（合法 / 空参默认 / `..` 路径 / 权重越界 / 缺 name），server 257 全绿

---

## D59：3D 角色实时表演——语义手势库 + 姿态逃生舱、标准化骨骼一次编写全模型通用

**日期**：2026-10-09

**背景**：用户诉求——VRM 模型可预先提供，但**动作与台词应由 AI 实时演算**（不必为每个动作预先制作 `.vrma`）。台词自 D58 起已实时（`caption` 为每轮现写的 prop）；动作此前只能选现成 `.vrma` 文件。

**决策**：
1. `ui_character` 增 `acts`（≤8 个）——两种 act：`gesture`（从 **16 种语义手势库**选，配 at 起始秒 / times 重复）与 `pose`（**姿态逃生舱**：≤10 根骨骼欧拉角 ±135°、hold 保持秒数、`__root` 整体位移米）
2. 手势在 **VRM 标准化人形骨骼**上程序化实现——一次编写、全模型通用；词汇表在 `shared/constants.ts` 单源（`CHARACTER_GESTURES` / `CHARACTER_POSE_BONES`），服务端 schema 枚举与前端 `Record<CharacterGesture, GestureDef>` 编译期穷尽互证
3. 引擎语义：姿态 = 静止姿态 ∘ 欧拉增量，逐帧指数平滑趋近（进出场/段间切换自然软化）；同骨骼多段重叠后者覆盖；段外自动回归静止
4. 优先级：`animation`（.vrma）> acts > 程序化 idle；**animation 加载失败回落 acts**（此前回落 idle）
5. **面部朝向修正**：改用官方 `VRMUtils.rotateVRM0`（VRM0 转 +Z；VRM1 规范模型天生面向 +Z 为 no-op）——替换 D58 初版的手动 180° 旋转（该写法会让合规 VRM1 模型背对相机）
6. 轴向符号集中于 `gestures.ts` 的 L/R 常量——个别非规范模型可一处翻转

**原因**：
- 模型没有视觉反馈，直接写骨骼/四元数是**全盲作画**（汇率算错能重算，姿势算错就是章鱼）；语义手势把"好看"的表演由前端一次性做对，模型只做语义编排
- 结构上与整体设计**递归对称**：手势库 = 注册表（固定词汇保质量），pose / `.vrma` = 逃生舱（长尾定制）——用户明确采纳此双轨
- 标准化骨骼是 VRM 规范的硬保证（合规模型骨骼名/坐标一致），"一次编写全模型通用"由此成立

**备选与权衡**：
- ❌ 仅原始姿态 DSL：盲写必然大面积不自然（用户选项中被否）
- ❌ 仅手势库：长尾表演（特定剧情姿势）无出路（用户选择双轨）
- ⚠️ 手势幅度/轴向按规范推导、**未经视觉校准**——常量集中可调，验收时按实物微调
- ⚠️ 无 TTS 口型联动（用户本期选择不做）：caption 仅文字显示

**影响**：
- `packages/shared/src/constants.ts`：CHARACTER_GESTURES（16 种）+ CHARACTER_POSE_BONES（20 根 + `__root`）
- `apps/server/src/tools/ui-cards/catalog.ts`：acts schema + 编排校验；golden 重生成
- `apps/web/src/components/cards/character/gestures.ts`（新：手势库 + 时间轴引擎）；CharacterCard 表演层 + rotateVRM0 修正
- 测试：ui_character +6 用例（手势编排 / 姿态 / 非法手势名 / 缺件分层 / times 误用 / 未知骨骼），server 263 全绿

**实装后修正（2026-10-09，同批）**：
- **标注行仿写**：M2 的历史注入格式 `[已渲染卡片：…]` 被模型在回复中复读（往历史注入格式=教会了句式；与 suggestions 围栏被自发输出同源）——模型写标注 ≠ 调工具，表现为"卡片概率性不渲染 + 文本污染"。修复双保险：`chat/ui-cards` 片段明令禁止自写该格式（golden 重生成）+ `MessageContent` 渲染前剥除标注行（助手消息，含流式未闭合残行与全角变体；对已落库消息同样生效）
- **3D 卡加固**：清理补 `forceContextLoss()`（确定性释放 WebGL 上下文，防多卡累积触发浏览器上限后旧卡变空白）；模型/动画加载加 20s 超时（网络挂起给出可行动的错误而非永久 spinner，错误含 `chat.card3dTimeout` 指引）

---

## D60：世界模拟角色状态——定义/值双 JSON 列、update_state 工具与轮末中立结算双轨、第 8 卡型 'state'

**日期**：2026-10-09

**背景**：世界模拟此前只有法则一个可变维度，无法承载「发生在世界中的事件」留下的持续性痕迹。用户需求：世界中的每个 Agent 携带贯穿会话的状态（生命值、精神健康值、体温…），**默认没有任何状态**；状态独立于法则；创建世界与编辑世界时可定义/修改；会话推进中随事件变化。

**决策**：
1. **存储**：worlds 增 `states`（定义 JSON `[{name, default, description}]`）与 `state_values`（`{agentId: {属性名: 值}}`）两个可空 JSON 列；双方言幂等迁移（sqlite ALTER 无 DEFAULT，NULL 由 lib 统一容错，跟随 stats 先例）。默认值仅用于初始化；读取时以「对账视图」呈现（按成员过滤 + 缺属性补默认）；编辑定义 = 全量替换 + 就地持久对账；成员增删懒对账（存储保留、读取过滤——重新加回即恢复）
2. **变更双轨（用户拍板「两者都要」）**：角色 Agent 经 `update_state` 工具即时修改（自己/他人，绝对新值）；轮末中立 Agent 以「世界裁决者」身份复核补结算（可修正夸张改动）。两侧共用 `lib/world-state.ts` 的 `applyChanges`（no-op 静默、落库、构建变更卡）
3. **呈现**：CardComponent 首增第 8 种 `'state'`（专用渲染：成员/属性/旧值→新值/原因；方向箭头仅数值可解析时展示且**保持中性**——属性语义因名字而异，升绿降红会误读）；〈引擎合成卡〉成为卡片体系第二个来源（不经 catalog / 无 ui_* 工具 / 无 card-action）；update_state 工具与轮末结算共用同一卡片形态
4. **提示词**：新片段 `chat/world-state`（scene 层，states 非空时注入：定义 + 全员当前值 + 行为规则）+ 新配方 `neutral.world-state.*`（世界裁决者；刻意**不接额外指示**以保结构化输出）；编排器每 Agent 重取运行态快照 + ToolContext 注入状态句柄（同轮新鲜度）
5. **可见性**：全员可见（每个 Agent 提示词注入全体成员当前值）
6. **行为边界**：默认无状态 = 零行为变化（片段/工具/结算/卡片全部不出现；既有黄金快照逐字不变）；IM 渠道无关（无世界入口）；值统一为显示字符串（TypeBox 层不支持联合类型；≤60 字符、单行、禁「|」护结算行解析）

**原因**：
- 「即时性 vs 一致性」的分工：角色工具负责事件发生时的即时性；轮末裁决负责「世界事实」的兜底与合理性（旁观者能看到全局，局中角色各自看不到）——双轨互为补充而非重复
- 卡片是状态系统的 **UI 契约而非模型可选项**：引擎合成保证「有变化必有卡」，不依赖模型自觉制卡（模型工具覆盖不了轮末结算的展示）
- 两个 JSON 列而非关系表：读取处处整取整写、单写者（工具与结算串行）、生命周期与会话同行——与 `conversations.stats` 同款立场

**备选与权衡**：
- ❌ 仅工具（轮末无兜底、环境性变化无人认领）/ ❌ 仅轮末（事件发生时无即时反馈）/ ❌ `ui_state` 模型工具（模型负担 + 与引擎合成重复）——用户选项中被否
- ⚠️ 无限模式每轮多一次中立 LLM 调用（结算）——仅状态非空的世界承担；失败开放
- ⚠️ 属性改名 = 删 + 建、值重置（无稳定 attr id）——spec 显式写明，接受
- ⚠️ 旧客户端遇未知 `'state'` 组件走既有 cardUnsupported 错误态（不崩）

**影响**：
- server：db ×5（ddl / sqlite / pg / schema ×2）、`lib/world-state.ts`（新）、routes/worlds + routes/chat、`tools/world-state-tool.ts`（新）+ tools/types、ai/pi-adapter + group-orchestrator + neutral-agent、prompts（fragments/chat + fragments/neutral + registry + index + preview）
- shared：`WorldStateDef` / `WorldStateValues` / `WorldStateRuntime` / `WorldStateRow` / `WorldStatePromptView`、WorldInfo 扩展、CardComponent + `'state'`、错误码 ×2（WORLD_STATES_INVALID / WORLD_STATE_VALUE_INVALID，基线 154→156）
- web：cards/state/StateCard（新）+ registry、sidebar/WorldStatesFields（新）+ LawsEditor 重构（双分页 + 当前值手动修正）+ NewWorkflowDialog、hooks（useChat / useGroupChat 的草稿链路与 realtime:world_state 刷新）、api、i18n 三语
- 测试：`world-state.test.ts`（12 用例）、preview +2、golden +3（world-with-states / neutral.world-state.*）、`scripts/test-world-state-e2e.ts`（19 断言）
- 详见 `docs/specs/module-world.md`

---

## D61：本地 SQLite driver 从 sql.js 换为 node:sqlite（根治满载丢数据）

**日期**：2026-10-14

**背景**：生产实战暴露数据丢失——服务器满载时进程被挤死（OOM / SIGKILL），最近 ≤30s 的已提交数据随进程蒸发。根因是 sql.js 的架构：整库常驻 WASM 内存，靠「30s 定时 `export()` 全量序列化 + 退出时 `writeFileSync` flush」落盘。这有三个结构性缺陷：① 已提交数据在两次 persist 之间只活在内存，`SIGKILL` 不可捕获 → 丢失窗口是天花板，调小定时器只能让它响得慢；② `Buffer.from(sqlDb.export())` 每次 persist 额外吃 ~2x 库大小内存，满载时这个 tick 自己就可能触发 OOM（自我实现的预言）；③ D39 曾用「加 PG 远程模式」绕过，但那是**规避**而非根治，且把本地部署用户留在危险默认上。

**决策**：本地 SQLite 的 driver 由 `sql.js` 换为 `node:sqlite`（Node ≥ 22.5 内置），复用已发布到 npm 的 `@homurajs/db`（`createSqliteDb`），drizzle-orm 连带升到 `1.0.0-rc.4`（`node-sqlite` 适配器仅自此版本存在）。**保留 momoi 现有 server 骨架**（全局单例 `db`、手写路由、自定义 PIN+JWT auth），只换最底层 driver 与持久化机制。

**原因**：
- node:sqlite 缺省 `journal_mode=delete` + `synchronous=FULL`——**每笔 commit 由 SQLite 自己 fsync 落盘**，持久性不依赖优雅退出。进程被强杀（断电/OOM/kill -9）时已提交数据全部保全，下次打开自动回滚未提交事务。三条丢失窗口一次性根治。
- 数据留磁盘、进程内仅 page cache，不再常驻整库 + export 双份拷贝 → **顺带降低满载 OOM 发生率**（CI 已显示服务器内存紧张，构建前检查 MemAvailable<4GiB）。
- sql.js `export()` 产出的就是标准 SQLite 文件格式，node:sqlite 能**原地打开现存 `data/momoi.db`**，无需数据转换脚本。
- 复用 `@homurajs/db` 而非裸 `new DatabaseSync`：与 homura 生态对齐、drizzle 版本天然锁定去重为单一实例；`createSqliteDb` 一行拿 drizzle 实例，`.run/.get/.all` 方法面与旧 sql-js 适配器逐字兼容。

**关键约束与权衡**：
- **外键语义突变**（头号行为风险）：node:sqlite 缺省**强制**外键（`foreign_keys=ON`，与标准 SQLite C 库默认 OFF 相反），而 momoi 契约文档 + 15+ 路由依赖旧 sql.js「FK 不强制 + 路由层手动级联」语义。→ `initSqlite` 显式 `PRAGMA foreign_keys = OFF` **逐字还原**既有行为，本轮**不动任何路由删除逻辑**。拥抱真外键级联（需审 15+ 路由 + 清现存库可能的悬空外键脏行）留作未来单独一轮。
- **不复用 `@homurajs/db` 的 `runMigrations`**：它要求 drizzle-kit rc.4 目录格式（`<ts>_name/migration.sql` + `--> statement-breakpoint`，且禁止旧 `meta/_journal.json`），momoi 无迁移产物、纯手写 DDL。→ 保留 momoi 的 `MIGRATION_SQL` + try/catch ALTER，改用 `db.$client.exec(...)` 执行（node:sqlite 的 `exec` 支持一次跑多语句串、`IF NOT EXISTS` 幂等）。
- **drizzle 升级是全局的**：连带波及 pg 路线——rc.4 的 node-postgres `drizzle()` 不再接受 `(client, config)` 位置参数，`db/pg.ts` 的 `drizzlePg(pool,{schema})` 已改为 `drizzlePg({ client: pool })`（`schema` 键被 rc.4 Omit，momoi 不用 `db.query.*` 关系 API 故直接去掉）。
- **事务能力变化**：node:sqlite 的 `db.transaction()` 可用但**仅同步回调**（sync 驱动禁 async）。momoi 现 0 处使用事务（群聊合并 / 建世界两处是 async 顺序写），迁移不破坏任何事务代码；这两处已知非原子流程可后续单独改造，不在本轮。
- ❌ 备选「留在 sql.js，仅缩小定时器 + 原子 rename 落盘」：治标不治本，丢失窗口消不掉、export 内存开销仍在，被否。
- ❌ 备选「完整迁移到 @homurajs/app-kit 渐进式装配」：等于重写整个 server 骨架，高风险，且对「满载丢数据」无额外帮助，超出本轮边界，被否。

**影响**：
- server：`db/sqlite.ts` 重写（换 driver + 删 persist/setInterval/SIGTERM flush 整套落盘层）、`db/pg.ts`（`drizzle()` 调用形式适配 rc.4）、`db/ddl.ts`（注释）、`schema.sqlite.ts` + `schema.pg.ts`（3 张复合主键表回调 对象→数组 消 deprecation，两文件共 6 处）、`tsup.config.ts`（external 去 `sql.js`）、`package.json`（去 `sql.js`/`@types/sql.js`，加 `@homurajs/db@26.10.14`，`drizzle-orm`/`drizzle-kit` 锁 `1.0.0-rc.4`）；4 处路由注释修正过时归因（conversations/admin/worlds + prompts/tools）
- `db/index.ts` **无需改动**（`initSqlite` 返回 `{ db, schema }` 契约不变；新增可选 `dbPath` 参数仅供测试注入）
- 测试：新增 `test/db-durability.test.ts`（5 用例）+ `test/fixtures/kill9-child.mjs`——**kill-9 持久性门禁**（spawn 子进程写盘后 SIGKILL，重开断言数据仍在，直接复刻生产事故）+ FK OFF 语义对齐 + 迁移幂等 + drizzle CRUD 冒烟 + 现存库连续性。补上 momoi db 层此前**零测试覆盖**的洞。
- 文档：本决策 + D2/D39 交叉引用标注；`module-database.md`（引擎/持久化/外键/迁移/依赖全面更新）、`ARCHITECTURE.md`、`PRD.md`、`module-config.md`、`module-prompt-engine.md`、`AGENTS.md`、`README.md`、`.env.example`
- 部署：`node:sqlite` 要求 Node ≥ 22.5（生产 v26 已满足）；无原生模块编译、无 WASM 资产
- 详见 `docs/specs/module-database.md`

---

## D62：Tailwind CSS v4 评估——因钉钉 WebView 硬约束暂不升级

**日期**：2026-10-14

**背景**：TW v4（v3 → v4）带来 CSS-first 配置、原生 cascade layers、更快的构建等收益，计划升级 web 端。升级前做了可行性实测，结论是**与 momoi 现有的浏览器兼容策略硬冲突**，本轮不升。

**结论**：保持 Tailwind v3（`^3.4.19`），不升级 v4。v3 仍在维护，前端运行稳定，零风险。

**决定性证据（本机实测，非记忆）**：TW v4.3.3 编译产物（`@import "tailwindcss"` 最小样本）**第一行即 `@layer theme, base, components, utilities;`**，且含 `color-mix()`（透明度修饰符 `bg-primary/50` 的实现方式）、`:is()`。用 **lightningcss（TW v4 的底层引擎）以 `targets: chrome>=79` 降级**后：

| 产物特性 | Chrome 最低支持 | lightningcss 能否降级 | chrome79 后果 |
|---|---|---|---|
| `@layer`（cascade layers） | 99+ | ❌ **引擎降级清单里根本没有 cascade-layers 项** | 整块被忽略 → **所有工具类层叠优先级塌陷，样式全乱** |
| `color-mix()`（走 `var()` 的透明度） | 111+ | ❌ 编译期无法对运行时 `var()` 静态求值 | 透明度类失效 |
| `:is()` | 88+ | ✅ 可补 `-webkit-any()` polyfill | 非主要矛盾 |

对照组已验证降级引擎确实生效（成功展开 CSS 嵌套、`lab()`→`#bf5700`、`:is()`→`-webkit-any`），故上表可信。`@layer` 是 v4 的**架构地基**（utilities 覆盖 base 全靠它），无法用配置绕过；`cssTarget` / autoprefixer / `@tailwindcss/postcss` 全建在 lightningcss 之上，都拿不到 unlayer 能力。

**冲突根源**：momoi web 端为**钉钉 Android 内置浏览器（内核 < Chrome 104）深度优化**，`vite.config.ts` 锁 `cssTarget: 'chrome79'`。这不是随手设的，是成体系的硬约束——移动端判定走 JS 绕开媒体查询（`App.tsx`）、图表色板解析成具体值而非 `var()`（`palette.ts`）、SSE 只用 data-only 格式（见 D38）、`dvh`/`@property` 均有 `@supports` 兜底（`globals.css`）。TW v4 的 `@layer` 基线（Chrome 99+）与之无解冲突。

**权衡**：
- ❌ 升 v4 + 放弃钉钉老 WebView：等于牺牲一个真实 IM 集成入口的 UI 可用性，产品取舍不划算
- ❌ 升 v4 + 手写 PostCSS 强拆 `@layer` + 静态化颜色：lightningcss 不提供，需自造降级插件，成熟度与维护成本未知，违背「用官方机制」原则
- ✅ 保持 v3：零风险；待钉钉内置浏览器内核升级（或 momoi 放弃该入口）后再评估

**触发重评的条件**（满足其一即可重启升级评估）：① 钉钉 Android 内置浏览器内核升至 Chrome 111+；② momoi 明确放弃钉钉 WebView 作为 UI 宿主（仅保留 IM 渠道）；③ TW 官方或 lightningcss 提供 cascade-layers 降级能力。

**影响**：本轮 **web 端零改动**，`tailwind.config.js` / `postcss.config.js` / `globals.css` 维持 v3 形态。本决策仅记录评估结论与证据链，避免将来重复实测。

**待补证据**：TW v4 官方浏览器基线的确切数字（Safari/Chrome/Firefox）与 `@config`/`@tailwindcss/upgrade` 工具的官方定义，本次因无联网未核实——上述结论基于本地 lightningcss 源码与编译产物实测，机制层面已锁定，官方数字仅作文档补充，不影响「chrome79 硬冲突」这一判定。参考 `https://tailwindcss.com/docs/upgrade-guide`。

---

## D63：封禁即时生效（修复 JWT 吊销漏洞）+ homura app-kit/auth 换装评估存档

**日期**：2026-10-14

### 第一部分：修复「封禁后 JWT 仍有效」的吊销漏洞

**背景**：调研「换装 homura app-kit/auth」时顺带发现一个独立的真实安全漏洞。`verifyUserToken` 只验签 + 查 `role==='user'`，**不查 `users.banned`**；`userAuthMiddleware` 与 `adminAuthMiddleware` 同样不查。后果：管理员封禁用户后，该用户手上已签发的 JWT **仍能访问全部受保护 API 最长 14 天**；唯一止损手段是轮换 `JWT_SECRET`（误伤所有用户）。此漏洞 `module-auth.md` 旧版曾明文记载（「封禁账号的 token 验证通过但 `/verify` 返回 403」）。

**决策**：新增 `isUserBanned(username)` helper，在 `userAuthMiddleware` 与 `adminAuthMiddleware` 验签成功后、注入身份前**逐请求查库**拦截封禁用户。**不引入服务端会话表**（守住 D32 零状态设计）、**不改前端契约、不改错误码注册表、不改 i18n、不动 PIN/JWT/OIDC 任何现有机制**。

**返回码用 401 而非 403（关键取舍）**：语义上「账户被封禁」更贴切的是 403 `USER_DISABLED`，但实测前端契约（`apps/web/src/lib/api.ts` 的 `handleAuthOn401`）**只有 401 触发会话驱逐**（清会话 + `auth:expired` 事件 → 回登录页），403 不触发。若中间件返 403，用户会卡在「看似登录、但每个请求都失败」的糟糕状态。故中间件返 **401 `AUTH_INVALID_TOKEN`** → 前端驱逐回登录页 → 用户再试登录时 `/verify` 返 **403 `USER_DISABLED`**（`errors.ts` 已注册、i18n 三语已有「账户已被禁用」文案）告知原因。完美复用现有机制。

**不加缓存**：`users.username` 是 TEXT 主键 → 走主键索引，node:sqlite 本地同步查询开销可忽略。加 TTL 缓存会以缓存窗口削弱「即时生效」这一安全目标，故不做。若将来 profiling 证明瓶颈，再作独立优化。

**备选与权衡**：
- ❌ 引入服务端会话表 / 改用 opaque session id：能精确吊销，但与 D32「零状态、拒绝会话存储」正面冲突，改动面波及全库与前端。
- ❌ 轮换 `JWT_SECRET` 踢单人：做不到——会误伤所有用户。
- ✅ 逐请求查库：最小改动（1 helper + 2 中间件各 4 行），零前端影响，即时生效。

**已知局限**（如实记录）：
1. **活跃 SSE 连接不会被切断**：`/api/events` 是长连接，中间件只在建连时跑一次。封禁用户若已连着 SSE 会继续收到事件直到断线重连。彻底解决需服务端主动踢连接（`lib/realtime.ts` 按 userId 清理 subscriber）——独立一轮。
2. **仍无「全员强制下线」**：轮换 `JWT_SECRET` 仍是唯一手段。精确全员吊销需服务端会话状态，与 D32 冲突，本轮不碰。
3. 每请求多一次 DB 主键查询（开销可忽略）。

**影响**：
- server：`lib/auth.ts`（新增 `isUserBanned` + import 补 `users` + `adminAuthMiddleware` 加检查）、`middleware/userAuth.ts`（加封禁检查 + import）
- 测试：新增 `test/auth-ban.test.ts`（11 用例）——补上认证层此前**零测试覆盖**的洞（18 个测试文件无一测 auth/jwt/pin）。含「封禁即时生效」核心门禁：签发 token → 访问成功 → 改 banned → 同一 token 立刻被拒 → 解封后恢复。用真实 temp node:sqlite 库（经 `initSqlite` 的 dbPath 注入口），mock 掉 `db/index.js` 以不污染开发库。
- 文档：`module-auth.md`（banned 字段描述、中间件行为清单、行为约束第 9/10 条）、本决策
- 前端：**零改动**

### 第二部分：homura app-kit / auth 换装评估——结论不换装（存档）

**背景**：主人提出「momoi 已用 homura db，进一步把 server 骨架换装 `@homurajs/app-kit`、认证换装 `@homurajs/auth`」。做了三路调研 + 亲读源码 + 本机实测。**结论：技术上「装得上」，但性价比极低，不换装。** 此处固化证据链，避免将来重复调研。

**为什么不换（三条硬理由）**：

1. **homura auth 主动抛弃了本地凭据认证**（文档在案）：`docs/heritage/suzuran-lessons.md` 的「明确抛弃」表格列着「自建 OIDC IdP（WebAuthn/密码/授权服务器）」；ADR-007「`OIDCClient` 只实现标准 code flow」，重开触发条件举例是「设备码」——密码从未进入其设计空间。`OIDCClient` 全文 108 行、2 个公开方法、构造参数 6 项全必填（不接远程 IdP 无法实例化），无凭据钩子/策略接口。`packages/auth/` 内 grep `password|PIN|credential|pbkdf2` 与 `role|isAdmin` 均零命中。→ momoi 的 PIN 认证在 homura auth 里无任何对应物。

2. **换完 momoi 仍是「自管认证」，只是 session 层更重**：`SessionManager` 确能脱离 `OIDCClient` 独立签发（源码零 oauth2 import），但代价是——单 cookie → 双 cookie（`homura_at`+`homura_rt`）、零状态 → 必需 `refresh_tokens` 表（违背 D32）、`c.set('userId',username)` → `c.set('auth',claims)`（约 40 处 handler 要改）、`AuthUser` 是封闭类型无 admin 位（仍得自己查表）、客户端续期 → 服务端透明 rotate（前端 62 行调度器作废）、错误 wire 从 `{code}` → `{error}`（破坏前端 `toApiError`）。而 PIN 校验、`X-User` 头、cookie 落地、rate limiter、5 个 PIN 端点、is_admin 判定全得 momoi 自己留着。且 homura 模板前端无任何凭据提交范式可抄、PIN 式接入在其 hono 集成层是未测试区域、auth 链自身尚未经真实 IdP 验证（支持矩阵标 🟡）。

3. **app-kit 最值钱的部分 momoi 用不上，且换装有隐藏回退**：momoi 永远 standalone，app-kit 核心价值「双形态适配 / qw-pages / PostgREST」完全用不上。好消息（两个曾担心的冲突被证伪）：createApp 不注册 cors、onError 可注入、静态服务用 `createReadStream` 而非 `serve-static`（不重引入 Windows+tsx 挂起 bug）、`app` 是标准 Hono 可继续挂路由（渐进接入）。但三处实质回退：① 丢 brotli/gzip 预压缩（app-kit static 无协商，momoi 的 compressionPlugin 产物永不被服务）；② `sw.js` 被误设 immutable 1 年（`urlPath.includes('.')` 判定，阻断 Service Worker 自更新）；③ CORS 顺序陷阱（Hono trie-router 按插入序定优先级，createApp 后注册的 `use('*',cors)` 作用于不了经 routes 参数传入的路由）。附带 assetsDir 锚定 cwd 与 momoi 的 REPO_ROOT 锚定错位。

**身份模型的根本差异**（将来真要换的前置条件）：momoi 身份主键是 `users.username`（TEXT PK）**且可变**（`/rename` 级联更新 5 张表），业务表 `user_id` 存的都是用户名字符串；homura `AuthUser.sub` 是 opaque 稳定标识。username 一变，已签发 session 的 sub 就与 users 表脱钩 → 必须先引入稳定 user id 或接受 rename 后强制重登。

**战略层错位**（最根本）：homura PRD 定位是「AI Agent 按模板快速产出的轻应用，最终用户是钉钉组织内成员，派生式消费」；momoi 是成熟自托管产品（15+ 路由、双 IM、Pi Agent、技能系统、VRM），最终用户是 PIN 自注册用户。与 D61 先例一致：momoi 对 homura 生态的既定取向是**取基础设施层（db），不交骨架与认证**。

**将来重评的触发条件**（满足其一可重启）：① momoi 需要 qw-pages 部署；② 放弃 PIN 改纯外部 IdP；③ 引入稳定 user id 取代可变 username 主键；④ homura auth 链完成真实 IdP 端到端验证。

---

## D64：WorkBuddy 智能源——把插件内核移植进服务端，而非旁挂 xrl-router

**日期**：2026-10-25

**背景**：需要让「后台 → 网关」支持第二类智能源：除管理员自配置的 OpenAI 兼容端点外，可直接使用 WorkBuddy（CodeBuddy）账号。参考实现 `xrp-workbuddy` 是 xrl-router 的插件进程（WS 注册 V24 契约 + 独立端口 19069）；Momoi 是自托管单体应用，没有 xrl-router，也不应要求用户额外跑一个进程。

**决策**：把参考实现的**核心**（自包含网页登录、token 续期与轮换、网关转发与身份头）移植为 `apps/server/src/ai/workbuddy/`，以 `gateway_source: 'custom' | 'workbuddy'` 作为网关第一项配置；凭证由服务端持有、AES-256-GCM 加密落 `settings` 表，并随服务启动一个每分钟巡检的 keeper 自动轮换。转发以 `provider.ts` 的一个分支接入——**不改 SSE 解析、不改工具调用聚合、不改既有错误链路**。

**为什么不旁挂插件进程**：
- ❌ 需要用户多跑一个服务、多占一个端口，并引入「插件未启动 → 全站空回复」的新故障面；Momoi 的定位是单进程自托管。
- ❌ 插件的 WS 注册/模型目录推送是 xrl-router 契约，对 Momoi 没有对应物，保留即死代码。
- ✅ 移植后只剩「登录 / 换票 / 转发」三件事，与 Momoi 的 provider 契约天然对齐（WorkBuddy 上游本就是 OpenAI SSE，Momoi 本来就只发流式请求）。

**为什么不把凭证直接当 api_endpoint + api_key 填进配置**：
- ❌ access token 有效期短、必须靠 refresh token 轮换；静态 URL+密钥配置无法在请求间换票，过期后全站对话失败且无法自动恢复。
- ❌ WorkBuddy 要求 `X-User-Id` / `X-Domain` / `X-IDE-*` 等客户端身份头与链路头，静态配置也没有落点。
- ✅ 服务端托管凭证 + 请求时取票，才能做到「登录一次，之后后台自动轮换」。

**关键取舍**：
- **凭证加密用与库同存的随机密钥**（`workbuddy_store_key`）：目的是让 token 不以可读形式出现在 settings 表、备份与 SQL 查询结果中；并不宣称能抵御拿到整库的攻击者（本项目 `api_key` 本就明文存库，如实记录，不夸大）。
- **keeper 不看「当前是否选中 WorkBuddy」**：管理员可能已登录但尚未点保存，按已保存配置跳过轮换会让凭证悄悄过期。无凭证时每分钟只做一次空查询。
- **不读取本机 WorkBuddy App 登录态**：参考实现的 `WORKBUDDY_USE_LEGACY_APP` 路径绑定特定机器与 App 版本，与自托管部署冲突，明确不做。
- **登录在服务端完成、浏览器只负责授权**：前端关页不影响换票完成，避免「必须盯着页面」的脆弱登录。
- **`gateway_source` 纳入配置导入导出白名单**（枚举校验 `CONFIG_IMPORT_BAD_GATEWAY_SOURCE`），但凭证不导出；导入到新实例后仍需登录一次。

**影响**：
- server：新增 `ai/workbuddy/*`（config / web-login / credentials / token-manager / chat）、`routes/workbuddy.ts`；`ai/provider.ts` 增加 workbuddy 分支；`lib/config.ts` 读写 `gateway_source`；`index.ts` 启动 keeper；`lib/config-transfer.ts` 白名单与校验
- shared：`AppConfig.gateway_source`、`WorkBuddyStatus` / `WorkBuddyLoginStatus`、`CONFIG_IMPORT_BAD_GATEWAY_SOURCE`
- web：网关页新增智能源选择与凭证面板；右上角「从环境变量加载」仅在自配置时显示；三语新增文案
- 测试：`test/workbuddy-token.test.ts`（密文落库 / 续期写回 / 无凭证提示）、`test/config-transfer.test.ts` 增补 gateway_source 用例

---

## D65：上游类型改名 + 豆包（Doubao）上游——移植抖音授权登录与私有 SSE 适配

**日期**：2026-10-25

**背景**：网关第一项配置原先叫「智能源」，现在需要同时支持三类上游：自配置 OpenAI 兼容端点、WorkBuddy、以及豆包（Doubao）网页端。参考实现 `xrp-doubao` 是 xrl-router 的插件进程（独立端口 + WS 注册 + Playwright 登录）；Momoi 是自托管单体应用，没有 xrl-router，需要把登录与转发收进单进程，同时**必须展示抖音官方授权二维码**——豆包自助扫码码是另一条链路，不能拿来冒充。

**决策**：
1. **界面文案改名**：`设置 → 网关 → 智能源` 改为 `上游类型`；数据库键 `gateway_source` 与枚举值 `custom` / `workbuddy` 保持不变（存量配置与导出文件零迁移），新增 `doubao`。
2. **豆包内核移植进服务端**：新增 `apps/server/src/ai/doubao/`（配置、Cookie 罐、设备指纹、请求参数、SSE 解析、消息压平、登录驱动、凭证、风控标记、私有协议客户端、流式适配），路由挂在 `/api/admin/doubao/*`，前端新增二维码凭证面板。
3. **默认登录采用抖音 OIDC 授权页**：服务端用 `playwright-core` 拉起无头系统 Edge/Chrome，复刻豆包官方登录弹窗 → 抖音官方授权页（`open.douyin.com`）；拦截授权页请求 `/oauth/get_qrcode/` 的响应，把**抖音授权二维码**原样回传管理端。用户扫码 / 短信验证码授权后，由豆包官方页面自行完成 code 换票，服务端从浏览器上下文提取 Cookie。纯 HTTP 的豆包自助扫码链路保留为 `DOUBAO_LOGIN_FLOW=doubao` 灾备选项。
4. **协议适配直出 `StreamEvent`**：`provider.ts` 在 `gateway_source=doubao` 时整段委托 `streamDoubaoChat`，不把豆包私有 SSE 伪装成 OpenAI chunk；连接超时语义与自配置端点一致（只覆盖建连）。
5. **凭证与 WorkBuddy 共用加密实现**：抽出 `lib/encrypted-settings.ts`（AES-256-GCM + 与库同存密钥），WorkBuddy / Doubao 各自使用独立的值键与密钥键；豆包没有 refresh token，因此不设后台轮换 keeper。（后续由 D70 补充：新增**不续期**的后台巡检 keeper——只探测有效性并吸收上游轮换的 Cookie，失效仍需重新扫码。）

**为什么默认用无头 Playwright 展示抖音二维码**：
- ✅ **产品语义要求**：管理端必须展示抖音官方授权码（二维码解码为 `aweme://authorizedy?...`），豆包自助扫码码不是同一个东西。
- ✅ **换票只能由官方页面完成**：参考实现实测，在 Node 端重放抖音回调 `code` 会被豆包判为「非法应用」（缺少页面上下文）；把授权页放在真实浏览器里，由豆包页面自己换票并写 Cookie，是已验证可行的链路。
- ✅ **无头即可**：二维码回传到管理端展示，用户用手机扫描；浏览器不需要桌面会话，服务器 / 容器里也能跑。
- ⚠️ **代价如实记录**：`playwright-core` 需要系统 Edge/Chrome（或显式指定 Chromium 可执行文件）；无浏览器环境会登录失败。为此保留纯 HTTP 的 `DOUBAO_LOGIN_FLOW=doubao` 灾备链路，并在错误信息里明确指引（安装浏览器或切回退链路）。
- ⚠️ 若上游页面结构变化导致选择器失效，先更新 `douyin-login.ts` 的选择器；灾备链路与 `DOUBAO_COOKIES` 可临时顶上。

**为什么凭证不能当 api_endpoint + api_key 填进配置**：
- ❌ 豆包上游认证是整套网页 Cookie（`sessionid` / `ttwid` / CSRF）加设备指纹，不是 Bearer key；请求 URL 还带一整套设备参数。
- ❌ 会话会失效且没有 refresh token；服务端必须能检测失效并提示重新登录。
- ✅ 服务端托管 Cookie + 请求时组头，管理端只展示账号、时间戳、Cookie 条数与风控标记。

**关键取舍**：
- **只支持文本**：图片 / 音频 / 文件输入返回可读错误。（已被 D68 取代：图片 / 文件走 ImageX 上传；音频仍不支持）
- **不实现 tools / function calling**：豆包网页端没有稳定的原生 tool_call 协议，不伪造该语义；工具定义被忽略，Agent 只拿文本回复。
- **不绕过风控**：71002200x 系列只置位 `needs_captcha`，等待管理员在浏览器完成人机验证后手动清除，或重新登录。
- **二维码等同临时凭据**：只在 `pending` / `scanned` 期间下发，登录成功后不再出现在任何响应里；登录成功 / 超时 / 失败都会关闭浏览器。
- **静态模型映射**：`doubao-fast` / `doubao-expert` / `doubao-work` / `doubao-work-pro` / `doubao-2.1-lite` 及短别名；未知模型名回落 `doubao-fast`。

**影响**：
- shared：`GatewaySource` 增加 `doubao`；新增 `DoubaoStatus` / `DoubaoLoginStatus`（含 `flow` 字段）
- server：新增 `ai/doubao/*`（含默认 `douyin-login.ts` 与灾备 `web-login.ts`）、`routes/doubao.ts`、`lib/encrypted-settings.ts`（WorkBuddy 凭证层同步改用）；新增依赖 `playwright-core`；`ai/provider.ts` 增加 doubao 分支；`lib/config.ts` 与 `lib/config-transfer.ts` 接受 `doubao`；`routes/admin.ts` 挂载端点
- web：网关页文案改为「上游类型」，新增豆包选项与二维码凭证面板；三语新增文案；导入错误文案补充 doubao
- 测试：`test/doubao.test.ts`（抖音二维码拦截 / 登录状态机 / 密文落库 / 协议适配 / 回退 / 错误映射 / 风控标记）；`test/config-transfer.test.ts` 增补 doubao 枚举
- 文档：新增 `docs/specs/module-doubao.md`；`module-config.md`、`module-workbuddy.md`、`ARCHITECTURE.md`、`PRD.md` 同步改名与结构

---

## D66：WorkBuddy 登录改为服务端截获微信二维码，面板不再弹出网页

**日期**：2026-10-25

**背景**：D64 的 WorkBuddy 登录让前端 `window.open(auth_url)` 打开腾讯托管登录页。实际登录页默认就是「微信扫码登录」，管理员每次都要多开一个标签页，体验与豆包面板不一致。已实测：登录页加载时会请求 `/console/auth/wechat-url` 拿到微信 OIDC 地址，随后从 `https://open.weixin.qq.com/connect/qrcode/<uuid>` 拉取二维码图片（image/jpeg）。

**决策**：服务端在 `beginLogin()` 后异步用无头系统浏览器打开 `auth_url`，拦截 `open.weixin.qq.com/connect/qrcode/` 的图片响应，转成 data URL 通过 `/login/status` 的 `qr_data_url` 下发给凭证面板；浏览器保持打开，让微信 OIDC 回跳并完成 state 换票，随后仍由既有的 token 轮询取票。前端**不再自动 `window.open`**，只在二维码未出现（无浏览器 / 超时）时提供「打开登录页」链接。

**关键取舍**：
- **复用同一次浏览器会话完成 OIDC**：只把二维码搬进面板，不尝试在 Node 端重放微信回调；浏览器是官方登录链路的执行者。
- **浏览器不可用则优雅回退**：`openWechatQrLogin` 返回 null，登录仍可用旧方式（点击链接在管理员自己的浏览器完成），不会因为缺少 Edge/Chrome 而完全不可用。
- **浏览器启动器与豆包共用**：抽出 `lib/headless-browser.ts`，两个上游各自通过 `WORKBUDDY_BROWSER_*` / `DOUBAO_BROWSER_*` 配置通道、可执行文件与参数。
- **二维码只在下发窗口期出现**：`pending` 时随状态轮询下发，成功 / 失败后不再返回；日志不打印二维码内容。
- **仍是全局单凭证**：与 `api_key` 同级，一次扫码全站生效；退出登录会关闭登录浏览器并删除凭证。
- **两个凭证面板共用同一套 UI/UX**：`WorkBuddyCredentialPanel` 与 `DoubaoCredentialPanel` 使用相同的状态机与通用文案键（等待扫码 / 刷新二维码 / 扫码登录 / 重新登录 / 退出登录 / 超时与失败提示），差异仅在凭证字段、二维码来源与回退链接。

**影响**：
- server：新增 `ai/workbuddy/wechat-qr.ts`、`lib/headless-browser.ts`；`token-manager.ts` 登录会话增加 `qrDataUrl` 与浏览器生命周期；`workbuddy/config.ts` 新增浏览器 / 二维码等待配置；`doubao/douyin-login.ts` 改用共用启动器
- shared：`WorkBuddyLoginStatus.qr_data_url`
- web：WorkBuddy 凭证面板直接展示微信二维码，移除自动弹窗，保留「打开登录页」回退链接；三语文案同步
- 测试：`test/workbuddy-token.test.ts` 新增二维码截获 / 超时回退用例；本机真实冒烟在 3.2s 内截获 image/jpeg 二维码
- 文档：`module-workbuddy.md` 登录流程、环境变量、接口契约与验收标准同步

---

## D67：Agent 模型改为上游目录下拉 + 自定义回退

**日期**：2026-10-25

**背景**：Agent 的 `model` 一直是自由文本输入。切到 WorkBuddy / 豆包上游后，模型 ID 不再是常识（`glm-5.3`、`doubao-expert`……），管理员只能另找文档；写错要等到对话才暴露。

**决策**：
1. 新增管理端点 `GET /api/admin/gateway/models`，按当前保存的 `gateway_source` 返回模型目录：
   - `custom`：`GET {api_endpoint}/models`（OpenAI 兼容，`api_key` 非空时带 Bearer）
   - `workbuddy`：云端目录 `/v2/enterprises/personal/models`（先检查登录态，未登录不发起请求）
   - `doubao`：`MODEL_PRESETS` 静态预设（网页端没有可编程的目录接口）
2. Agent 表单的模型字段换成下拉，末尾固定一个「自定义」项；目录为空或当前值不在目录内时自动切到自定义输入。
3. 目录接口失败不返回 5xx，降级为 `models: []` + `warning`；保存时服务端不校验模型是否在目录内。

**为什么不在保存时校验模型**：
- ❌ 上游目录随套餐 / 版本变化，硬校验会让历史 Agent 无法保存；
- ❌ 自定义端点可能只实现 `/chat/completions` 而没有 `/models`；
- ✅ 下拉只是输入便利，唯一事实仍是 `agent.model` 字符串。

**为什么不做服务端缓存**：
- 目录没有失效通知；缓存会让「换了套餐 / 换了端点」后的第一次编辑看到旧列表。
- 每次打开表单拉一次，代价是一次 GET；失败已有降级路径。

**关键取舍**：
- **WorkBuddy 目录与对话共用身份头**：从 `chat.ts` 抽出 `headers.ts`，目录请求只换 `Accept` 并去掉对话链路头。
- **文生图模型不进下拉**：`tags` 含 `text-to-image` 的条目被过滤，避免把图像模型选给对话 Agent。
- **豆包不列短别名**：`doubao` / `doubao-pro` / `doubao-think` 仍可解析，但下拉只列 5 个正式预设，别名走自定义输入。

**影响**：
- shared：`GatewayModelOption` / `GatewayModelList`
- server：新增 `ai/models.ts`、`ai/workbuddy/models.ts`、`ai/workbuddy/headers.ts`（从 `chat.ts` 抽出的身份头）；`routes/admin.ts` 新增 `/gateway/models`；`ai/workbuddy/config.ts` 新增 `WORKBUDDY_MODELS_PATH`；`ai/doubao/config.ts` 新增 `listDoubaoModels()`
- web：新增 `ModelPicker`，`AgentManager` 的模型输入替换为下拉；三语新增文案
- 测试：`test/gateway-models.test.ts`（custom 归一化 / 失败降级 / doubao 静态 / workbuddy 未登录与目录解析）
- 文档：`module-agent.md`、`module-config.md`、`module-workbuddy.md`、`module-doubao.md`、`ARCHITECTURE.md`、`PRD.md` 同步

---

## D68：豆包上游同步 xrp-doubao 多模态升级（ImageX / 思考块 / 会话清理）

**日期**：2026-10-25

**背景**：参考实现 `xrp-doubao` 的 commit `21a9db5` 补齐了图片 / 文件上传（ImageX）、新版思考块解析与每轮会话自动清理。Momoi 的豆包适配是移植实现，仍停留在「仅文本」；上游实测已经证明 Web 端支持附件，继续返回「不支持图片」会让 Momoi 多模态能力在豆包上游整体缺失。

**决策**：把参考实现的五条链路同步进 `ai/doubao/`：

1. `messages.ts` 从**最后一条 user 消息**提取图片 / 文件（data URL / http(s) URL），历史附件只留占位符
2. 新增 `upload.ts`：`prepare_upload → ApplyImageUpload(SigV4) → TOS → CommitImageUpload → pre_handle`
3. `client.ts` 在聊天请求里把附件拼成 `block_type:10052` 的独立 `messages[]` 项
4. `10040` 按 `BLOCK_THINKING` 解析（`thinking_block.think` 优先，步骤标题兜底），兼容旧 delimiter
5. 新增 `conversation-cleanup.ts`：流结束后异步删除本轮会话（cmd 4171）

**为什么带附件的请求不回退 `/samantha`**：
- ❌ 旧端点没有附件语义，回退会把附件静默丢掉，用户看到「成功回复」但内容与附件无关；
- ✅ 宁可返回明确错误，也不产生语义错误的回复。
- 同时收紧回退判定：只有 404 / 405 / 410 / 501-504 / 非 SSE / 网络错误才回退；风控、鉴权、400/422 参数错误一律直接返回。

**关键取舍**：
- **只上传当前用户消息的附件**：历史消息每轮重发，若重新上传会成倍放大流量与延迟；历史以 `[图片]` / `[文件：名称]` 占位。
- **Momoi 的文本 / PDF / Excel 仍内联**：现有 `files/parser.ts` 已将内容转成文本，继续内联既省一次上传，也能让不支持多模态的模型降级工作；只有图片会以 data URL 到达豆包层。
- **`menu_type` 与「关闭思考」的映射**：`need_deep_think` / `ext.use_deep_think` 改为菜单 `menu_type`（0/3/9/5/10001）；专家模型在关闭思考时收起为 0，工作任务类模型的 `menu_type` 是模式标识、不随开关改变。
- **会话清理失败不阻塞回复**：只记录统计与警告，`GET /api/admin/doubao/status` 暴露 `conversation_cleanup`。
- **音频仍不支持**：返回可读错误，不伪造能力。
- **首包超时覆盖上传**：外层 120s 连接超时包含附件上传；超大附件在慢速链路上可能先超时，已如实写入 spec 的边界。

**影响**：
- server：新增 `ai/doubao/upload.ts`、`ai/doubao/conversation-cleanup.ts`；`ai/doubao/config.ts` 新增上传 / 清理 / 思考摘要配置与 `menuType` / `modelExtraParams`；`messages.ts` 重写；`client.ts` 接入上传、回退判定、思考块解析与清理；`session.ts` 状态返回清理统计
- shared：`DoubaoStatus.conversation_cleanup`
- 测试：`test/doubao.test.ts` 扩展 ImageX 五步链路、附件不回退、思考块 / CHUNK_DELTA、清理请求；更新 `need_deep_think` 断言；`error-registry-i18n` 基数
- 文档：`module-doubao.md` 增补多模态、思考链、清理、环境变量与验收标准

---

## D69：消息气泡改为右键 / 长按菜单，编辑在气泡内联提交

**日期**：2026-10-25

**背景**：旧交互只在**用户消息左侧**放一个常驻「更多」按钮，菜单只有「回退」和「强制合规重试」，且回退把原文填回输入框、用户再手动发送；AI 消息没有任何操作。用户希望所有消息都能复制 / 编辑，并区分「改自己的消息」与「改 AI 的消息」。

**决策**：

1. **统一菜单**：移除左侧常驻按钮；每条气泡桌面端右击、移动端长按弹出菜单——AI 消息为 复制 / 编辑，用户消息为 复制 / 编辑 / 强制重试。移动端额外用 480ms 长按派发 `contextmenu`（Radix 自带 700ms，保留为兜底）。
2. **内联编辑**：编辑框只出现在气泡处，取消 / Esc 不产生请求；提交才改历史。
3. **编辑自己的消息 = 原子截断 + 重新发问**：`POST /api/chat` 携带 `edit_message_id`，服务端在同一次请求里删除目标及其后所有消息、插入新文本并生成回复；目标附件沿用原消息。
4. **编辑 AI 消息只改历史**：`PATCH /api/conversations/:id/messages/:messageId`；不触发上游请求，后续对话从 DB 装配历史时自然生效。
5. **强制重试只用于自己的消息**：回退（DELETE）+ 以 `_force_compliance` 重发，行为不变。
6. **AI 消息不提供强制重试**：编辑已经覆盖「改写 AI 回复」的需求；再为同一目标提供第二套写入口只会让用户在两套语义（改历史 vs. 重新生成）之间做无意义的选择，也避免群聊 / 世界模拟里再引入一套单条重生成的事件流与状态副作用。

**为什么不做 AI 单条重试**：
- ❌ 群聊 / 世界模拟中，「重说」要么重跑整轮（与「单个气泡」相悖），要么只重写一条却让后续消息基于旧内容（语义不一致）；两种取舍都不划算。
- ✅ AI 回复的改写需求由 PATCH 编辑精确满足：只改该气泡、不发上游请求，后续对话自然使用新历史。
- ✅ 用户自己的消息仍保留「强制重试」——它需要真正重新生成回答，和编辑是两件事。

**为什么不复用旧回退做编辑**：
- ❌ 旧回退是「删库 + 把文本填回输入框 + 用户再点发送」两步；中途离开就永久丢了消息。
- ❌ 先 DELETE 再 POST 是两次网络请求，中间失败会留下「消息已删、未重发」的半状态。
- ✅ `edit_message_id` 在一次 SSE 请求里完成删除 / 插入 / 生成，并带 `_retry` 幂等判定。

**关键取舍**：
- **AI 消息的 trace 只替换正文**：思考 / 工具 / 卡片保留，末尾追加新正文；不重放思考，也不改写工具结果。
- **编辑 AI 消息清空 suggestions 与语音缓存**：旧建议与旧音频对应的是旧文本，保留会误导。
- **QQ 群只读**：QQ 群消息只保留复制（编辑会与 QQ 侧不同步）。
- **生成中只允许复制**：编辑 / 强制重试在流式期间禁用；内联编辑期间完全抑制菜单，保留输入框原生右键与文本选择。

**影响**：
- server：`routes/chat.ts` 新增 `edit_message_id` 处理；`routes/conversations.ts` 新增 PATCH 消息端点；新增 `lib/message-edit.ts`（trace 重写）；`ai/tts.ts` 新增 `clearVoiceCache`
- shared：新增错误码 `CHAT_EDIT_UNSUPPORTED`
- web：新增 `ui/context-menu.tsx`、`chat/MessageActions.tsx`；`MessageBubble` 增加内联编辑并移除左侧菜单；`MessageList` / `ChatPanel` / `App` 改传编辑回调；`useChat` 新增 `editMessage`；移除 `InputBar.externalValue` 回填路径；`useVoice` 增加「编辑后缓存失效」处理
- 测试：新增 `test/message-edit.test.ts`（trace 重写）
- 文档：`module-chat.md`〈消息操作〉、`module-conversation.md` 的 PATCH 契约

---

## D70：两个内置上游的凭证面板对齐——WorkBuddy 二维码阶段显式化，豆包加后台巡检

**日期**：2026-10-25

**背景**：管理端「设置 → 网关」的两个网页登录上游，UI/UX 行为不一致：

1. WorkBuddy 的 `POST /login` 只完成 state 握手就返回，微信二维码由服务端在后台异步截获。
   前端在 POST 返回后立刻结束「启动中」状态，于是二维码还没出现时按钮就变回「刷新二维码」，
   并且「二维码未出现？点此打开登录页」链接在整个等待期间常驻——正常流程里它既误导又多余。
2. 豆包面板没有 WorkBuddy 那样的后台凭证维护：Cookie 失效只能等对话报错才发现，
   上游在响应里轮换的 `Set-Cookie` 也从不写回存储。

**决策**：

1. **WorkBuddy 登录状态增加 `qr_state`**（`loading` / `ready` / `unavailable`）：
   - `loading`：浏览器启动 / 等待二维码，面板按钮保持「正在启动登录浏览器…」并禁用，
     顶部状态同步显示启动文案
   - `ready`：二维码已下发，按钮变为「刷新二维码」
   - `unavailable`：只有此时才在 `/login/status` 里下发 `auth_url`，面板显示失败提示与
     「在浏览器中打开登录页」最终回退；正常流程（`loading` / `ready`）不出现任何外链
2. **豆包新增后台凭证巡检 keeper**（`startDoubaoKeeper()`，默认 15 分钟）：
   - 用账号端点探测会话，结果 `ok` / `auth` / `error` 写入 `DoubaoStatus.keepalive`
   - 吸收探测响应与对话响应里的 `Set-Cookie`，内容变化才加密写回；
     `DOUBAO_COOKIES` 灾备来源不落库
   - `auth` 置 `DoubaoStatus.invalid=true`，面板显示「凭证已失效，请重新扫码」；
     失效期间跳过巡检，避免反复触发上游鉴权失败
   - 重新扫码或任意一轮对话成功都会清除失效标记
   - 并发保护：请求期间完成新一轮登录时，旧会话的轮换结果丢弃，不覆盖新凭证

**为什么豆包不叫「自动轮换」**：
- ❌ 豆包登录只下发会话 Cookie，没有 refresh token / 续期端点（参考实现与 D65 均已确认）；
  承诺「自动轮换」会误导管理员以为凭证可以永续。
- ✅ 巡检的边界写清楚：探测有效性 + 吸收上游轮换的 Cookie；失效仍然必须重新扫码。
- ✅ 保留 WorkBuddy 的「后台自动轮换」文案不变——它确实持有 refresh token 并续期。

**为什么保留 WorkBuddy 的回退链接而不彻底删除**：
- 服务端没有 Edge/Chrome 时，无头浏览器截获不到二维码；此时在管理员自己的浏览器打开
  `auth_url` 仍能完成 OIDC（state 存在腾讯服务端，换票仍由服务端轮询完成）。
- 把回退限制在 `qr_state=unavailable` 之后：正常流程干净，失败时仍有一条可用出路。

**影响**：
- shared：`WorkBuddyLoginStatus.qr_state` / `auth_url`；`DoubaoStatus.invalid` / `keepalive`；新增 `DoubaoKeepalive`
- server：`ai/workbuddy/token-manager.ts` 增加二维码阶段状态与 `auth_url` 下发；
  `ai/doubao/account.ts` 新增 `probeDoubaoSession`（判定 ok/auth/error 并吸收 Cookie）；
  `ai/doubao/session.ts` 新增 keeper、失效标记与 Cookie 轮换回写；
  `ai/doubao/client.ts` 吸收对话响应 Set-Cookie；`ai/doubao/chat.ts` 成功时清除失效标记；
  新增 `ai/doubao/error-codes.ts`（与上传层共用鉴权码）；`index.ts` 启动 keeper
- web：WorkBuddy 面板按 `qr_state` 控制按钮与回退链接；豆包面板新增巡检状态与失效提示；三语文案
- 测试：新增 `test/workbuddy-login.test.ts`（loading / ready / unavailable）；`test/doubao.test.ts`
  增加巡检吸收 Cookie、失效标记、对话 Cookie 写回用例
- 文档：`module-workbuddy.md` 登录流程 / 接口契约 / 验收标准；`module-doubao.md` 新增〈后台凭证巡检〉；
  `PRD.md`、`ARCHITECTURE.md`、`.env.example` 同步

---

## D71：构建与检查统一收敛到 vp（Vite+ 1.4），并按 node-app-starter monorepo 形态对齐

**日期**：2026-10-29

**背景**：项目已是 pnpm workspace 三包布局（`apps/server` / `apps/web` / `packages/shared`），但工具链仍是拼装式：server 用 tsup、web 用 vite、测试用 vitest、lint 用 ESLint（仅 web），根目录没有统一的 `check`。每个工具各自一套配置文件与版本，接入新包要重复拼装。

**决策**：采用 `node-app-starter` 的 node-monorepo 路线约定——构建与检查统一走 vp，同时保持本项目既有的业务形态不变：

| 项 | 变更前 | 变更后 |
|---|---|---|
| server 构建 | `tsup.config.ts` | `apps/server/vite.config.ts` 的 `pack` 块（tsdown），`vp pack` |
| web 构建/开发 | `vite` 命令 | `vp build` / `vp dev` |
| 测试 | `vitest run` | `vp test run` |
| 全仓检查 | 无 | 根 `vite.config.ts`（fmt/lint）+ 各包 `vp check --no-fmt` |
| 运行时版本 | 无声明 | 根 `.nvmrc` = 24 |
| `packageManager` 字段 | 无 | 保持无（由 vp 依 lockfile 自动检测） |

**原因**：
- 一个 CLI 覆盖 dev / build / pack / test / check，减少四套工具版本与配置漂移
- vp 自带 oxfmt + oxlint，新增包无需再搭 ESLint 轮子
- 与 starter 路线保持同构，后续扩展（CLI、子应用）照抄即可

**取舍与偏离**：
- **不做全仓重排**：既有代码按 prettier 风格书写，首次接入 oxfmt 若对全仓 `--fix` 会产出数千行纯格式 diff，淹没真实改动。因此 `check` 统一执行 `vp check --no-fmt`（lint + 类型感知关闭），格式化作为可选动作（`vp check --fix`）渐进引入。
- **oxlint 仅报错不阻塞**：既有代码在 oxlint 下约 50 条 warning（未用变量、风格类），当前全部为 warning、零 error，CI 不会被卡住；后续逐条清理。
- **web 的 ESLint 配置保留**：其 rules-of-hooks 是历史白屏事故（bde107b）的护栏，oxlint 的等价规则行为尚未验证，故先并存，不删除。
- **`deps.neverBundle` 取代 `external`**：tsdown 已弃用 `external`，`pg` / `ws` 改为 `deps.neverBundle`；`@momoi/shared/**` 用 `alwaysBundle` 通配内联（子路径导入 `@momoi/shared/constants` 等也需内联，只写包名会漏）。
- **`vp test` 不接受 `--passWithNoTests`**：改为 `vp test run`，与既有 `vitest run` 语义一致。

**影响**：
- `package.json`×4：新增 `check` 脚本、`vite-plus` 开发依赖；删除 `tsup`、`vitest`、`vite` 直接依赖
- 新增：根 `vite.config.ts`、`apps/server/vite.config.ts`、`.nvmrc`；删除 `apps/server/tsup.config.ts`
- `apps/web/tsconfig.json`：类型引用 `vite/client` → `vite-plus/client`
- 文档：`README.md`、`AGENTS.md`、`docs/ARCHITECTURE.md` 同步构建命令

---

## D72：OAuth2 改造为 OIDC，推翻 D35 的「否决 OIDC」结论

**日期**：2026-10-29

**背景**：D35 当初把「OIDC 严格模式」列为否决方案，理由是「大量国内/私有 OAuth 提供商不兼容」。
但该实现留下了四个真实问题：

1. **无身份断言**：\`provider_user_id\` 靠 \`sub → id → user_id → randomUUID()\` 链式猜测。
   \`randomUUID()\` 兜底意味着非标 Provider 的同一用户**每次登录都生成新 ID**，永远走不进「已有绑定」分支。
2. **无签名校验**：身份完全取自 userinfo 端点的裸 JSON，一旦该端点被降级或中间人篡改，攻击者可冒充任意用户。
3. **端点变更靠人工**：IdP 升级后管理员需手工改三个 URL。
4. **配置面过大**：6 个字段里 3 个可由 discovery 自动获取。

与此同时，自建的 \`../oidc-dingtalk\`（原 \`oauth2-dingtalk\`）已升级为标准 OIDC Provider：
暴露 discovery 文档，签发 HS256 签名、\`sub\` = 企业 userid 的 \`id_token\`。
「不兼容」的顾虑失去了现实基础——我们有了一个标准锚点。

**决策**：全面改用 OIDC，废弃 OAuth2。

| 维度 | 决策 |
|---|---|
| 配置 | 主填 \`issuer\` + 凭证；三个 URL 降为可选覆盖项 |
| 端点 | discovery 自动获取，进程内缓存 1h，校验 \`doc.issuer\` 一致 |
| 身份 | **验签后的 id_token.sub**；无 id_token 时回退 userinfo，二者都无 \`sub\` 则报错（不再 randomUUID） |
| 验签 | HS256 → clientSecret 作对称密钥；RS256/ES256 → JWKS 公钥。按 discovery 声明自动选择 |
| 命名 | 表名 / 错误码 / 路由 / i18n / 文案全部 OAuth2 → OIDC |

**原因**：
- id_token 的 iss / aud / exp 由密码学校验，比「信任 userinfo 裸 JSON」强度高一个数量级
- \`sub\` 语义唯一确定，消除了 randomUUID 造成的重复注册
- discovery 让 IdP 升级对 RP 透明
- \`algorithms\` 白名单显式传入 \`jwtVerify\`，杜绝 \`alg: none\` 降级

**备选与权衡**：
- ❌ 只支持 HS256：实现更简单，但与 Google / Keycloak 等只用 RS256 的 IdP 不兼容。改为双路径后两种 Provider 都能接
- ❌ 彻底删掉手填 URL：会让不发 discovery 的非标 Provider 无法接入。保留为覆盖项，且 \`authorize_url\` + \`token_url\` 同时存在时**完全跳过 discovery**（不发网络请求）
- ⚠️ **nonce 不做校验**：\`oidc-dingtalk\` 无状态，无法把 nonce 绑进 id_token（其 README 明确声明）。CSRF 由 state 独立承担；\`aud\` + 签名 + 全链 TLS 对自用场景足够
- ⚠️ HS256 下 \`client_secret\` 既是凭据又是验签密钥，要求 Provider 与 RP 共享同一秘密。对第三方 IdP 应优先用非对称算法

**迁移策略**：
- **数据库**：SQLite 启动时幂等执行 \`INSERT OR IGNORE INTO user_oidc_bindings SELECT * FROM user_oauth_bindings\`；
  **旧表保留不删**，已部署实例可回退。PG 需手动 \`ALTER TABLE ... RENAME TO\`
- **配置键**：读取时优先新键、回退旧键（\`oidc_providers\` ← \`oauth_providers\`，\`oidc_registration_open\` ← \`oauth_registration_open\`），
  写入只写新键——升级实例配置不丢，首次保存后自然迁移
- **升级影响**：旧 \`oauth_providers\` 里存的是三个 URL 而没有 \`issuer\`，迁移后这些条目需要管理员补填 issuer 才能使用

**影响**：
- 共享层：\`OidcProvider\` 类型；\`OAUTH_*\` → \`OIDC_*\`（含新增 \`OIDC_ID_TOKEN_INVALID\`）
- 服务端：新增 \`lib/oidc-discovery.ts\`、\`lib/oidc-verify.ts\`；\`routes/oauth.ts\` → \`routes/oidc.ts\`
- 前端：\`OidcRegisterScreen\`；管理端供应商表单由三 URL 输入合并为 issuer 输入
- 测试：新增 \`oidc-verify.test.ts\`（密钥 / iss / aud / 过期 / 算法降级）、\`oidc-discovery.test.ts\`（缓存 / issuer 校验 / 覆盖项）
- 文档：\`module-oauth.md\` → \`module-oidc.md\` 全文重写；D35 同步修订

## D73：内置上游登录改用纯 HTTP，服务器不再需要浏览器

**背景**：WorkBuddy 与豆包两个上游的扫码登录此前都依赖 `playwright-core`
拉起无头系统浏览器——WorkBuddy 打开腾讯登录页截获微信二维码，豆包打开登录弹窗
进抖音授权页截获授权码。`playwright-core` **不自带浏览器**，服务器上通常也没有
Edge / Chrome，因此部署到服务器后两者必然在「获取二维码」这一步失败。项目定位是
自托管服务器部署，这条依赖等于让核心功能在生产环境不可用。

**决策**：两条登录链路全部改为纯 HTTP 复刻，移除 `playwright-core` 依赖与
`lib/headless-browser.ts`。

1. **WorkBuddy 微信二维码**（已对线上逐跳验证）：
   `openid-connect/auth` 建立 Keycloak 会话 Cookie → `console/auth/wechat-url`
   取微信授权地址 → `open.weixin.qq.com/connect/qrconnect` 页面提取 uuid →
   `/connect/qrcode/<uuid>` 下载二维码 JPEG → `/connect/l/qrconnect` 轮询
   扫码状态（408 未扫 / 404 已扫 / 405 已确认 / 402 失效）。
   `wechat-url` **必须先建会话**，否则 502「failed to create wechat authorization url」。
2. **豆包抖音授权**（已对线上逐跳验证）：直连
   `open.douyin.com/oauth/get_qrcode/?client_key=…&aid=1128&scope=user_info&next=…&state=…`
   取得抖音开放平台授权码 → `oauth/check_qrcode/` 轮询 → 确认后跟随回跳收集豆包 Cookie。
   这是豆包网页端「抖音一键登录」真正使用的 OAuth 通路。

**关键发现（豆包）**：`accounts.doubao.com/passport/web/get_qrcode/` **不是**抖音授权码。
它的 `copywriting` 写着「请使用『抖音 APP』扫码验证」，极具误导性；实测解码二维码
指向 `www.doubao.com/flow-account/scan-login`，属于豆包 App 扫码码。判定二维码归属
必须**解码二维码内容**，不能看页面文案。

**过程中的教训**：
- 纯 HTTP 化时漏掉了 OAuth 回跳（原浏览器方案由浏览器自动完成），导致 WorkBuddy
  扫码后平台 state 永远停在 pending。表现为「扫码后没反应」，且微信长轮询本身正常。
- 豆包侧曾按文案误判 `accounts.doubao.com` 的二维码为抖音码，并在 headless 模式下
  反复观察不到 `open.douyin.com` 跳转而一度误判无关；实际是 headless 被风控静默拦截，
  有头模式才能看到真实跳转。

**备选与权衡**：
- ❌ 在服务器安装 Chromium 并要求部署流程承担：体积 +300MB、构建更慢，且与「最小部署」冲突
- ❌ 让管理员复制链接到本机浏览器完成登录：WorkBuddy 可作为最终回退保留，但不应是主路径
- ⚠️ 协议是逆向所得：上游改版会让扫码失败。两张二维码的获取失败都会以可读错误
  呈现，WorkBuddy 面板额外提供「复制登录页链接 + 在浏览器打开」回退
- ⚠️ 豆包的 `doubao` 自助扫码链路保留为应急旁路，但它展示的是**豆包 App 码**，
  不是产品语义要求的抖音扫码，默认不启用

**影响**：
- server：重写 `ai/workbuddy/wechat-qr.ts`、`ai/doubao/douyin-login.ts`；
  删除 `lib/headless-browser.ts`；`package.json` 移除 `playwright-core`
- 配置：新增 `WORKBUDDY_AUTH_URL_BASE` / `REALM` / `CONSOLE_CLIENT_ID` /
  `WECHAT_CLIENT_ID` / `WECHAT_IDP_HINT`、`DOUBAO_PASSPORT_SDK_VERSION` /
  `PASSPORT_PCA` / `LOGIN_REQUEST_TIMEOUT_MS`；`WORKBUDDY_BROWSER_*` 标记弃用
- 前端：二维码阶段文案改为「正在获取二维码」；不可用时提供可复制链接
  （局域网 http 下 `navigator.clipboard` 不可用，退回 `execCommand`）
- 测试：抖音链路用例从「假浏览器」改为纯 HTTP 契约测试，并固化 CSRF 头约束

## D74：WorkBuddy 登录最终落实为纯 HTTP，彻底移除浏览器依赖

**背景**：D73 一度把 APISIX 的 401 归因于 TLS 指纹 / device-token，并回退到服务端
无头 Chromium。实测推翻了两点：curl_cffi 的多种浏览器指纹全部 401；带上真实
TDID `x-device-token` 依然 401。真正的原因在**会话 Cookie 的获取方式**上。

**最终链路（全程纯 HTTP，已线上验证换取 accessToken）**：

1. 用 `/console/accounts/.apisix/redirect` 作为 `redirect_uri` 建立 Keycloak 会话，
   state 用 32 位 hex；
2. `console/auth/wechat-url` 取微信授权地址 → qrconnect 页面提取 uuid → 下载二维码；
3. 微信确认后带 code 回跳 broker，跟随 Keycloak 重定向链，落到
   `.apisix/redirect?...&code=…` —— **该响应下发 `session` 与 `session_2`**；
4. **立即** `POST /console/login/enterprise?state=<第 1 步的 state>` 换取 accessToken。

**关键发现**：

- 换票接口是 `/console/login/enterprise`，不是 `/v2/plugin/auth/token`（后者是桌面客户端链路，
  网页登录下永远 `11217 pending`）。
- `.apisix/redirect` 的响应若继续跟随到 `/console/accounts`，平台会清空
  `session`/`session_2`（`set-cookie: session=; session_2=;`），因此必须在拿到后立刻换票。
- `x-device-token`（字节 TDID SDK 生成，1062 字符、每次不同、依赖 WebAssembly 与浏览器指纹）
  **并非必需**——带与不带都能成功换票，故不在服务端复现。
- 微信登录必须绑定到 apisix 那条 OIDC 流程；绑定到 `/login` 流程时回跳落到登录页，
  永远拿不到 `session_2`。

**备选与权衡**：
- ❌ 服务端无头 Chromium（D73 方案）：可用但重，服务器需装约 300MB 浏览器；
  纯 HTTP 方案验证后已回退该依赖
- ❌ 逆向 TDID：SDK 混淆 + WASM + 浏览器指纹，成本远高于收益，且实测非必需

**影响**：
- server：`ai/workbuddy/wechat-qr.ts` 重写为纯 HTTP；`token-manager` 登录编排改为
  扫码确认后直接调 `completeLogin()`；删除 `lib/headless-browser.ts` 与 `playwright-core` 依赖
- 配置：新增 `WORKBUDDY_REALM` / `CONSOLE_CLIENT_ID` / `WECHAT_CLIENT_ID` / `WECHAT_IDP_HINT`；
  `WORKBUDDY_BROWSER_*` 保留但已不使用
- 测试：二维码用例改为纯 HTTP 契约测试（含二维码来源域名校验）
