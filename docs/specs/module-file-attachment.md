# Spec — 文件附件（File Attachment）

## 概述

文件附件模块负责把用户上传的文件转换为模型可消费的形式（多模态 image_url 或纯文本），并持久化附件元数据。整个功能由管理员配置项 `support_attachments` 全局开关，**默认为关闭**。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/server/routes/upload.ts` | 文件上传与下载服务 |
| `src/server/files/parser.ts` | 附件解析（图片/Excel/PDF/文本/二进制） |
| `src/server/routes/chat.ts` | 把解析结果拼装成模型消息 |
| `src/client/components/chat/InputBar.tsx` | 附件选择与上传交互 |
| `src/client/components/chat/AttachmentCard.tsx` | 消息中的附件卡片展示 |

## 数据模型

```typescript
interface Attachment {
  url: string    // /api/upload/file/{uuid}{ext}
  name: string   // 用户看到的原始文件名
  size: number   // 字节
  type: string   // MIME
}
```

- 消息侧以 JSON 序列化存入 `messages.attachments`（可空）
- 附件元数据入库，**文件本体存磁盘 `uploads/` 目录**，DB 只存 URL

## 存储与命名

- 目录：`uploads/`（启动时自动创建）
- 文件名：`{randomUUID()}{原扩展名}` —— 扩展名保留，其余全部替换，杜绝路径穿越与文件名冲突
- 上传限制：**20MB**，超出返回 `400 { "error": "File too large (max 20MB)" }`

## 接口契约

### POST /api/upload

需用户 JWT（`middleware/userAuth.ts`，严格模式）。`multipart/form-data`，字段名固定为 `file`。

**响应**：
```json
{ "url": "/api/upload/file/6f1a...c2.png", "name": "原文件名.png", "size": 20480, "type": "image/png" }
```

**错误**：无文件 → 400 `No file provided`；超限 → 400；未认证 → 401

### GET /api/upload/file/:filename

**需用户 JWT**（`uploadRoute.use('/*', userAuthMiddleware)` 覆盖了本端点，实测无 token 返回 401）。

- 文件名先经 `path.basename()` 处理，只取基名，防路径穿越
- `Content-Disposition: attachment; filename*=UTF-8''{原始名}`（支持中文名，可用 `?name=` 覆盖下载名）
- `Cache-Control: public, max-age=31536000, immutable`（UUID 命名故可永久缓存；注意此头仅对「已带 JWT 通过校验」的请求有意义）
- MIME 由扩展名映射表推断，未知类型回退 `application/octet-stream`
- 文件不存在 → `404 Not found`（纯文本响应）

> **设计后果**：附件下载经 HttpOnly Cookie 认证（同源 fetch 自动携带），URL 不能直接塞进 `<img src>` / `<a href>`（浏览器子资源请求不带 Cookie → 401）。因此前端展示/下载附件一律走 `fetch(url)` → 转 `Blob` → `createObjectURL`，见 `AttachmentCard.downloadFile`。若将来需要在 `<img>` 中内联预览图片附件，须改为：登录态图片转 base64 内联，或引入短时效签名 URL。

## 解析规则（`parseAttachment`）

按**扩展名优先、MIME 兜底**的顺序分支：

| 类型 | 判定 | 处理方式 | `kind` |
|---|---|---|---|
| 图片 | `.png .jpg .jpeg .gif .webp .bmp .svg` 或 `image/*` | 整文件转 base64 data URL | `image` |
| Excel | `.xlsx .xls` | 逐 sheet 转 CSV，前缀 `## Sheet: {名}` | `text` |
| PDF | `.pdf` | `pdf-parse` 提取纯文本 | `text` |
| 文本 | `.txt .md .csv .json .log .xml .yaml .yml` 或 `text/*` | 直接按 UTF-8 读取 | `text` |
| 其他 | — | 不读取内容，仅输出元信息摘要 | `binary` |

- **截断**：文本类内容超过 `50_000` 字符即截断，并追加 `... (内容已截断，共 N 字符)`
- **容错**：Excel/PDF/文本解析失败时不抛异常，而是把错误信息作为文本内容回填（`[无法解析 X 文件: ...]`），保证对话不中断

## 消息拼装（chat.ts）

```
遍历 attachments:
  1. 由 url 取最后一段作为文件名 → 拼磁盘路径 uploads/{filename}
     （同时兼容 /uploads/xxx 与 /api/upload/file/xxx 两种形式）
  2. 文件不存在 → textParts.push("[附件 {name}: 文件未找到]")，跳过
  3. 解析：
     kind=image  → 收入 imageParts，并 textParts.push("[图片: {name}]")
     kind=text   → textParts.push("\n--- 附件: {name} ---\n{content}\n---")
     kind=binary → textParts.push(parsed.content)
  4. 解析抛错 → textParts.push("[附件 {name}: 解析失败 - {msg}]")

最终 userMessage：
  有图片 → ContentPart[] = [{type:'text', text: 用户文本+textParts}, ...imageParts]  // 多模态
  无图片 → string = 用户文本 + textParts.join('\n')                                   // 纯文本
```

**关键点**：图片走 `image_url` 多模态通道，文本类附件**直接内联进文本正文**（以 `--- 附件: 名称 ---` 分隔），因此对不支持多模态的模型也能降级工作。

## 前端行为

- 附件按钮仅在 `support_attachments === true` 时渲染（`App.tsx` 从 `GET /api/app-name` 读取）
- 支持一次选择多个文件，串行上传
- 上传中的文件以卡片预览，发送前可逐个移除
- 发送后附件元数据随消息持久化，历史消息中的附件渲染为可下载卡片

## ✅ 已修复：上传与下载未携带 JWT

**历史缺陷（已于 D14 修复，D33 Cookie 化后简化）**：早期 `InputBar` 上传与 `AttachmentCard` 下载都直接 `fetch` 而未附加 `Authorization` 头，导致开启附件后必然 401。D14 修复为手动附加 `Bearer` 头；D33 将认证迁移至 HttpOnly Cookie 后，`fetch` 无需显式携带凭证——同源请求由浏览器自动附带 Cookie，`InputBar` 与 `AttachmentCard` 的代码也因此简化。

- 上传：管理员开启 `support_attachments` 后，用户选文件必然 401 失败，错误仅落在 `console.error`，表现为「附件莫名消失」
- 下载：消息中的附件卡片点击下载必然 401

**修复内容**：

1. `src/client/components/chat/InputBar.tsx` — 上传 `fetch` 不设 `Content-Type`（交给浏览器生成 multipart boundary）；认证经同源 HttpOnly Cookie 自动携带；`catch` 分支有内联可见的错误提示（`uploadError` state + 可关闭的 `bg-destructive` 提示条）
2. `src/client/components/chat/AttachmentCard.tsx` — `downloadFile` 的 `fetch` 同样经 HttpOnly Cookie 认证
3. i18n：`chat.uploadFailed` 键（zh-CN / en）

**实测验证**（隔离临时库，带 JWT 上传→200，带 JWT 下载→200 且返回原内容，无 JWT 上/下载→401）。

## 验收标准

1. `support_attachments=false` 时输入框不出现附件按钮
2. `support_attachments=true` 时可上传成功、可下载 ✅
3. 图片附件在模型请求中体现为 `image_url` 内容部件
4. 20MB 上限、UUID 命名、路径穿越防护均生效
5. 已删除的上传文件被引用时，回复中体现 `[附件 X: 文件未找到]` 而非报错
6. 上传失败时界面显示可见错误提示，而非静默丢失
