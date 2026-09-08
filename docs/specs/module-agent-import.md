# Spec — Agent 导入（module-agent-import）

> 本文为当前任务的 spec-first 契约（AGENTS.md 文档纪律：仅记录已实现或正处于当前任务的范围）。实现落定后补记 DECISIONS。
> 状态：草案，供评审。协议契约见 neko 仓库 `docs/agents-import-protocol.md` v0.2。

## 概述

管理员从 AIP 包（Agent Plugins 1.0 包 + 可选 `xrl.momoi` 扩展层）批量导入 Agent。导入是包 persona → `agents` 表行的**投影**：包是事实源，agent 行是可追溯副本（`origin` 列记录来源）。

导入同时处理包内技能：默认安装（与常规技能安装一致），同名冲突不静默覆盖。

### 范围

本期做：

- 上传 AIP 包（zip）→ 解析校验 → 预览（人格 + 技能 + 冲突）→ 确认导入
- 双形态发现：扩展清单优先，无清单时按通用层 `agents/*.md` 约定发现
- `agents` 表新增 `origin` 列（来源追溯）
- zip 防穿越检查逻辑从 `routes/admin.ts` 提取为共享 helper（技能上传与导入复用）
- vitest 单测 + oxlint/oxfmt + chrome-devtools 驱动的清单式 E2E

本期不做（含依据）：

- ❌ **写入中立 Agent**：中立 Agent 是宿主控制面（生成追问、后续决定发言顺序与事件管线），不属于人格命名空间；导入只读不写、撞名报错（协议 §2.5、§11.2）
- ❌ 模型来源：包不携带模型，导入不读取模型（协议 §2.4）；`agents.model` 置空，运行时沿用既有回退
- ❌ 档位导入：`levels` 中除 `primary` 对应档外不导入，仅明示计数（协议 §7）
- ❌ Agent 导出（agent → 包）：本期无导出入口
- ❌ 普通技能安装路径复用：AIP 包不写入 `skills/` 之外的目录，不与递归技能扫描发生交互

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/server/agents-import/parser.ts` | zip 解析、双形态发现、清单校验、persona/技能提取（纯函数，无 DB 依赖） |
| `src/server/agents-import/types.ts` | 解析中间类型（包级错误/警告、候选、冲突） |
| `src/server/agents-import/store.ts` | 待确认导入的内存暂存（TTL 24h），先例：`chat.ts` 的 `infiniteState` |
| `src/server/lib/zip.ts` | 从 `routes/admin.ts` 提取的 zip 安全 helper（防穿越、包装目录、macOS 清理；三者行为不变）+ 新增名称净化（见解析逻辑 9） |
| `src/server/routes/admin.ts` | 新增导入路由（挂载 `adminAuthMiddleware`）；技能上传改为引用共享 helper |
| `src/server/config.ts` | `createAgent`/`updateAgent` 支持 `origin` |
| `src/server/db.ts` | `agents.origin` 列迁移（`CREATE TABLE IF NOT EXISTS` + `ALTER TABLE` 预检） |
| `src/shared/types.ts` | `Agent` 增加可选 `origin`；导入相关 API 类型 |
| `src/client/lib/api.ts` | 导入上传/提交方法 |
| `src/client/components/admin/tabs/AgentManager.tsx` | 「导入 Agent 包」入口 + 预览/确认对话框 |
| `src/client/i18n/{zh-CN,en}.json` | 新增 `settings.agentImport*` 文案 |
| `package.json` | 新增 devDeps：`vitest`、`oxlint`、`oxfmt`（精确版本） |

## 数据模型

### agents.origin（迁移）

`ALTER TABLE agents ADD COLUMN origin TEXT`，仅导入路径写入，用户 CRUD API 不暴露该字段：

```json
{
  "protocol": "aip",
  "package": { "name": "neko", "version": "1.0.0" },
  "personaId": "vanilla",
  "importedAt": 1750000000
}
```

同一 `(package.name, personaId)` 重复导入视为**同源更新**：即使显示名变化也按同源语义提示，不判定为新冲突。

### 待确认导入暂存

内存 `Map<import_id, { package, candidates, skills, createdAt }>`，TTL 24 小时，进程重启即失效（管理员重新上传即可）。不落盘，避免文件生命周期管理。

## 接口契约

### POST /api/admin/agents/import

**认证**：管理员 JWT。**请求**：`multipart/form-data`，字段 `file`（zip，≤50MB）。

服务端：zip 防穿越检查 → 解包与解析（双形态发现）→ 与现有 agents/skills 比对冲突 → 存入暂存 → 返回预览。

**成功 200**：

```json
{
  "import_id": "uuid",
  "package": { "name": "neko", "version": "1.0.0", "host": "claude-code" },
  "candidates": [
    {
      "id": "vanilla",
      "name": "香子兰",
      "primary": { "file": "skills/neko/personas/vanilla.md", "bytes": 1530 },
      "has_avatar": true,
      "level_count": 1,
      "conflict": { "agent_id": "uuid", "agent_name": "香子兰", "same_origin": false }
    }
  ],
  "skills": [
    {
      "name": "neko",
      "description": "…",
      "conflict": { "installed": true, "content_identical": false }
    }
  ],
  "warnings": [],
  "errors": []
}
```

**失败边界**：

| 情形 | 响应 |
|---|---|
| 非 zip / 超过 50MB | 400（复用技能上传语义） |
| zip 路径穿越 | 400 |
| 既无扩展清单也无 `agents/` 通用层 | 400 `{ "error": "Not an agent import package" }` |
| `plugin.json` 违反 closed-schema 或扩展层路径越出插件根 | 400，整包拒绝 |
| `formatVersion` 非 1 | 400，整包拒绝（未知协议版本） |
| 单个 persona/技能文件缺失或 id 非法 | 该项移入 `errors`，不影响其余（隔离边界） |

### POST /api/admin/agents/import/:import_id/commit

**请求**：

```json
{
  "personas": [
    { "id": "vanilla", "action": "create", "name": "香子兰", "model": "" },
    { "id": "chocola", "action": "skip" },
    { "id": "azuki", "action": "overwrite" }
  ],
  "skills": [
    { "name": "neko", "action": "install" }
  ]
}
```

- persona `action`：`create` / `overwrite` / `skip`；未列出默认 `skip`。
  - `create`：插入新 agent（`role='default'`），`model` 取请求值（可为空字符串，空则运行时回退）。
  - `overwrite`：仅当候选带 `conflict` 时允许；更新目标 agent 的 `name`/`model`/`system_prompt`/`avatar`/`origin`。无冲突传 `overwrite` → 400。
- skill `action`：`install` / `skip`；未列出默认 `skip`。
  - 新技能：写入 `skills/{name}/`，随后 `skillRegistry.refresh()`。
  - 同名冲突且 `content_identical=false`：必须显式 `install` 才覆盖；覆盖前删除同名目录（与既有上传端点一致），并在响应中记录 `overwritten`。
  - 同名且内容一致：跳过并计入 `skipped`。
- `import_id` 不存在或过期 → 404 / 410。
- 提交成功即从暂存删除。单条失败：记入 `errors`，其余不回滚（逐条提交语义）。

**成功 200**：

```json
{
  "imported": [{ "id": "uuid", "name": "香子兰" }],
  "overwritten": [],
  "skipped": ["chocola"],
  "skills": { "installed": ["neko"], "overwritten": [], "skipped": [] },
  "errors": []
}
```

## 解析逻辑（parser.ts，纯函数）

1. 读 `plugin.json`：Agent Plugins closed-schema 校验（未知顶层字段忽略；致命错误整包拒绝）。
2. **扩展形态**：`extensions."xrl.momoi"` 或目录 `xrl.momoi/plugin.json` 存在 → 读扩展清单，校验 `formatVersion===1`、`namespace`、`personas[]`；每个 persona 校验 `id` 命名、`primary` 文件存在且位于插件根内。
3. **通用形态**（无扩展清单）：发现 `agents/*.md`，取 frontmatter `name`（必填）与正文；文件名（去扩展名）为 id，须匹配 `[a-z0-9-]+`。
4. **共存**：以扩展清单为准；校验 `agents/<id>.md` 正文与清单 `primary` 文件正文一致，不一致记 `warnings`。
5. 技能发现：`skills/*/SKILL.md`（一层，沿用 Agent Plugins 发现规则），取 frontmatter `name`/`description`。
6. 冲突比对：
   - 人格按显示名匹配现库 `agents.name`（精确相等）；`origin` 的 `package.name`+`personaId` 相同则 `same_origin=true`。
   - 技能按 frontmatter `name` 匹配已装技能；内容一致按文件树哈希判定。
7. 系统提示词正文 = `primary` 文件原文 `trim()`；头像文件转 dataURL 前限制 5MB。
8. 中立 Agent（`NEUTRAL_AGENT_ID`、`role='neutral'`、名 `中立 Agent`）**不参与冲突比对**，也不得被任何 persona 覆盖；候选 id 或显示名与之相同时记入 `errors`。
9. **名称与路径净化**：技能名与 persona id 只接受 `[a-z0-9-]+`（与 Agent Skills 规范一致）；含 `..`、`/`、`\`、绝对路径或控制字符的名称一律拒绝并记 `errors`。落盘前校验 `path.resolve` 结果仍位于 `skills/` 内。既有技能上传端点的 frontmatter `name` 未经净化（`admin.ts:245` 直接 `path.resolve('skills', name)`），本轮提取共享 helper 时一并补上，两条路径共用同一净化函数。

## UI 行为

- `AgentManager` 工具栏新增「导入 Agent 包」按钮 → 隐藏 file input（`.zip`）。
- 预览对话框分两块：
  - **人格**：每候选一行（头像、显示名、模型输入框默认为空、扩展档计数）；冲突行置警告样式，提供「覆盖 / 跳过 / 新建」选择（同源更新默认「覆盖」，否则默认「跳过」）。
  - **技能**：每技能一行（名称、描述）；同名冲突显示「已安装（内容不同）」，默认「跳过」，需显式勾选才覆盖。
- 提交 → toast 汇总（N 导入 / M 覆盖 / K 跳过）；刷新列表与技能表。
- i18n：新增 `settings.agentImport*` 键组（zh-CN / en）。

## 测试

### 单元测试（vitest，`src/server/agents-import/__tests__/`）

fixtures：`src/server/agents-import/__tests__/fixtures/`（人格正文为占位文本）。

1. 扩展形态完整包（plugin.json + 扩展清单 + 源技能目录 + 双人格 + 头像）→ 解析正确
2. 通用形态包（仅 `agents/*.md`）→ 按通用层发现
3. 共存形态且正文不一致 → `warnings` 命中
4. 非 AIP 包 → 400 语义错误
5. 路径穿越 zip → 拒绝
6. 坏清单（`formatVersion` 2 / id 大写 / `primary` 越界 / `primary` 缺失）→ 各自失败边界
7. 部分坏 persona（一个缺文件）→ 隔离：`errors` 含该条、其余候选保留
8. 中立 Agent 撞名（id=`neutral-agent` 或名=`中立 Agent`）→ 记入 `errors`，不进入冲突列表
9. 冲突比对：同名现库、同源更新判定
10. commit 决议映射：create/overwrite/skip/缺省 skip/无冲突 overwrite → 400；技能 install/skip/内容一致跳过
11. 模型不参与解析：包内含 `model` 字段被忽略（协议 §2.4）

### E2E goal set（chrome-devtools 驱动）

前置：`pnpm dev` 运行中、管理员密钥可得。

1. 管理面板 → AgentManager → 导入按钮出现
2. 上传 neko 包 fixture → 预览出现 8 个候选 + 1 个技能，无冲突
3. 确认导入 → toast + 列表出现 8 个 agent（头像来自包内 PNG）+ 技能表出现 neko
4. 再次上传同包 → 预览标记同源更新与技能内容一致，确认后列表仍 8 个、技能不重复安装
5. 直聊选中导入的 Agent → 发送消息 → 收到流式回复（外部 API 不可用时降级为「验证到 SSE 事件层」并明确记录）
6. 群聊（两个导入的 Agent）→ 产生多 Agent 气泡
7. 中立 Agent 不在导入冲突列表中；导入后其 `model`/`system_prompt` 未变
8. 数据库断言：`agents` 行含非空 `origin`

## 验收标准

1. 单测全部通过且各用例可独立失败（非恒真断言）。
2. E2E 清单逐项勾验（或明确标注降级原因）。
3. 既有行为不变：技能上传（改用共享 helper 后）回归通过；AgentManager 增删改/复制、中立 Agent 保护规则不受影响。
4. `tsc --noEmit` 无错误；oxlint 通过；oxfmt 检查通过。
5. 导入后删除 agent → 可从原包重新导入恢复；重复导入幂等。
6. 协议侧 `aip validate` 对同一 fixture 通过（双端契约一致）。
7. 恶意名称（含 `..`、`/`、`\`、绝对路径）的技能包被拒绝，且不产生 `skills/` 之外的写入；同一净化函数对既有技能上传端点生效（回归验证）。
