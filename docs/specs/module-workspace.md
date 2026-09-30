# Spec — 会话工作区（Workspace）

## 概述

会话分组工作区：侧边栏的文件夹语义。会话在**创建时锁定**一个工作区（或未分组），之后**不可移动**；同一工作区内的所有会话**共享文件沙箱目录**，实现更精细的会话管控。

> 命名辨析：本模块的「工作区」= **会话分组**（`workspaces` 表、`/api/workspaces`）。
> 另一个同名的「会话文件沙箱」是 SandboxFS（`tools/workspace.ts`、`data/workspaces/` 目录），
> 其下载路由在 `/api/files`（旧前缀 `/api/workspace` 为永久别名）。两者关系见下文「沙箱根解析」。

### 核心不变量

`conversations.workspace_id` **只在创建时写入，永不 UPDATE**：

| 场景 | 行为 |
|---|---|
| 创建会话时指定 `workspace_id` | 校验归属（404 `WS_NOT_FOUND` 防探测）→ 写入 → 锁定 |
| 未指定 / 显式 null | NULL = 未分组，独享会话级沙箱 `data/workspaces/<convId>/` |
| 删除工作区 | 单行 `DELETE FROM workspaces`；成员会话的 `workspace_id` **悬空**（原样保留），前端按未分组渲染 |
| 悬空的 workspace_id | 不可再被新会话锁定（归属校验 404）；成员会话的沙箱**仍锚定原 `ws-<id>` 目录**，文件照旧可访问，旧共同体成员之间仍共享 |

磁盘目录**永不删除、永不迁移**：零数据丢失、历史附件 URL 零改写。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `apps/server/src/routes/workspaces.ts` | 工作区 CRUD + `resolveWorkspaceAnchor`（创建链路共用的归属校验） |
| `apps/server/src/db/schema.sqlite.ts` / `schema.pg.ts` | `workspaces` 表 + `conversations.workspace_id` 列 |
| `apps/server/src/tools/workspace.ts` | `SandboxFS.forConversation`（沙箱根解析工厂） |
| `apps/web/src/components/sidebar/Sidebar.tsx` | 标题区（搜索/添加按钮）、分组折叠渲染、工作区行内重命名、悬停菜单 |
| `apps/web/src/components/sidebar/ConversationSearchDialog.tsx` | 会话搜索对话框（标题 + 消息内容） |
| `apps/web/src/components/sidebar/NewWorkflowDialog.tsx` | 新工作流的目标工作区选择 |
| `apps/web/src/components/chat/InputBar.tsx` | 输入框工作区下拉（新会话的目标工作区选择；已有会话禁用展示归属） |
| `apps/web/src/hooks/useChat.ts` | `workspaces` 状态、`newChatWorkspaceId`（新会话工作区选择）、SSE 联动 |

## 接口契约

全部要求用户 JWT（`userAuthMiddleware`）。越权与不存在统一 404（防探测）。

### GET /api/workspaces

响应 `{ workspaces: Workspace[] }`，按 `created_at` 升序（侧边栏稳定顺序）。

### POST /api/workspaces

请求 `{ name: string }`（trim 后非空，截断 40 字符；空 → 400 `WS_NAME_REQUIRED`）。
响应 201 `{ workspace }`。写后 `broadcastConversationSync(userId)`（多设备侧边栏联动）。

### PATCH /api/workspaces/:id

请求 `{ name }`（校验同 POST）。响应 `{ workspace }`。重命名是工作区唯一的可变项。

### DELETE /api/workspaces/:id

响应 `{ success: true }`。**单行 DELETE**（无事务也原子）：成员会话 `workspace_id` 悬空、前端按未分组渲染；磁盘 `ws-<id>/` 目录保留。非空工作区可直接删除——「删除」只是解散分组标签。

### 会话创建链路注入 workspace_id（三处共用 `resolveWorkspaceAnchor`）

| 入口 | 位置 |
|---|---|
| `POST /api/chat`（单聊/群聊草稿的**首条消息**落库） | `routes/chat.ts`；SSE 流式上下文以 `error` 事件返回 `WS_NOT_FOUND`（不能 throw） |
| `POST /api/worlds`（世界同步落库） | `routes/worlds.ts` |
| `POST /api/conversations`（草稿态上传附件提前建会话） | `routes/conversations.ts` |

`PATCH /api/conversations/:id` **不支持** workspace_id（锁定后不可移动）。

### GET /api/conversations/search?q=

⚠️ 必须注册在 `GET /api/conversations/:id` **之前**（Hono 按注册顺序匹配，否则 `search` 被参数路由吞掉）。

- `q` trim 后截 64 字符；空 → `{ results: [] }`
- 标题命中（`lower(title) LIKE`，limit 20）+ 内容命中（messages JOIN，`role IN ('user','assistant')` 排除工具噪声，内层 limit 200）→ JS 合并：标题优先、内容按会话去重补足 20
- LIKE 通配符 `%`/`_`/`\` 转义 + `ESCAPE '\'`（SQLite/PG 双方言同构）
- snippet 纯 JS 生成：命中词前后各 ~40 字符、总长上限 140、空白折叠

响应：

```json
{ "results": [{
  "conversation": { "id": "...", "title": "...", "type": "direct", "agent_id": "...", "updated_at": 0, "workspace_id": null },
  "matched": "title" | "content",
  "snippet": "…"   // matched=content 时必有
}] }
```

### GET /api/conversations（列表扩展）

响应条目新增 `workspace_id` 字段（普通列，非子查询）。

## 沙箱根解析（文件共享语义）

```
data/workspaces/
  <conversationId>/   # 会话私有沙箱（未选工作区）
  ws-<workspaceId>/   # 工作区共享沙箱（锁定该工作区的会话共用；工作区删除后仍锚定）
```

`SandboxFS.forConversation(convId)`（`tools/workspace.ts`）：

- 查 `conversations.workspace_id`：非空 → 根 = `data/workspaces/ws-<id>`；NULL / 查询异常 → 根 = `data/workspaces/<convId>`（文件层绝不让聊天主链路炸掉）
- `ws-` 前缀隔离 workspace id 与 conversation id 两个 UUID 命名空间
- 鉴权归调用方路由；写路径 = 读路径 = 当前根（workspace_id 锁定 → 无回退逻辑）

| 会话状态 | AI 工具可见（rw） | 用户下载/历史附件可见（ro） |
|---|---|---|
| 未分组 | 私有目录 `<convId>/` | 同左 |
| 锁定工作区 W | `ws-W/`（全组共享） | `ws-W/` |

调用点：`routes/files.ts`（下载）、`routes/upload.ts`（上传落当前根）、`routes/chat.ts`（附件拷贝/来源）、`ai/pi-adapter.ts`（AI 工具上下文——bash cwd、file-tools 自动跟随共享根）。

**配额语义**：`WORKSPACE_MAX_*`（默认 100MB / 500 文件）按**共享目录**计——全组成员共用一份额度；工具写同名文件后写覆盖先写（共享文件夹的本意）。

## 文件下载路由与历史 URL 兼容

- 新前缀：`GET /api/files/:conversationId/file/*filepath`（`routes/files.ts`，前身为 `routes/workspace.ts`）
- 旧前缀 `/api/workspace/...` 作为**永久别名**挂载同一路由——历史 URL 持久化在 `messages.attachments` 与 tool trace JSON 中，别名避免其 404。**移除别名前必须先做数据迁移**（见 DECISIONS）
- 新生成的 URL（upload.ts、document-tools.ts）一律用 `/api/files/` 前缀
- `chat.ts` 的 `parseWorkspaceUrl` 以正则显式兼容两种前缀（2026-09 重写并修复了旧实现的按位解析缺陷）

## 数据库 Schema

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- conversations 追加列（不加外键，与 wechat_bindings 同款无约束模式）：
-- workspace_id TEXT   -- 创建时锁定；NULL=未分组；悬空=原工作区已删除
```

迁移（零迁移工具、启动幂等）：SQLite 侧 try/catch 裸 `ALTER TABLE conversations ADD COLUMN workspace_id TEXT`；PG 侧 `ADD COLUMN IF NOT EXISTS`。详见 `docs/specs/module-database.md`。

## 归档（Archive）

会话「删除」在 UI 与 API 语义上称为**归档**：`DELETE /api/conversations/:id` 置 `deleted_at`（软删除）、从列表移除、自动解绑微信/QQ——数据与工作区文件保留。前端文案/确认框均为「归档」（`sidebar.archive`）。

## 行为约束

1. `workspace_id` 永不 UPDATE——任何「移动会话」的需求都不在本模块范围（设计上被排除）
2. 删除工作区不触碰磁盘目录；重建同名工作区 = 新 id 新目录
3. 前端对悬空 `workspace_id` 必须按未分组渲染（防御渲染，`Sidebar.ungrouped` 过滤）
4. 工作区 CRUD 后必须 `broadcastConversationSync(userId)` 驱动多设备刷新
5. 新会话的目标工作区由**输入框下拉**统一选择（`useChat.newChatWorkspaceId`，null = 未分组）：显式新建草稿与首页隐式草稿共用同一选择，随首条消息发送；草稿态上传附件提前建会话时同样携带（`App.ensureConversation`）。已有会话的下拉禁用并展示归属（不可移动）

## 验收标准

- CRUD：建/改名/删工作区；空名 400；越权/不存在 404；列表 created_at 升序
- 删除非空工作区 → 成员会话立即出现在未分组；新会话不可再锁定已删工作区
- 新建会话锁定工作区（输入框下拉选择、新工作流对话框选择）→ 首条消息后会话出现在该工作区下，AI 文件操作落在 `ws-<id>/`
- 同工作区两个会话：A 写文件，B 的 AI 可见；配额共享
- 未分组会话文件落 `<convId>/`，行为与改造前完全一致
- 搜索：标题/内容命中、`%` 转义、空 q、snippet 与高亮；点击结果跳转
- 归档：确认框 → 会话从列表消失；历史 URL（新旧前缀）下载均 200
- E2E：`npx tsx scripts/test-workspaces-e2e.ts --stand-alone`（内存级 20 断言，不落盘）
