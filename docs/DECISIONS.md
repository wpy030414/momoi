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
- `@hono/node-ws` 仍在 dependencies 中但未使用（可清理）
- 客户端使用 `fetch` + `ReadableStream` 解析 SSE

---

## D2：SQLite 替代外部数据库

**日期**：架构确立时

**背景**：需要一个数据库来存储对话历史和配置。

**决策**：使用 SQLite（@libsql/client + Drizzle ORM），单文件存储。

**原因**：
- 零配置，无需安装/维护外部数据库服务
- 单文件 `data/momoi.db`，易于备份和迁移
- 对于单用户/小团队场景完全足够
- @libsql/client 提供原生 SQLite 支持，无需编译 native 模块

**影响**：
- 不支持并发写入（但单用户场景不需要）
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

**决策**：引入轻量级用户认证 —— 用户名 + 4 位数字 PIN，PBKDF2 哈希存储，登录换取 30 天 JWT。

**原因**：
- 在「零部署门槛」与「最低身份保护」之间取平衡：4 位 PIN 对个人/小团队自托管场景足够，又不引入邮箱/密码等重资产
- PBKDF2（SHA-512、10000 次迭代、随机 16 字节盐）+ `timingSafeEqual`，成本极低但挡住字典与时序侧信道
- JWT 30 天有效期，兼顾安全与「免反复登录」体验
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

**决策**：附件先落盘 `uploads/`（UUID 重命名），再由 `files/parser.ts` 按类型转换 —— 图片转 base64 走 `image_url` 多模态通道，Excel/PDF/文本转纯文本内联进消息正文（`--- 附件: 名称 ---` 分隔），二进制仅存元信息摘要。整个能力由管理员开关 `support_attachments`，默认关闭。

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
- 新增 `uploads/` 目录与 `/api/upload` 路由
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
