# Spec — Doubao（豆包网页）上游

## 概述

网关的第三种上游类型：管理员在「后台 → 网关 → 上游类型」选择 **Doubao**（豆包网页上游）后，
Momoi 不再使用自配置的 OpenAI 兼容端点，而是把对话请求转发到豆包网页端
（`https://www.doubao.com`），使用管理员本人的豆包账号会话。

凭证（Cookie + 设备指纹）由 **服务端** 加密持有；管理端只看到登录状态、账号与
时间戳，任何 Cookie 都不下发浏览器、不写入日志。

参考实现 `xrp-doubao` 是 xrl-router 的独立插件进程（协议逆向记录见其
`docs/DOUBAO_REVERSE.md`）；Momoi 是自托管单体应用，因此把「登录 / Cookie
凭证 / 私有 SSE 协议适配」三件事移植进 `apps/server/src/ai/doubao/`，不要求
用户额外跑进程。

**登录二维码是抖音官方授权码**：默认链路由服务端无头浏览器复刻豆包官方登录
弹窗 → 抖音授权页（`open.douyin.com`），把抖音授权页自己请求到的二维码原样
回传到管理端展示；用户用**抖音 App** 扫码授权。纯 HTTP 的豆包自助扫码链路
（豆包 App 扫码码）保留为 `DOUBAO_LOGIN_FLOW=doubao` 灾备选项。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `apps/server/src/ai/doubao/config.ts` | 网关端点、设备参数版本、模型预设、登录超时（可用环境变量覆盖） |
| `apps/server/src/ai/doubao/cookie-jar.ts` | 最小 Cookie 罐（Set-Cookie 解析 / domain+path 匹配 / 序列化） |
| `apps/server/src/ai/doubao/device.ts` | `device_id` / `web_id` / `fp` 伪设备指纹 |
| `apps/server/src/ai/doubao/security-params.ts` | 上游 query 参数与请求头 |
| `apps/server/src/ai/doubao/sse.ts` | 通用 SSE 解析器 |
| `apps/server/src/ai/doubao/messages.ts` | OpenAI messages → 豆包单条文本（无状态压平） |
| `apps/server/src/ai/doubao/douyin-login.ts` | **默认登录链路**：无头浏览器走豆包登录弹窗 → 抖音授权页，拦截抖音授权二维码并提取会话 Cookie |
| `apps/server/src/ai/doubao/web-login.ts` | 灾备登录链路（`DOUBAO_LOGIN_FLOW=doubao`）：纯 HTTP 豆包自助扫码 |
| `apps/server/src/ai/doubao/login-flow.ts` | 两条登录链路的公共契约（二维码 / 轮询状态 / 驱动接口） |
| `apps/server/src/ai/doubao/account.ts` | 用 Cookie 查 uid / nickname（两条链路共用） |
| `apps/server/src/ai/doubao/credentials.ts` | 会话落 `settings` 表，AES-256-GCM 加密（与 WorkBuddy 共用 `lib/encrypted-settings.ts`） |
| `apps/server/src/ai/doubao/session.ts` | 缓存 → 存储 → 灾备 Cookie 编排、登录会话状态机 |
| `apps/server/src/ai/doubao/risk.ts` | 风控标记（71002200x 系列） |
| `apps/server/src/ai/doubao/client.ts` | 上游请求、私有 SSE 事件解析、错误分类、`/samantha` 回退 |
| `apps/server/src/ai/doubao/chat.ts` | 豆包增量 → Momoi `StreamEvent`；错误映射为 `ApiError` |
| `apps/server/src/ai/provider.ts` | `gateway_source=doubao` 时整段委托 `chat.ts` |
| `apps/server/src/routes/doubao.ts` | 管理端点（状态 / 扫码登录 / 进度 / 退出 / 清风控） |
| `apps/web/src/components/admin/tabs/DoubaoCredentialPanel.tsx` | 二维码展示 + 登录轮询 + 凭证状态（与 WorkBuddy 面板共用同一套 UI/UX 状态机） |
| `apps/web/src/components/admin/tabs/GatewaySettings.tsx` | 上游类型选择（custom / workbuddy / doubao） |

## 登录流程

### 默认：抖音官方授权二维码（`DOUBAO_LOGIN_FLOW=douyin`）

```
POST /api/admin/doubao/login
  → 服务端启动无头浏览器（系统 Edge / Chrome）
  → 打开 www.doubao.com/chat/ → 点开登录弹窗
  → 点击「抖音一键登录」→ 同意协议
  → 浏览器进入 open.douyin.com 官方授权页
  → 拦截授权页请求 /oauth/get_qrcode/ 的响应，拿到抖音授权二维码
  → 返回 { status:'pending', flow:'douyin', qr_data_url }
  → 后台轮询：
      · 拦截 /oauth/check_qrcode/ 的 new / scanned / confirmed 状态
      · confirmed 后豆包官方页面自行用 code 换票并写入 sessionid 等 Cookie
      · 从浏览器上下文提取豆包 Cookie
  → GET /passport/account/info/v2/ 尽力取 uid / nickname
  → 凭证加密落库，关闭浏览器，进度变为 success
```

- **二维码是抖音官方授权码**（由 `open.douyin.com` 托管，解码为
  `aweme://authorizedy?...`），只能由抖音 App 扫描；抖音授权页同时支持短信验证码授权
- 不在 Node 端重放 code：参考实现实测会被豆包判为「非法应用」，换票必须由
  豆包官方页面在浏览器内完成
- 授权页可能自行刷新二维码；服务端会把新图随下一次进度轮询下发
- 依赖：`playwright-core` + 系统 Microsoft Edge / Google Chrome（或通过
  `DOUBAO_BROWSER_EXECUTABLE_PATH` 指定 Chromium）；默认无头运行
- 登录会话整体 5 分钟超时；成功后浏览器立即关闭

### 灾备：豆包自助扫码（`DOUBAO_LOGIN_FLOW=doubao`）

```
GET /                                  → ttwid 等基础 Cookie
GET /passport/safe/csrf_token/         → passport_csrf_token
GET /passport/web/get_qrcode/          → 豆包 App 扫码二维码
GET /passport/web/check_qrconnect/     → new → scanned → confirmed
GET {redirect_url}                     → sessionid / uid_tt 等会话 Cookie
```

- 无浏览器依赖，适合容器 / 无 Edge/Chrome 的部署
- **二维码是豆包 App 的扫码登录码，不是抖音授权码**；仅在默认链路不可用时使用
- 二维码有效期约 2 分钟，过期后前端提示「刷新二维码」

状态：`idle` / `pending` / `scanned` / `success` / `failed` / `expired`；
响应中的 `flow` 字段标明本次二维码来自哪条链路。

## 凭证存储

- 落库键：`doubao_credential`；加密密钥：`doubao_store_key`（首次使用生成）
- 信封格式：`aesgcm:v1:<iv>:<tag>:<ciphertext>`（base64url），明文不落库、不上 wire
- 载荷：`{ cookies, device, uid, nickname, savedAt }`
- 取会话顺序：内存缓存 → 加密存储 → `DOUBAO_COOKIES` 灾备 → 报「未登录」
- 豆包登录 **没有 refresh token**；会话 Cookie 失效只能重新扫码，服务端不做静默刷新
- Cookie 明文只出现在内存与加密载荷中；日志与接口只输出名称 / 条数 / 长度

## 对话转发

- Momoi 的 `streamChatCompletion` 在 `gateway_source=doubao` 时整段委托
  `streamDoubaoChat`，不经过 OpenAI chunk 解析
- 消息**无状态压平**：system + 历史轮次 + 工具结果编码为一条豆包用户消息；
  客户端每次带完整 history 即获得多轮效果
- 思考增量 → `thinking` 事件；正文 → `token` 事件；流尾 → `finish` 事件（含 usage）
- 关闭思考模式时不申请深度思考（`need_deep_think=0`、`reasoning_effort=3`），
  并丢弃上游思考增量
- 主端点 `/chat/completion` 返回 404 / 非 SSE / 风控时，`auto` 模式回退
  `/samantha/chat/completion`，语义不变
- 错误分类：
  - 登录失效（HTTP 401/403 或 71001200x）→ `AI_UPSTREAM_ERROR`，提示到网关页重新扫码
  - 风控（71002200x）→ `AI_UPSTREAM_ERROR` + `needs_captcha` 标记；管理员在浏览器
    完成人机验证后点「我已完成验证」清除
  - 其他上游错误 → `AI_UPSTREAM_ERROR`（detail 携带上游摘要）
  - 连接超时 → `AI_UPSTREAM_TIMEOUT`

## 模型映射

Agent 的 `model` 使用下列别名（未知值回落到 `doubao-fast`）：

| 客户端模型别名 | 网页端模式 | `model_item_key` | `agent_mode` | `mode_id` | 深度思考 |
|---|---|---|---|---|---|
| `doubao-fast` | 快速 | `0` | 2 | 1 | 否 |
| `doubao-expert` | 专家 | `3` | 2 | 1 | 是（默认强度 4） |
| `doubao-work` | 工作任务 Auto | `9` | 1 | 3 | 否 |
| `doubao-work-pro` | 工作任务 Pro | `5` | 1 | 3 | 否 |
| `doubao-2.1-lite` | 豆包 2.1 Lite | `seed-lite-7b` | 1 | 3 | 否 |
| `doubao` / `doubao-pro` / `doubao-think` | 别名 | — | — | — | — |

## 能力边界

1. **仅文本**：图片 / 音频 / 文件输入返回可读错误
2. **不实现 tools / function calling**：豆包网页端没有稳定的原生 tool_call 协议，
   适配层不伪造该语义——工具定义被忽略，Agent 只拿文本回复
3. **不生成 `a_bogus`**：纯 HTTP + 登录 Cookie 在实测中可用；主端点被风控时回退
   `/samantha`
4. **不绕过人机验证**：只上报风控状态，等待管理员在浏览器完成验证或重新登录
5. **不读取豆包电脑版**：不依赖、不读取任何本地客户端文件

## 接口契约

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/doubao/status` | `{ logged_in, source?, uid?, nickname?, saved_at?, cookie_count?, needs_captcha? }` |
| POST | `/api/admin/doubao/login` | 发起登录 → `{ status, flow, message, qr_data_url, expire_at? }`（默认 flow=douyin，二维码为抖音授权码） |
| GET | `/api/admin/doubao/login/status` | 登录进度（同上；`success` 时带 `credential`） |
| POST | `/api/admin/doubao/logout` | 清除本地凭证 → `{ success: true }` |
| POST | `/api/admin/doubao/reset-captcha` | 清除风控标记 → `{ success: true }` |

全部端点位于 `adminAuthMiddleware` 之后（`/api/admin/doubao*`）。

## 可选环境变量

协议适配用的覆盖项（通常无需设置；豆包升级后才可能需要调整）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `DOUBAO_BASE_URL` | `https://www.doubao.com` | 对话 / 账号网关 |
| `DOUBAO_AUTH_BASE_URL` | 同 `DOUBAO_BASE_URL` | 登录网关 |
| `DOUBAO_AID` | `497858` | 网页端 aid |
| `DOUBAO_PC_VERSION` | `3.42.5` | 网页端版本参数 |
| `DOUBAO_BOT_ID` | `7338286299411103781` | 默认 bot id |
| `DOUBAO_CHAT_MODE` | `auto` | `auto`（主端点失败回退）/ `chat` / `samantha` |
| `DOUBAO_LOGIN_FLOW` | `douyin` | `douyin`（默认，抖音授权二维码）/ `doubao`（豆包自助扫码，无浏览器依赖） |
| `DOUBAO_LOGIN_HEADLESS` | `1` | 登录浏览器是否无头；二维码仍会回传管理端 |
| `DOUBAO_BROWSER_CHANNEL` | 空 | `msedge` / `chrome` / `chromium`；留空按平台自动尝试 |
| `DOUBAO_BROWSER_EXECUTABLE_PATH` | 空 | 指定浏览器可执行文件（容器 / 自定义 Chromium） |
| `DOUBAO_BROWSER_ARGS` | 空 | 追加浏览器启动参数（空格分隔；容器内常需 `--no-sandbox`） |
| `DOUBAO_QR_WAIT_MS` | `45000` | 等待抖音授权页产出二维码的上限 |
| `DOUBAO_LOGIN_POLL_MS` | `1500` | 登录状态轮询间隔 |
| `DOUBAO_LOGIN_TIMEOUT_MS` | `300000` | 登录会话超时 |
| `DOUBAO_COOKIES` | 空 | 灾备 Cookie 头（`sessionid=…; ttwid=…`），无本地凭证时使用；等同账号密码，仅建议临时使用 |
| `DOUBAO_UID` | 空 | 灾备账号 uid（仅展示） |
| `DOUBAO_DEVICE_ID` / `DOUBAO_WEB_ID` / `DOUBAO_FP` | 空 | 覆盖设备指纹；留空则登录时生成并随凭证保存 |
| `DOUBAO_DEBUG` | `0` | 打印协议调试日志（不含凭证值） |

## 行为约束

1. **Cookie 永不下发**：状态接口只包含账号、时间戳、条数与风控标记
2. **凭证全局唯一**：与 `api_key` 同级，一次扫码全站生效
3. **二维码等同临时凭据**：只在 `pending` / `scanned` 期间下发，成功后立即停止下发
4. **失败可恢复**：豆包登录失效 / 风控只影响豆包上游；切回 `custom` 或 `workbuddy` 不受影响
5. **模型名由管理员指定**：Agent 的 `model` 填上表别名；未知值回落到 `doubao-fast`

## 验收标准

- 「上游类型」下拉出现 **Doubao**（选项文案固定为 `Doubao`）；选中后 API 端点/密钥输入框消失，
  出现二维码凭证面板；右上角「从环境变量加载」一并隐藏
- 点击「扫码登录」→ 面板展示**抖音官方授权二维码**（可用抖音 App 扫描，页面上也支持短信验证码）→ 手机确认后状态变为「已登录」，显示账号、登录时间、Cookie 条数
- 二维码来自 `open.douyin.com` 授权页，而不是豆包自助扫码接口；`flow=douyin` 且面板提示文案指向抖音 App
- 服务端重启后无需重新登录；凭证失效时对话返回「请在网关页重新扫码登录」的可读错误
- 退出登录后状态回到「未登录」，凭证行从 `settings` 表删除
- 触发上游风控时面板出现提示与「我已完成验证」按钮
