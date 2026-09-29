# module-errors — 业务错误码契约

> 职责：定义前后端共享的错误标识体系——错误码枚举、wire 形状、参数约定与扩展流程。
> 唯一事实来源：`packages/shared/src/errors.ts`（`ErrCode` 枚举 + `ERR_REGISTRY`）。

## 为什么需要错误码

迁移前（2026-09 之前）的错误通道是「英文句子 + 前端反向翻译」：

- 后端 179 个错误点手写 `{ error: '<英文句子>' }`，9 种响应体形状变体，中英文混杂；
- 前端 `st()` 从 en locale 的 `serverSide` 段构建「句子 → i18n 键」反向映射，靠精确/正则匹配还原——中文后端消息与动态透传消息（`err.message`、上游报错）永远匹配不上，en/ja 用户会看到原样中文或英文技术细节；
- 未捕获异常经 Hono 默认处理器把纯文本 500 直接暴露。

错误码把「错误身份」从自然语言句子解耦为机器契约：前端 `errT()` 按 `errors.<CODE>` 直查 i18n，不再存在匹配失败。

## wire 形状（唯一契约）

### REST 错误响应

```jsonc
// HTTP <status>（来自 ERR_REGISTRY 默认值）
{ "code": "CONV_NOT_FOUND" }
{ "code": "UPLOAD_FILE_TOO_LARGE", "params": { "limit": "20MB" } }
```

- **不发 `message`**：人类可读描述只存在于三语 locale；服务端日志（`ApiError.log` + `cause` 堆栈）承载调试细节，不上 wire。
- `params` 值类型仅 `string | number`；某码的 params 为「全有或全无」——调用点要么提供注册表声明的全部参数，要么不传。

### SSE error 事件（`ServerMessage` error 变体）

```jsonc
{ "type": "error", "code": "AI_UPSTREAM_ERROR", "params": { "detail": "HTTP 502: bad gateway" } }
```

与 REST 错误同构（`code` + `params`）。流已 200 开出后不能 throw，直接 `send`。

### 结构化校验载荷（HTTP 200 内嵌）

| 场景 | 载荷 |
|---|---|
| 配置导入校验失败 | `{ ok: false, errors: ImportIssue[], warnings: ImportIssue[] }`，`ImportIssue = { path, code: CONFIG_IMPORT_*, params? }` |
| 微信绑定轮询过期 | `{ status: 'expired', code: 'WECHAT_CONV_DELETED' }` |
| QQ 绑定信息 | `{ bound, ..., error_code?: 'QQ_CONNECTION_FAILED', error_detail?: string }` |
| OAuth 回调失败 | `302 → /?oauth_error_code=<CODE>&oauth_error_detail=<...>` |
| prompts 未知 target | `404 { code: 'NOT_FOUND', targets: [...] }`（保留附加字段） |

### 全局兜底

- 未捕获异常 → `app.onError` → `{ code: 'INTERNAL' }` @ 500，堆栈只进日志；
- `/api/*` 未匹配 → `app.notFound` → `{ code: 'NOT_FOUND' }` @ 404。

## 参数约定

| 参数 | 语义 |
|---|---|
| `detail` | 动态透传内容（上游错误文本、异常摘要），服务端截断（≤300 字符）后上 wire |
| `limit` / `seconds` / `id` / `name` / `ext` / `allowed` / `key` / `field` / `version` / `section` | 结构化参数，供 i18n 模板 `{{param}}` 插值 |

i18n 模板占位符必须与 `ERR_REGISTRY` 声明的 params 名单完全一致（一致性测试强制）。

## 服务端用法

```ts
import { ApiError } from '../lib/apiError.js'
import { ErrCode } from '@momoi/shared/errors'

throw new ApiError(ErrCode.CONV_NOT_FOUND)
throw new ApiError(ErrCode.UPLOAD_FAILED, { detail: err.message.slice(0, 300) }, { log: '上传失败', cause: err })
throw new ApiError(ErrCode.CONV_NOT_FOUND, undefined, { status: 403 })  // 仅语义确需不同时覆盖
```

路由层一律 `throw`（`app.onError` 是唯一序列化点，形状永不漂移）；SSE 流内与 200 内嵌载荷用 `c.json`/`send` 直出。状态码语义变化点：`upload` 路由的会话不存在由 403 统一为 404（原为笔误级不一致）；`WECHAT_QR_FAILED` 与 `AI_*` 引入精确 502/504。

## 前端用法

```ts
import { errT } from '../i18n'           // ApiError → t('errors.<code>', params)
import { toApiError, handleAuthOn401 } from '../lib/api'  // 裸 fetch 收编
```

未知 code（比本地注册表新/旧、非 JSON 兜底 `UNKNOWN`）回退 `errors.__unknown`。`ChangePinDialog` 等按 `err.code` 语义分流的场景用 `isApiError(err) && err.code === '...'`。

## 新增错误码流程

1. `packages/shared/src/errors.ts`：枚举加码 + `ERR_REGISTRY` 登记（status + params 名单）；
2. 三语 locale（`apps/web/src/i18n/{zh-CN,en,ja}.json`）`errors` 段各加一键；
3. `pnpm test` —— `error-registry-i18n.test.ts` 自动把关（缺键/多余键/占位符不一致即红）。

## 验收标准

- 所有 REST 错误响应形状为 `{ code, params? }`，无 `message` 字段（`errors.contract.test.ts` 断言不变式）；
- `ErrCode` 全部码在三语 locale 有 `errors.<code>` 键，反向无注册表外键（`__unknown` 豁免）；
- en 模板 `{{param}}` 占位符集合 === `ERR_REGISTRY` params 名单；
- 未捕获异常响应不含堆栈与 `err.message`。

## 非目标（Non-Goals）

- ❌ 工具层 throw（`tools/` 约 25 处 `Tool error:` 前缀链路）——开发向 trace 展示，保持英文原文与 `startsWith('Tool error')` 匹配；
- ❌ 上游 AI 服务错误的结构化枚举——收敛为 `AI_*` 通用码 + `params.detail`；
- ❌ 错误码的数字分段管理（如 `0x10000000` 位段）——助记字符串直接作 i18n 键，无需注册表外的前缀解析。
