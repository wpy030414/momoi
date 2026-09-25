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

## D2：SQLite 替代外部数据库

**日期**：架构确立时

**背景**：需要一个数据库来存储对话历史和配置。

**决策**：使用 SQLite（sql.js + Drizzle ORM），单文件存储。

**原因**：
- 零配置，无需安装/维护外部数据库服务
- 单文件 `data/momoi.db`，易于备份和迁移
- 对于单用户/小团队场景完全足够
- sql.js 提供纯 WASM SQLite 支持，无需编译原生模块

**影响**：
- sql.js WASM 执行在单进程中，写入操作自然串行化
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

## D35：OAuth2 第三方登录与账号绑定

**日期**：2026-09-10 ~ 2026-09-11

**背景**：项目仅支持用户名 + PIN 登录（D12），但多用户场景下每人需独立注册 PIN，且无法接入已有身份体系。需要引入标准 OAuth2 协议以降低注册门槛，同时允许已有账号绑定 OAuth 身份实现免 PIN 登录。

**决策**：
1. **OAuth2 多提供商架构**：支持配置任意 OAuth2 提供商（通过 `oauth_providers` 配置数组，管理员面板增删）。每个提供商包含 `id`、`name`、`client_id`、`client_secret`、`authorize_url`、`token_url`、`userinfo_url`、`scopes`。
2. **三态回调路由 `GET /api/oauth/:providerId/callback`**：
   - **已有绑定**：OAuth 身份已关联某用户 → 直接签发 JWT，设置 HttpOnly Cookie，重定向到首页（`oauth_user` + `oauth_expires` 查询参数供客户端读取）。
   - **已登录 + 无绑定**：用户已持有有效 JWT Cookie → 自动将当前 OAuth 身份绑定到当前账号。
   - **全新用户 + 注册开放**：重定向到首页带 `oauth_register=1` 参数，前端引导完成注册（选"关联已有账号"或"创建新账号"）；注册关闭时直接报错。
3. **`user_oauth_bindings` 表**：`(provider_id, provider_user_id)` 唯一约束，每 OAuth 身份只绑定一个用户；绑定后可免 PIN 直接登录。
4. **独立注册开关**：`oauth_registration_open` 设置（默认开启），管理员可独立关闭 OAuth 新用户注册，不影响已有绑定用户登录。

**原因**：
- 标准 OAuth2 Authorization Code 流程，安全性依赖 state 参数防 CSRF（`randomBytes(32)` 存在 HttpOnly Cookie 中，回调时校验）
- provider_user_id 优先取 `sub` → `id` → `user_id` → fallback `randomUUID()`，兼容不符合 OIDC 规范的提供商
- Referer 头推导 SPA 真实 origin（开发模式 Vite 代理下 `c.req.url` 指向后端端口，Referer 才携带前端地址）
- 三态回调一个端点处理全部情况，减少 URL 管理复杂度

**备选与权衡**：
- ❌ OIDC 严格模式：需要标准 `openid` scope 和 `/userinfo` 端点格式，大量国内/私有 OAuth 提供商不兼容
- ❌ 每个提供商独立回调 URL：增加注册复杂度，统一回调可复用 redirect_uri
- ⚠️ state 仅存 HttpOnly Cookie 10 分钟（`maxAge: 600`），超时后 OAuth 回调 state 校验失败——用户体验为跳回首页带 `oauth_error`，需重新发起登录
- ⚠️ `remoteId` 解析 fallback 到 `randomUUID()`：非标准提供商每次回调生成不同 ID，会重复触发注册页而非直接登录——属提供商不兼容的必然代价

**影响**：
- 新增 `src/server/routes/oauth.ts`（三端点：`/providers`、`/:providerId/login`、`/callback`）与 `POST /api/oauth/register`（完成注册端点）
- `user_oauth_bindings` 表（含 PG 双方言 schema）；`users` 表新增 `banned` 列
- `AppConfig` 新增 `oauth_providers` 字段；`config.ts` 新增 `isOauthRegistrationOpen` / `setOauthRegistrationOpen`
- `LoginScreen` 新增 OAuth 登录入口（按提供商列表渲染按钮）与 OAuth 注册流程（`oauth_register` 参数触发）
- `GET /api/user/status` 新增 `oauth_registration_open` 字段

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

## D39：PostgreSQL 远程数据库模式 — sql.js 本地 / PG 远程双后端

**日期**：2026-09-10（初版多数据库支持）→ 2026-09-14（精简为 SQLite + PG 双后端）

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
- SQLite ADDITIVE_MIGRATIONS 每条 try/catch：sql.js 不支持 `IF NOT EXISTS` 的 ALTER TABLE，逐条 try 避免了"迁移失败则库不可用"的一级事故
- 30 秒自动持久化 + SIGINT/SIGTERM 退出时同步 `writeFileSync` 落盘（SQLite 模式）：异步 `persist()` 在 open 时截断文件（O_TRUNC），若进程在写入完成前被 pm2 SIGKILL 则数据库文件变空、数据不可逆丢失，同步写入彻底消除该竞态

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

## D41：CDN 外挂图床 — 自动转存 img.scdn.io

**日期**：2026-09-11

**背景**：管理后台允许上传自定义 favicon 和背景图，但这些图片以 base64 data URL 存入 `settings` 表（`app_favicon` / `app_background`），体积大（一张背景图可能 > 2MB）。base64 膨胀 `settings` 表、拖慢 `getConfig()` 读取，且浏览器渲染 base64 图片性能差、无法缓存。

**决策**：引入外部 CDN 图床——管理后台上传图片时自动转为 CDN 永久 URL，`settings` 表仅存 URL 而非 base64。通过 `use_external_image_hosting` 管理员开关（默认关闭）控制。

**原因**：
- `settings` 表存储的 data URL 字符串长度可达 2-4MB，一条配置撑大整个 SQLite 文件（每条设置都完整序列化到 WASM heap）
- CDN URL 仅几十字节，对 settings 表几乎无体积影响，getConfig 读取速度也有保障
- 浏览器可直接以 `<img src>` 加载 CDN URL，利用浏览器缓存、无 base64 解码开销
- `img.scdn.io` 免费、无需 API key、响应快速（`/api/v1.php` multipart 上传）

**实现细节**：
- `base64ToBuffer(dataUrl)`：解析 base64 data URL 为 Buffer + MIME type
- `uploadToCdn(buffer, filename, mimeType)`：multipart/form-data 上传到 `https://img.scdn.io/api/v1.php`，返回公开 URL
- 内置速率限制（两次请求间隔 >= 1200ms）防触发 CDN 限流（5 次/5s）；429 时等待 5s 重试一次
- 管理端保存 favicon/background 前检测 `use_external_image_hosting` 开关：开 → 先上传得 CDN URL，关 → 保留 base64 data URL

**备选与权衡**：
- ❌ 本地 serve 静态文件：需要额外的文件服务端点 + 备份管理，且 `data/` 目录无版本化
- ❌ 自建图床/MinIO：引入外部服务依赖，与"轻量自托管"定位冲突
- ❌ CDN 强制开启：外部 URL 泄露 app 自定义资源到公网——部分部署场景不希望外部可见；默认关闭、管理员显式开启
- ⚠️ CDN 服务可用性不可控：`img.scdn.io` 为第三方免费服务，SLA 无保障。不可用时上传失败返回错误，不影响已生成 URL 的图片（已持久化到 CDN）。用户可自行替换 CDN 端点（修改 `cdn.ts` 中的 URL）

**影响**：
- 新增 `src/server/cdn.ts`（`base64ToBuffer` + `uploadToCdn`）
- `config.ts` 新增 `isExternalImageHostingEnabled()`；`AppConfig` 新增 `use_external_image_hosting` 布尔字段
- 管理端 `BrandingSettings` 在保存时按开关决定调用 CDN 转存流程
- `GET /api/app-name` 返回 `use_external_image_hosting` 供前端判断

---

## D42：直连注册开关 — 独立控制用户名 + PIN 注册

**日期**：2026-09-11

**背景**：部署者可能希望仅通过 OAuth 登录（如企业微信内部使用），关闭直接注册入口。原无此能力——注册页面始终可用。需与 OAuth 注册开关（见 D35）独立控制——可同时开启、仅 OAuth、仅直接注册、全部关闭。

**决策**：新增 `direct_registration_open` settings 键（默认 `true`），与 D35 的 `oauth_registration_open` 各自独立。`LoginScreen` 注册表单的可见性由 `direct_registration_open` 控制；`GET /api/user/status` 同时返回两者的当前值。

**原因**：
- 两扇独立门：部署者可按需组合——企业内部全走 OAuth（关直连）、公网双通道（全开）、维护模式（全关）
- 默认开启保持 D12 的零配置体验（用户名 + PIN 始终可用）
- 与 `oauth_registration_open` 对称设计：一个模板 `getSetting` / `setSetting` / admin API（`GET + PUT /api/admin/direct-registration`）

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

## D47：世界模拟 — 语义化地形参数 + 客户端确定性生成（拒绝服务端高度图）

**日期**：2026-09-25

**背景**：需要由用户的一段自由文字创生一个有限面积的三维沙盘。核心矛盾是「地形要被两端一致地理解」：服务端要判定 Agent 落点与「此处是什么地形」，客户端要建网格渲染。

**决策**：

1. **LLM 只输出结构化参数**（`TerrainSpec`：种子、噪声八度、水位分位、生物群系规则表、天空预设），**不输出几何**
2. **地形由客户端确定性生成**：同一份 spec + 同一份噪声实现 ⇒ 任何设备渲染出逐位相同的地形
3. **协议面放在 `@momoi/shared/src/world.ts`**，服务端与浏览器共用同一份实现。这是「两端一致」唯一可靠的保证方式
4. **水位取地形自身高度分布的分位数**，而非绝对值
5. **失败开放**：LLM 超时 / 报错 / 吐不出可解析 JSON → 关键词推导的默认地形，**不发起第二次调用**

**原因**：

- 服务端高度图网格（96² Float32 = 36KB 起）会无界增长，且摧毁「同 spec ⇒ 同世界」这一使纯客户端渲染成立的性质
- 美术资源方案没有交互性、没有生物群系数据、缩放即糊
- 客户端直连 LLM 需要在前端放 API key
- 纯程序化（不经 LLM）无法把「毒水 / 永夜 / 伤害致命」这类语义映射到结构
- 水位必须是分位数：高度场的实际取值随 style 与 amplitude 剧烈变化（`plains` 实测 ±0.04，`mountains` ±0.7），绝对值水位会被低起伏地貌整个越过 —— 实测表现为「提示词写了湖泊，水面占比 0%」

**备选与权衡**：

- ❌ 服务端预生成高度图入库存 → 见上；且 Phase 3 的地形改造需回写整张网格
- ❌ 客户端纯随机、提示词只影响法则 → 「山地、丘陵、森林」这类地形规则会失效
- ❌ 用 `Math.sin` 系哈希做噪声 → 不同 JS 引擎的对数实现有 ulp 级差异，两端地形**静默**不一致（无报错、无堆栈）。必须用整型哈希（`Math.imul`）
- ❌ 事后对 fBm 结果做脊状化 → 会把高度均值推到接近 1，山地世界长成一片惨白；必须**在八度累加之内**脊化

**影响**：

- 新增 `packages/shared/src/noise.ts`、`packages/shared/src/world.ts`；`exports` 加 `./noise`、`./world`
- 新增服务端脚本 `terrain:check`（ASCII 等高线 + 确定性断言）与 `genesis:check`（真实 LLM 观测）
- 词表闭合：`biomes[].id` 必须落在 `TERRAIN_ENUMS.biomeId` 内，别名表负责映射模型自造的 id

## D48：世界会话 — 即时建会 + 异步生成（对新会话草稿态的显式例外）

**日期**：2026-09-25

**背景**：D34 确立了「新会话 / 新群聊只进入草稿态，不落库，首条消息时才由服务端建会」。世界模拟必须**在渲染沙盘之前**就拥有地形，而地形规则是不可变的、不能等首条消息才定。

**决策**：世界**打破 D34 的草稿态约定**，在对话框确认时立即落库：

1. `POST /api/worlds` 建会话 + 世界行 + 成员，**立即返回**（实测 27ms）
2. 地形**起火异步生成**，就绪后经 `world_status` 实时事件通知，客户端重拉
3. **被重启打断的生成自动重跑**（生成幂等），不引入「失败 → 手动重试」状态机
4. `conversations.type` 扩 `'world'`；`POST /api/conversations` **显式拒绝**该值

**原因**：

- 同步等 LLM（10~60s）会把 XHR 挂在代理超时边界上（nginx 默认 `proxy_read_timeout` 60s），钉钉 Android WebView 尤其容易把「长时间无字节流动」的请求判死
- 异步则生成中刷新页面 / 关标签都能恢复，失败也有持久痕迹（`status_error`）
- 而且这**本来就是世界的形状**：世界是长生命周期对象（可变法则、回合计数、Phase 3 的补丁日志），生成只是它的第一个 job。选同步方案会在 Phase 2 重新架构创建路径

**备选与权衡**：

- ❌ 在 `POST` 里同步调 LLM + 对话框转圈 → 见上
- ❌ 草稿态 + 「首次打开时生成」→ 毁掉异步生成赖以成立的可恢复性
- ❌ 为「确认后放弃」加 TTL 清扫器 → 为罕见情形引入复杂度；用户直接软删会话即可
- ❌ 复用 `conv_changed` 通知就绪 → 客户端对它的响应是重拉**消息列表**，而世界没有消息；且会把「消息变了」与「世界状态变了」混为一谈（本仓库正是为此才给 `group_members` 单开事件）

**影响**：

- 新增 `worlds` 表（4 处迁移落点）、`routes/worlds.ts`、`lib/world.ts`、`ai/world-generator.ts`
- `RealtimeEvent` 加 `world_status`；`lib/realtime.ts` 加 `broadcastWorldStatus`
- `index.ts` 启动时 `await sweepInterruptedWorlds()`
- 副作用：确认后放弃会留下一个真实的世界行与已生成的地形。这是 D34 约定的**显式例外**，记录于此以免后来者误以为是遗漏

## D49：世界地形规则不可变 / 世界法则可变；改造走叠加补丁序列

**日期**：2026-09-25

**背景**：需求同时要求「地形规则创生后不可修改」「Agent 可以改造世界」「世界法则后续可更改」。三者必须在同一套数据模型下共存。

**决策**：

1. **地形规则（`terrain_prompt`）不可变**，由 `PATCH /api/worlds/:id` **服务端显式拒绝**保证（见到 `terrain_prompt` / `prompt` 即 400），不依赖界面隐藏输入框
2. **世界法则（`laws`）可变**，自由文本，由叙事型 Agent 的 LLM 依法则裁决
3. **Phase 3 的世界改造以叠加补丁表达**（`world_patches`：`op` + center + radius + strength + biome），在渲染与采样时 fold 到 base 之上，**永远不写回 `terrain_spec`**

**原因**：

- 地形规则是**编译产物**：几何由它经代码推导而来，改它意味着作废一切派生结果
- 法则却是**运行期由 LLM 解释的散文**，改它是廉价且安全的
- 补丁是 **git 式的叠加栈**：`base = buildTerrain(spec)` 永远可重算、是权威；`patches` 是只追加的有序区划变更日志。收益：可回放（丢掉尾巴即撤销）、同步廉价（只传 `seq > lastSeq`）、载荷极小、完全确定
- 补丁用的词汇与 LLM 已经能可靠产出的词汇同构（4 个标量 + 一个枚举），故 Phase 3 的 Agent 工具几乎白捡

**备选与权衡**：

- ❌ 改写 `terrain_spec` → 正是「规则不可变」所禁止的；用户 authored 的世界不再可恢复
- ❌ 存储改动后的高度图网格 → 无界增长，且摧毁跨端一致性
- ❌ 给高度场做 diff/patch → 脆弱且巨大

**影响**：

- Phase 1 **不建** `world_patches` 表（`CREATE TABLE IF NOT EXISTS` 每次启动都跑，Phase 3 再建成本相同；先建等于留一张没人写、却要在 PG/SQLite 两侧保持对齐并写进文档的死表）
- **但接缝现在就在代码里**：`buildTerrain(spec, { segments, patches })` 从第一天起接受并 fold 叠加层，Phase 1 恒传 `[]`
- `worlds.turn` 同样只写不读 —— 刻意的 schema 保险（PG 实际上没有 `ALTER` 通道）

## D50：三维渲染选型 — 直接 three + WebGL2 探测 + 二维降级

**日期**：2026-09-25

**背景**：需要在一个静态场景（一块位移网格 + 一片水面 + 若干名牌）里提供旋转与缩放。首要部署目标是钉钉 Android 内置内核。

**决策**：

1. **只用 `three`**，不引 `@react-three/fiber` / `drei`
2. **`WorldCanvas` 是全仓唯一 import three 的模块**，也是 `React.lazy` 的加载边界
3. **能力探测只接受 WebGL2**；结果分 `'webgl2' | 'software' | 'none'` 三档
4. **`none` 时渲染二维俯视地图**（而不是给一个「不支持」的空页），且**不请求 three chunk**
5. **按需重绘**，不跑常驻 `requestAnimationFrame`

**原因**：

- 场景是**静态**的（建一次、永不变形，只有相机在动），声明式 reconciler 的收益为零
- `@react-three/fiber` 的 peer 是 `react >=19 <19.4`（本仓 `^19.2.8` 兼容）—— 所以**不是** React 兼容性问题，而是：体积、静态场景零收益、以及 Rolldown 下对「库内部动态导入」的不确定性。上界 `<19.4` 是直接依赖 `three` 所没有的升级绊线
- ⚠️ **three 自 r163 起移除了 WebGL1**，`WebGLRenderer` 是 WebGL2-only。放行「有 WebGL1」的设备要么抛错要么渲染出垃圾 —— 仅 WebGL1 的设备**等同于** `none`
- 钉钉 Android 内核可能没有可用的 WebGL2，故二维地图不是退路，**可能是多数用户唯一的渲染路径**，因此先建先验，且它与三维视图消费完全相同的 `buildTerrain` 产物
- 探测必须在**懒加载模块之外**求值，否则 `none` 设备照样会下载 three
- 按需重绘的代价是必须 `enableDamping = false`（阻尼需要连续循环收敛）；收益是移动端读法则时没有 60fps 的持续 GPU 唤醒与发热

**备选与权衡**：

- ❌ `@react-three/fiber` + `drei` → 见上；`drei` 尤其是个杂物袋，其 `OrbitControls` 再导出很容易连带拖进远超预期的依赖
- ❌ 直接接受 WebGL1 → three 已不支持
- ❌ `none` 设备给「不支持 3D」提示页 → 拒绝一个明明能画地图的设备
- ❌ 常驻 rAF → 静态场景下纯属浪费

**影响**：

- `apps/web` 增 `three` + `@types/three`；`vite.config.ts` 的 `manualChunks` 增 `vendor-three`
- 实测：入口 `index` 177KB raw / 49KB gzip，**未**静态引用 `vendor-three`；`vendor-three` 559KB raw / 137KB gzip / 112KB br
- 新增 `apps/web/src/lib/webgl.ts`、`components/world/{WorldCanvas,WorldFallback}.tsx`
- `OrbitControls` 的 `touchAction='none'` 是必需项（否则浏览器滚动页面而不喂事件给画布）；`TOUCH.TWO = DOLLY_ROTATE` 使双指既是捏合缩放又是扭转旋转
