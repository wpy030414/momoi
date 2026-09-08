# Spec — 技能系统（Skill System）

## 概述

技能系统通过 SKILL.md 文件为 AI 提供领域知识和行为指令。系统提示词中**仅注入技能摘要**（名称 + 描述），完整内容由 AI 按需通过 `load_skill` 工具加载，避免提示词膨胀。

技能通过递归扫描 `skills/` 目录树自动发现，任何含 `SKILL.md` 的目录都注册为技能。支持嵌套子技能（如 `yida-skills` 下的 `yida-login`、`yida-app` 等各自独立注册）。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/server/skills/loader.ts` | 加载技能文件 + 解析前置元数据（支持折叠/字面块标量）+ 注册表 |
| `src/server/ai/pi-adapter.ts` | `buildSystemPrompt()` 中注入技能摘要 |
| `src/server/tools/skill-tools.ts` | `load_skill` / `list_skill_files` 工具实现 |
| `src/server/routes/admin.ts` | 管理员上传/卸载技能 |

## 技能目录结构

```
skills/{skill-name}/
├── SKILL.md        # 前置元数据 + Markdown 指令（必须）
├── references/     # 参考资料（可选）
│   └── *.md
├── skills/         # 子技能（可选，各自独立注册）
│   └── */SKILL.md
└── README.md       # 文档（可选）
```

## SKILL.md 格式

```markdown
---
name: my-skill
description: 帮助处理 X 类任务
version: 1.0.0
---

当用户询问关于 X 的问题时，请遵循以下准则：

1. 首先确认用户的需求
2. 给出具体可行的建议
3. 提供相关示例

注意事项：
- 不要编造数据
- 始终引用可靠来源
```

### 前置元数据字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 技能名称（唯一标识） |
| `description` | ✅ | 技能描述 |
| `version` | ❌ | 版本号 |

### YAML 解析特性

`description` 字段支持 YAML 折叠标量（`>`）和字面块标量（`|`），适合多行描述：

```yaml
# 折叠标量（多行合并为空格分隔的单行）
description: >
  这是一个很长的描述，
  会被合并为一行。

# 字面块标量（保留换行）
description: |
  第一行
  第二行
```

## 行为约束

### 加载

1. 递归扫描 `skills/` 目录树（`loader.ts:walk()`）
2. 读取每个含 `SKILL.md` 的目录
3. 解析 YAML 前置元数据（简易解析器，支持扁平 `key: value` 以及折叠/字面块标量）
4. 提取元数据后的 Markdown 正文作为技能内容
5. 启动时自动加载，通过 `SkillRegistryClass.refresh()` 刷新
6. 聚合技能包（如 `yida-skills`）下的嵌套子技能也各自独立注册

### 注入系统提示词（摘要模式）

在 `pi-adapter.ts:buildSystemPrompt()` 中，**仅注入名称和描述**：

```
{agent.system_prompt}

## Available Skills
以下是已安装的技能摘要。技能库可能不完整：如果用户的请求没有与某个技能描述明显匹配，请直接如实告知用户当前技能库中是否有可用技能，不要强行加载技能试探。如需查看某个技能的完整内容，请调用 load_skill 工具。

- **{skill.manifest.name}**: {skill.manifest.description}

{思考模式指令 / 无限模式指令 / 群组对话规则}

## 建议
...（非无限模式下的硬编码 suggestions 格式指令）
```

- 技能按注册表顺序列出
- 每个技能仅一行：`- **{name}**: {description}`
- 完整内容通过 `load_skill` 工具按需加载
- 包含技能止损提示：不匹配时不要反复试探

### 按需加载工具

#### `load_skill`

- **参数**：`name`（技能名称），`path`（可选，默认 `SKILL.md`）
- **行为**：读取技能目录下指定文件的完整内容
- **返回**：文件内容（截断至 50K 字符）+ 技能目录下所有文件列表
- **安全**：路径验证通过 `resolveSkillPath()` 防止穿越到技能目录外

#### `list_skill_files`

- **参数**：`name`（技能名称）
- **行为**：递归扫描技能目录，返回所有可读文件（`.md`、`.txt`、`.json`、`.yaml`、`.yml`、`.csv`、`.xml`、`.html`、`.css`、`.js`、`.ts`）
- **用途**：AI 发现 `references/`、子技能等额外资源

### 上传

1. 管理员通过 `POST /api/admin/skills/upload` 上传 zip 文件
2. 最大 50MB
3. Zip slip 防护（`entry.entryName.includes('..')`）
4. 自动检测包装目录（`resolveZipRoot()`）
5. 清理 macOS 产物（`__MACOSX` 目录和 `.DS_Store`）
6. 验证 `SKILL.md` 存在且包含有效的 YAML 前置元数据
7. `name` 字段必填
8. 解压到 `skills/{name}/`

### 卸载

1. `DELETE /api/admin/skills/:name`
2. 递归删除目录
3. 刷新注册表

## API 端点

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| GET | `/api/admin/skills` | JWT | 列出已安装技能 |
| POST | `/api/admin/skills/upload` | JWT | 上传技能 zip |
| POST | `/api/admin/skills/install` | JWT | 安装已有目录 |
| DELETE | `/api/admin/skills/:name` | JWT | 卸载技能 |