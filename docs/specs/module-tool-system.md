# Spec — 内置工具系统（Built-in Tool System）

## 概述

工具系统为 Momoi 提供基础操作能力（文件读写、网络请求、文档处理、技能加载、bash 命令执行），使 AI 能够执行具体任务而不仅仅是生成文本。工具作为 Agent 的**基础能力**内建，与插件系统（已移除）完全解耦。

所有工具操作在**沙盒化的对话工作区**中执行，确保无法访问宿主文件系统或项目文件。

**边界说明**：`SandboxFS` 约束的是**路径**（读写/列目录必须相对工作区根）；`bash` 工具只把 **cwd** 锁在沙盒内，子进程仍继承宿主环境，故敏感环境变量需单独剔除（见「Bash 工具安全」）。沙盒**不是**权限隔离，命令仍可在运行时访问宿主文件系统。

## 设计决策

### D-T01：为什么工具是内置的而不是插件

**问题**：移除插件系统时，工具也被误杀（`tools.ts` 返回空数组）。需要区分"基础能力"和"扩展能力"。

**决策**：工具是基础能力，插件是扩展能力。

**依据**：
- 工具（读写文件、发请求）是 Agent 的"手脚"，属于核心功能，不应被拆掉
- 插件是增值模块，按需安装卸载，属于扩展层
- 两者混为一谈会导致基础能力被意外移除

**实现**：
- 工具代码位于 `src/server/tools/`，作为项目源码的一部分
- 插件系统已移除（commit 3530176）
- `tools.ts` 调用 `getToolDefinitions()` 从内置 registry 聚合工具

### D-T02：为什么用目录沙盒而不是 Docker

**问题**：文件操作需要隔离，防止 AI 访问宿主系统。

**决策**：使用目录级沙盒（`data/workspaces/{conversationId}/`），不使用 Docker 容器。

**依据**：
- **Windows 部署复杂度**：Windows 11 上 Docker 需要 WSL2/Hyper-V，违背"轻量自托管"定位
- **性能开销**：容器启动和 IPC 通信增加延迟
- **足够安全**：目录沙盒通过路径验证、符号链接拒绝、保留文件名拦截提供足够的安全边界
- **业界实践**：Replit 早期也使用目录沙盒，后迁移到容器（但其场景更复杂）

**安全边界**：
- 所有路径必须相对于工作区根目录，拒绝绝对路径
- 路径解析后检查 `startsWith(root + sep)`，防止 `../` 穿越
- 拒绝符号链接（通过 `lstat` 检查）
- 拒绝 Windows 保留文件名（CON、PRN、NUL、COM1-9、LPT1-9）
- 工作区容量限制：100MB / 500 文件（可通过环境变量调整）
- 单文件大小限制：20MB（可通过 `WORKSPACE_MAX_FILE_BYTES` 调整）

**不保证**：
- 不提供进程级隔离（工具代码与主进程共享内存空间）
- 不提供网络级隔离（HTTP 工具可访问任意外部地址，但有 SSRF 防护）

### D-T03：为什么 PDF 只读不写

**问题**：是否需要支持生成 PDF 文件。

**决策**：PDF 只支持读取（提取文本），不支持生成。

**依据**：
- PDF 生成需要嵌入中文字体（SimHei、SimSun、Consolas），增加约 15MB 部署体积
- 字体文件路径在 Windows/Linux/macOS 上不一致，增加配置复杂度
- DOCX/PPTX/XLSX 已覆盖大多数文档生成场景
- 如果用户确实需要 PDF 生成，可以后续通过环境变量配置字体路径扩展

### D-T04：为什么 Skill 采用按需加载

**问题**：Skill 内容是全文注入系统提示词，还是只注入摘要。

**决策**：只注入 `name + description` 摘要，完整内容通过 `load_skill` 工具按需加载。

**依据**：
- **Token 成本**：全文注入会导致系统提示词膨胀，浪费 token
- **上下文窗口**：多个 Skill 叠加可能超出模型上下文限制
- **按需原则**：大多数对话不需要所有 Skill 的完整内容

**实现**：
- 系统提示词中列出 `## Available Skills` + 每个 Skill 的名称和描述
- AI 认为需要时调用 `load_skill(name)` 获取完整内容，或 `load_skill(name, path)` 加载技能内特定文件
- 提供 `list_skill_files(name)` 工具发现技能目录内的文件结构
- 技能通过递归扫描 `skills/` 目录树自动发现（任何含 SKILL.md 的目录都注册为技能）
- `load_skill` 返回内容上限 50K 字符，超出截断

### D-T05：为什么需要工具循环防护（已演进 → 被 D21 替代）

**问题**：AI 可能陷入工具调用死循环（如反复 `write_file` 同一个文件）。

**观察**：用户让 AI 写冷笑话，AI 思考过度进入 deadloop，不断生成文件（冷笑话.md、冷笑话2.md、冷笑话3.md...）。

**决策演进**：
- **初版（D-T05）**：`write_file` 第 2 次调用硬拒绝、第 3 次强制退出
- **D18**：改为软提醒——第 2 次调用返回温和提示（"已经是第 N 次调用，写完请回复用户"），但正常执行，不强制拒绝
- **D21（Pi Agent Core 迁移）**：代码级防护机制（漂移检测、write_file 计数器、轮数限制）已被 Pi Agent Core 内置循环替代。系统提示词中的硬性规则（防漂移、write_file 克制、工具调用节制）成为主要防护手段

**原因**：硬拒绝阻塞了合理的多文件写入场景（如生成报告含多个图表）；软提醒既防止无限循环，又允许合法多文件写入。

**当前状态（D21）**：代码级防护（漂移检测、write_file 计数器、MAX_TOOL_ROUNDS）已在 Pi Agent Core 迁移中被移除，改为系统提示词硬性规则控制。Pi Agent Core 内置的循环管理提供更优雅的多轮工具调用。

### D-T07：Pi 式并行批执行（已由 Pi Agent Core 替代）

### D-T06：为什么需要 bash 工具

**问题**：宜搭等技能需要执行 CLI 命令（如 openyida），纯文件操作工具不足以支持。

**决策**：新增 `bash` 工具，在沙盒工作区 cwd 下执行 shell 命令。

**安全设计**：
- cwd 锁定在沙盒内，防止访问宿主文件系统
- 破坏性命令黑名单（rm -rf /、format c:、shutdown 等）
- 超时终止（默认 30s，最大 120s）
- 输出截断（30K 字符）
- Windows 用 cmd.exe，其余用 /bin/sh，自动切 UTF-8 代码页
- **环境变量脱敏**：`spawn` 前经 `scrubEnv()` 剔除敏感变量（精确名单：`ADMIN_KEY`；通用规则：名称含 `_API_KEY`/`_APIKEY`/`_TOKEN`/`_SECRET`/`PASSWORD`/`PASSWD`/`CREDENTIAL` 的变量），防止 `set` / `echo %VAR%` 读出 `.env` 注入的密钥

### D-T07：Pi 式并行批执行（已由 Pi Agent Core 替代）

**问题**：传统 AI Agent 每轮工具调用串行执行，模型需要 N 轮才能完成 N 个工具，延迟高。

**决策**：同一轮内所有工具通过 `Promise.all` 并发执行，但结果按模型发起顺序回填，上下文不乱序。

**当前状态（D21）**：并行批执行逻辑已由 Pi Agent Core（`@earendil-works/pi-agent-core`）的 `runAgentLoop` 内置实现。`pi-adapter.ts` 配置 `toolExecution: 'parallel'` 即可启用。原有 `loop.ts` 中的手动管理代码已移除。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/server/tools/types.ts` | 定义 `ToolModule`、`ToolContext`、`ToolResult`、`ToolArtifact` 接口 |
| `src/server/tools/workspace.ts` | `SandboxFS` 类：沙盒化文件系统操作 |
| `src/server/tools/registry.ts` | 工具注册表，聚合所有内置工具 |
| `src/server/tools/file-tools.ts` | 文件工具：`read_file`、`write_file`、`list_files`、`delete_file` |
| `src/server/tools/http-tool.ts` | 网络工具：`http_request`（含 SSRF 防护） |
| `src/server/tools/document-tools.ts` | 文档工具：`read_document`、`write_document` |
| `src/server/tools/skill-tools.ts` | 技能工具：`load_skill`、`list_skill_files` |
| `src/server/tools/bash-tool.ts` | Bash 命令执行：`bash`（受限沙盒执行） |
| `src/server/tools/group-mention-tool.ts` | @mention 工具：`at_mention`（Agent 间点名调用） |
| `src/server/tools/index.ts` | 统一导出 |
| `src/server/ai/tools.ts` | 调用 `getToolDefinitions()` 聚合工具定义 |
| `src/server/ai/pi-adapter.ts` | Pi Agent 适配层：工具适配 + 循环入口 + 事件映射 |
| `src/server/routes/workspace.ts` | 工作区文件下载路由（需认证） |

## 数据模型

### ToolModule

```typescript
export interface ToolModule {
  definition: ToolDefinition  // 工具定义（名称、描述、参数 schema）
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}
```

### ToolContext

```typescript
export interface ToolContext {
  conversationId: string
  userId: string
  workspace: SandboxFS
  signal?: AbortSignal  // 可选的取消信号
}
```

### ToolResult

```typescript
export interface ToolResult {
  summary: string  // 一句话描述结果（用于 UI 显示和日志）
  error?: boolean  // 是否执行失败
  data?: unknown   // 可选的结构化数据（用于后续工具调用）
  artifacts?: ToolArtifact[]  // 可选的产物文件（用于 UI 下载）
  terminate?: boolean  // 终止信号：本批所有工具都置 true 时提前收口
}

export interface ToolArtifact {
  filename: string      // 工作区内的相对路径
  displayName: string   // 用户可见的文件名
  mimeType: string      // MIME 类型
  downloadUrl: string   // 下载 URL（带认证）
}
```

### SandboxFS

沙盒化文件系统操作类，所有路径必须相对于工作区根目录。

```typescript
export class SandboxFS {
  constructor(conversationId: string)
  ensureDir(): void                           // 确保工作区目录存在（惰性创建）
  getRoot(): string                            // 获取绝对根路径
  resolve(safePath: string): string            // 解析路径，拒绝穿越
  readFile(relPath: string, encoding: 'utf-8' | 'base64'): Promise<string>
  readFileRaw(relPath: string): Promise<Buffer>
  writeFile(relPath: string, content: string | Buffer, encoding?: string): Promise<void>
  deletePath(relPath: string): Promise<void>
  listDir(relPath: string, recursive?: boolean): Promise<Array<{ name, type, size }>>
  stat(relPath: string): Promise<fs.Stats>
  copyIn(srcAbsPath: string, destRelPath: string): Promise<void>
  exists(relPath: string): Promise<boolean>
}
```

## 工具清单

### 1. 文件工具（`file-tools.ts`）

#### `read_file`

读取工作区内的文本或二进制文件。

**参数**：
- `path` (string, required): 相对于工作区根目录的文件路径
- `encoding` (string, optional): `'utf-8'` 或 `'base64'`，默认 `'utf-8'`

**行为**：
- 检查路径是否在沙盒内
- 读取文件内容
- 文本模式：返回 UTF-8 字符串（截断至 50K 字符）
- 二进制模式：返回 Base64 编码字符串

**错误**：
- 路径穿越 → `Path traversal detected`
- 文件不存在 → `ENOENT`
- 无权限 → `EACCES`

#### `write_file`

写入文件到工作区。

**参数**：
- `path` (string, required): 相对于工作区根目录的文件路径
- `content` (string, required): 文件内容（文本或二进制）
- `encoding` (string, optional): `'utf-8'` 或 `'base64'`，默认 `'utf-8'`

**行为**：
- 检查路径是否在沙盒内
- 自动创建父目录
- 写入文件
- 返回 `ToolArtifact`（供 UI 下载）

**循环防护**（软提醒）：
- 首次调用：正常执行
- 第二次及以后：返回温和提示（"已经是第 N 次调用，写完请回复用户"），但正常执行

#### `list_files`

列出工作区内的文件和目录。

**参数**：
- `path` (string, optional): 相对于工作区根目录的目录路径，默认为根目录
- `recursive` (boolean, optional): 是否递归列出子目录，默认 `false`

**行为**：
- 检查路径是否在沙盒内
- 读取目录内容
- 返回文件/目录列表（含名称、类型、大小）

#### `delete_file`

删除工作区内的文件或目录。

**参数**：
- `path` (string, required): 相对于工作区根目录的路径

**行为**：
- 检查路径是否在沙盒内
- 拒绝删除根目录
- 递归删除目录或单个文件

### 2. 网络工具（`http-tool.ts`）

#### `http_request`

发起 HTTP 请求。

**参数**：
- `url` (string, required): 目标 URL
- `method` (string, optional): HTTP 方法，默认 `GET`
- `headers` (string, optional): JSON 字符串形式的请求头
- `body` (string, optional): 请求体（仅 POST/PUT/PATCH）
- `timeout` (number, optional): 超时秒数，默认 30，最大 120

**行为**：
- 验证 URL 格式
- SSRF 防护：解析域名到 IP，拒绝私有地址段（10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、127.0.0.0/8、169.254.0.0/16）
- 处理重定向（最多 3 次），每次重定向都重新验证 SSRF
- 发起请求，读取响应
- 文本响应：返回 UTF-8 字符串（截断至 5MB）
- 二进制响应：返回 Base64 编码字符串

**错误**：
- SSRF 拦截 → `SSRF blocked: private IP address`
- DNS 解析失败 → `ENOTFOUND`
- 超时 → `ETIMEDOUT`
- 非 2xx 响应 → 返回状态码和响应体

### 3. 文档工具（`document-tools.ts`）

#### `read_document`

读取并解析文档文件。

**参数**：
- `path` (string, required): 相对于工作区根目录的文档路径

**支持格式**：
- `.docx` → 使用 `mammoth` 提取文本
- `.doc` → 使用 `word-extractor` 提取文本
- `.pptx` → 使用 `adm-zip` + XML 解析提取幻灯片文本
- `.xlsx` → 使用 `xlsx` 提取表格数据（CSV 格式）
- `.xls` → 使用 `xlsx` 提取表格数据（CSV 格式）
- `.pdf` → 使用 `pdf-parse` 提取文本
- `.csv` → 直接读取 UTF-8 文本

**行为**：
- 根据扩展名选择解析器
- 提取文本内容（截断至 50K 字符）
- 返回提取的文本

**错误**：
- 不支持的格式 → `Unsupported document format`
- 解析失败 → 返回解析器错误信息

#### `write_document`

生成文档文件。

**参数**：
- `path` (string, required): 输出文件路径（扩展名决定格式）
- `content` (string, required): JSON 字符串，文档内容结构

**支持格式**：
- `.docx` → 使用 `docx` 库生成，内容为 `{ title, sections: [{ heading, paragraphs, body, table: { headers, rows } }] }`
- `.pptx` → 使用 `pptxgenjs` 生成，内容为 `{ title, slides: [{ title, bullets, body, notes }] }`
- `.xlsx` → 使用 `exceljs` 生成，内容为 `{ sheets: [{ name, headers, rows }] }`

**行为**：
- 根据扩展名选择生成器
- 生成二进制文件
- 写入工作区
- 返回 `ToolArtifact`（供 UI 下载）

**错误**：
- 不支持的格式 → `Unsupported document format`
- 内容结构不匹配 → 生成器错误信息

### 4. 技能工具（`skill-tools.ts`）

#### `load_skill`

按需加载技能的完整内容。

**参数**：
- `name` (string, required): 技能名称
- `path` (string, optional): 技能目录内的相对路径（如 `references/guide.md`），默认 `SKILL.md`

**行为**：
- 从 `skillRegistry` 获取技能
- 读取指定文件内容（去除 YAML frontmatter）
- 返回文本内容（截断至 50K 字符）
- 同时返回技能目录的文件列表，便于 AI 发现更多参考文件

**错误**：
- 技能不存在 → `Skill not found`，并列出可用技能
- 文件不存在 → 列出技能内可用文件

#### `list_skill_files`

列出技能目录内所有可读文件。

**参数**：
- `name` (string, required): 技能名称

**行为**：
- 从 `skillRegistry` 获取技能
- 递归扫描技能目录，收集所有文本文件（.md、.txt、.json、.yaml、.yml、.csv、.xml、.html、.css、.js、.ts）
- 返回相对路径列表

**错误**：
- 技能不存在 → `Skill not found`

### 5. Bash 工具（`bash-tool.ts`）

#### `bash`

在沙盒工作区内执行 shell 命令。

**参数**：
- `command` (string, required): 要执行的 shell 命令
- `cwd` (string, optional): 工作区内的相对子目录，默认工作区根目录
- `timeout` (number, optional): 超时秒数，默认 30，最大 120

**行为**：
- cwd 锁定在沙盒内，拒绝访问外部路径
- Windows 用 cmd.exe，其余用 /bin/sh
- Windows 自动切 UTF-8 代码页（`chcp 65001`）
- 输出截断至 30K 字符
- 超时强行终止（SIGTERM → 1s 后 SIGKILL）

**破坏性命令拦截**（黑名单子串匹配，大小写不敏感）：
- 清盘/格式化：`rm -rf /`、`del /s /q`、`rd /s /q`、`format c:`、`mkfs`、`dd if=/dev/zero`、`diskpart`
- 系统级破坏：`shutdown`、`reboot`、`hibernate`、`sc delete`、`reg delete`

**错误**：
- 空命令 → `Error: empty command`
- 黑名单命中 → `Blocked: 命令包含不允许的破坏性片段`
- cwd 不存在 → `Error: cwd "..." 不存在或不是目录`
- 超时 → `⏱ 已超时终止`
- 非零退出码 → 包含 `exit code N` 前缀

### 6. @mention 工具（`group-mention-tool.ts`）

#### `at_mention`

群聊中 @ 点名其他 Agent。

**参数**：
- `agent_name` (string, required): 要点名的 Agent 名称
- `message` (string, required): 发送给目标 Agent 的消息或问题

**行为**：
- 设置 `MentionSignal`（`triggered = true`）
- 被点名者立即应答，当前轮剩余 Agent 被跳过
- 最多 5 次重定向（`MAX_MENTION_REDIRECTS`）
- 返回 `terminate: true` 终止当前批

**错误**：
- 缺少参数 → `Error: both agent_name and message are required`
- 仅群聊模式下可用（通过 `createMentionTool` 动态注入）

## 工作区生命周期

### 创建

- **时机**：首次调用任何工具时（`bash` 工具在 `execute()` 中调用 `ctx.workspace.ensureDir()`）
- **位置**：`data/workspaces/{conversationId}/`
- **方式**：`SandboxFS` 构造函数中解析路径，`ensureDir()` 中 `fs.mkdirSync(root, { recursive: true })`

### 清理

- **时机**：删除对话时
- **方式**：`routes/conversations.ts` 的 `DELETE /api/conversations/:id` 中调用 `fs.rmSync(workspacePath, { recursive: true, force: true })`
- **容错**：工作区不存在时不报错

### 容量限制

- **默认**：100MB / 500 文件 / 单文件 20MB
- **配置**：环境变量 `WORKSPACE_MAX_BYTES`、`WORKSPACE_MAX_FILES`、`WORKSPACE_MAX_FILE_BYTES`
- **超限行为**：`writeFile` 抛出对应错误，工具返回失败

## 沙盒安全边界

### 路径验证

所有路径操作必须经过 `SandboxFS.resolve()`：

```typescript
resolve(safePath: string): string {
  if (path.isAbsolute(safePath)) {
    throw new Error('Absolute paths not allowed')
  }
  
  const basename = path.basename(safePath).toUpperCase().split('.')[0]
  if (RESERVED_NAMES.has(basename)) {
    throw new Error(`Reserved filename blocked: ${safePath}`)
  }
  
  const resolved = path.resolve(this.root, safePath)
  
  if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
    throw new Error(`Path traversal blocked: ${safePath}`)
  }
  
  return resolved
}
```

### 符号链接拒绝

- 读写操作前通过 `lstat` 检查
- 拒绝符号链接（防止指向沙盒外的路径）

### SSRF 防护

HTTP 工具在发起请求前：
1. 解析目标域名到 IP 地址
2. 检查 IP 是否属于私有地址段：
   - `10.0.0.0/8`（A 类私有）
   - `172.16.0.0/12`（B 类私有）
   - `192.168.0.0/16`（C 类私有）
   - `127.0.0.0/8`（环回）
   - `169.254.0.0/16`（链路本地，云元数据服务）
   - `0.0.0.0/8`（当前网络）
   - `224.0.0.0/4`（多播）
   - `240.0.0.0/4`（保留）
   - IPv6: `::1`（环回）、`fc00::/7`（唯一本地）、`fe80::/10`（链路本地）、`ff00::/8`（多播）
3. 命中则拒绝请求，返回 `SSRF blocked: private IP address`

### Bash 工具安全

- cwd 锁定在沙盒内，通过 `workspace.resolve()` + `stat().isDirectory()` 验证
- 破坏性命令黑名单（子串匹配，大小写不敏感）
- 超时强杀（SIGTERM → 1s 后 SIGKILL）
- 输出截断（30K 字符）
- **环境变量脱敏**：子进程 env 由 `scrubEnv()` 构造——剔除精确名单（`ADMIN_KEY`）与通用规则命中项（名称含 `_API_KEY`/`_APIKEY`/`_TOKEN`/`_SECRET`/`PASSWORD`/`PASSWD`/`CREDENTIAL`，大写匹配），其余变量照常继承。新增密钥命名遵循通用规则即可自动生效；特例加入 `BLOCKED_ENV_VARS`

## AI 循环防护机制（D21 更新）

多轮工具调用循环现由 Pi Agent Core（`@earendil-works/pi-agent-core`）的 `runAgentLoop` 内置管理。以下代码级防护已在 Pi 迁移中移除，改为系统提示词硬性规则：

- **轮数限制**：Pi Agent Core 内置多轮管理
- **漂移检测**：已移除，由提示词中的「不要反复调用相同工具」约束替代
- **输出截断终止**：已移除，Pi 流式处理自行管理
- **批量终止**：Pi Agent Core 内置并行执行策略
- **write_file 软提醒**：已移除，由提示词中的「克制文件写入」约束替代
- **统一收口**：Pi Agent Core 保证每条路径都有终态事件

## API 端点

### GET /api/workspace/:conversationId/file/:filepath

下载工作区内的文件（需认证）。

**认证**：需用户 JWT（`userAuthMiddleware`）。

**参数**：
- `:conversationId` (path): 对话 ID
- `:filepath` (path): 工作区内的相对路径（URL 编码）

**行为**：
1. 验证对话所有权（`user_id === currentUser`）
2. 构造 `SandboxFS` 实例
3. 读取文件
4. 返回文件流，`Content-Disposition: attachment; filename*=UTF-8''{原始名}`

**错误**：
- 对话不存在或无权限 → `404`
- 文件不存在 → `404`
- 路径穿越 → `400`

**缓存**：`Cache-Control: private, max-age=3600`（1 小时，因为工作区内容可能变化）

## 前端集成

### SSE 事件

#### `tool_call`

工具调用开始（AI 发起调用时立即发送）。

```typescript
{
  type: 'tool_call',
  name: string,  // 工具名称
  input: object  // 工具参数
}
```

#### `tool_execution_start`

工具实际执行开始（在 `tool_call` 之后、执行之前发送，用于区分"AI 调用了"和"实际执行了"）。

```typescript
{
  type: 'tool_execution_start',
  id?: string,      // 工具调用 ID
  name: string,     // 工具名称
  input: object     // 工具参数
}
```

#### `tool_result`

工具调用结果。

```typescript
{
  type: 'tool_result',
  id?: string,          // 工具调用 ID
  name: string,         // 工具名称
  summary: string,      // 一句话描述结果
  artifacts?: ToolArtifact[]  // 可选的产物文件
}
```

### 消息气泡渲染

`MessageBubble.tsx` 中：
- 工具调用显示为 `🔧 {name}` + `→ {summary}`
- 产物文件显示为 `AttachmentCard` 下载卡片
- 复用现有的 `AttachmentCard` 组件

### 下载流程

1. 用户点击 `AttachmentCard`
2. 调用 `GET /api/workspace/:conversationId/file/:filepath`（带 JWT）
3. 接收文件流
4. 触发浏览器下载（`Blob` + `createObjectURL`）

## 验收标准

### 功能验收

1. ✅ `write_file` 可以在工作区创建文件，UI 显示下载卡片
2. ✅ `read_file` 可以读取工作区内的文件
3. ✅ `list_files` 可以列出工作区内的文件
4. ✅ `delete_file` 可以删除工作区内的文件
5. ✅ `http_request` 可以发起 GET/POST 请求，返回响应内容
6. ✅ `http_request` 拒绝私有 IP 地址（SSRF 防护）
7. ✅ `read_document` 可以解析 `.docx`、`.pptx`、`.xlsx`、`.pdf`、`.csv`
8. ✅ `write_document` 可以生成 `.docx`、`.pptx`、`.xlsx`
9. ✅ `load_skill` 可以按需加载技能的完整内容
10. ✅ `list_skill_files` 可以列出技能目录内的文件
11. ✅ `bash` 可以在沙盒内执行 shell 命令
12. ✅ `dingtalk_token` 可以获取钉钉 access token
13. ✅ `at_mention` 可以在群聊中 @ 点名其他 Agent

### 安全验收

14. ✅ 路径穿越攻击被拒绝（`../etc/passwd` → `Path traversal blocked`）
15. ✅ 符号链接被拒绝（指向沙盒外 → `Symlinks not allowed`）
16. ✅ 保留文件名被拒绝（`CON.txt` → `Reserved filename blocked`）
17. ✅ SSRF 攻击被拦截（`http://192.168.1.1` → `SSRF blocked`）
18. ✅ 工作区容量超限时报错（`Workspace quota exceeded`）
19. ✅ bash 破坏性命令被拦截（`rm -rf /` → `Blocked`）
20. ✅ bash 超时后强制终止

### 循环防护验收（D21 更新）

> 以下验收项中的代码级防护已在 Pi Agent Core 迁移中移除，改为系统提示词硬性规则。Pi Agent Core 内置循环管理确保每条路径都有终态事件。

21. ✅ `write_file` 第一次调用正常执行
22. ✅ `write_file` 第二次及以后返回温和提示但正常执行（软提醒）
23. ✅ 漂移检测：提示词中约束反复调用同一工具
24. ✅ 最大轮数限制：Pi Agent Core 内置管理
25. ✅ 输出截断：Pi 流式处理自行管理
26. ✅ 批量终止：Pi Agent Core 内置并行执行策略
27. ✅ 统一收口：Pi Agent Core 保证每条路径都有终态事件

### 生命周期验收

28. ✅ 删除对话时工作区被清理
29. ✅ 工作区不存在时删除对话不报错
30. ✅ 新对话首次调用工具时工作区被创建

### 前端集成验收

31. ✅ 工具调用在消息气泡中显示为 `🔧 {name} → {summary}`
32. ✅ 产物文件显示为下载卡片，点击可下载
33. ✅ 下载请求携带 JWT，未认证返回 401

## 外部依赖

- **文件工具**：Node.js `fs/promises`、`path`
- **HTTP 工具**：Node.js `fetch`、`dns/promises`
- **文档读取**：`mammoth`（DOCX）、`word-extractor`（DOC）、`adm-zip`（PPTX）、`xlsx`（XLSX/XLS）、`pdf-parse`（PDF）
- **文档生成**：`docx`（DOCX）、`pptxgenjs`（PPTX）、`exceljs`（XLSX）
- **沙盒**：无外部依赖，纯 Node.js `fs` + 路径验证
- **Bash 工具**：无外部依赖，纯 Node.js `child_process.spawn`

## 未来扩展

### 代码执行工具

**现状**：bash 工具已提供基础 shell 执行能力。

**挑战**：
- 需要进程级隔离（Docker 容器或 WASM）
- 需要资源限制（CPU 时间、内存、网络）
- 需要支持多语言（Python、JavaScript、Shell）——bash 工具已覆盖 Shell

**建议**：如需更严格的多语言隔离，作为插件实现。

### 数据库查询工具

**现状**：未实现。

**挑战**：
- 需要沙盒化数据库（独立 SQLite 实例）
- 需要 SQL 注入防护
- 需要结果集大小限制

**建议**：作为插件实现，或提供只读查询接口。

### 工具权限控制

**现状**：所有工具对所有用户开放。

**未来**：管理员可以配置哪些用户/角色可以使用哪些工具。