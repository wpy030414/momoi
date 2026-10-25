# Spec — Doubao（豆包网页）上游

## 概述

网关的第三种上游类型：管理员在「后台 → 网关 → 上游类型」选择 **Doubao**（豆包网页上游）后，
Momoi 不再使用自配置的 OpenAI 兼容端点，而是把对话请求转发到豆包网页端
（`https://www.doubao.com`），使用管理员本人的豆包账号会话。

凭证（Cookie + 设备指纹）由 **服务端** 加密持有；管理端只看到登录状态、账号与
时间戳，任何 Cookie 都不下发浏览器、不写入日志。豆包没有 refresh token，
服务端通过**后台凭证巡检**探测有效性并吸收上游轮换的 Cookie（不能无声续期，
失效仍需重新扫码）。

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
| `apps/server/src/ai/doubao/messages.ts` | OpenAI messages → 豆包单条文本 + 当前用户消息附件（无状态压平） |
| `apps/server/src/ai/doubao/douyin-login.ts` | **默认登录链路**：无头浏览器走豆包登录弹窗 → 抖音授权页，拦截抖音授权二维码并提取会话 Cookie |
| `apps/server/src/ai/doubao/web-login.ts` | 灾备登录链路（`DOUBAO_LOGIN_FLOW=doubao`）：纯 HTTP 豆包自助扫码 |
| `apps/server/src/ai/doubao/login-flow.ts` | 两条登录链路的公共契约（二维码 / 轮询状态 / 驱动接口） |
| `apps/server/src/ai/doubao/account.ts` | 用 Cookie 查 uid / nickname（两条链路共用）；巡检探针（判定 ok / auth / error） |
| `apps/server/src/ai/doubao/error-codes.ts` | 鉴权 / 风控业务码集合（对话、上传、巡检共用） |
| `apps/server/src/ai/doubao/credentials.ts` | 会话落 `settings` 表，AES-256-GCM 加密（与 WorkBuddy 共用 `lib/encrypted-settings.ts`） |
| `apps/server/src/ai/doubao/session.ts` | 缓存 → 存储 → 灾备 Cookie 编排、登录会话状态机、后台巡检 keeper、Cookie 轮换回写 |
| `apps/server/src/ai/doubao/risk.ts` | 风控标记（71002200x 系列） |
| `apps/server/src/ai/doubao/upload.ts` | 图片 / 文件上传（ImageX：prepare → Apply → TOS → Commit → pre_handle） |
| `apps/server/src/ai/doubao/conversation-cleanup.ts` | 每轮结束后删除豆包侧会话（cmd 4171）与统计 |
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

## 后台凭证巡检（keeper）

豆包上游没有 refresh token / 续期端点，因此巡检**不是轮换**，只做两件事：

1. **探测有效性**：每 `DOUBAO_KEEPALIVE_MS`（默认 15 分钟）用账号端点
   `/passport/account/info/v2/` 探一次会话，判定为 `ok` / `auth` / `error`
2. **吸收 Cookie 轮换**：把探测响应里的 `Set-Cookie` 合并进度假罐；内容变化才
   加密写回存储（`DOUBAO_COOKIES` 灾备来源不落库）。对话响应里的 `Set-Cookie`
   同样由 `DoubaoClient` 吸收并写回

- `auth`（HTTP 401/403 或 710012xxx）→ `DoubaoStatus.invalid=true`，面板显示
  「豆包凭证已失效，请重新扫码登录」；已失效时巡检跳过，避免反复触发上游鉴权失败
- `error`（网络 / 其它业务码）只更新巡检状态，不判失效
- 重新扫码成功、或任意一轮对话成功都会清除 `invalid` 并刷新巡检结果
- 巡检不以「当前是否选中豆包」为前提；无凭证时每个周期只做一次空查询
- 期间若完成新一轮登录，旧会话的轮换结果会被丢弃（不覆盖新凭证）

对外状态（`GET /api/admin/doubao/status`）：

```jsonc
{
  "invalid": false,                 // 仅在判定失效时出现
  "keepalive": {
    "enabled": true,
    "last_checked_at": "2026-10-25T08:00:00.000Z",
    "last_result": "ok",            // ok | auth | error
    "last_message": "..."           // error 时的 HTTP / 业务码摘要，不含 Cookie
  }
}
```

## 对话转发

- Momoi 的 `streamChatCompletion` 在 `gateway_source=doubao` 时整段委托
  `streamDoubaoChat`，不经过 OpenAI chunk 解析
- 消息**无状态压平**：system + 历史轮次 + 工具结果编码为一条豆包用户消息；
  客户端每次带完整 history 即获得多轮效果
- **附件只随当前用户消息进入上游**：图片 / 文件先上传 ImageX，再以
  `block_type:10052` 附件消息发送（与文本消息分属两个 `messages[]` 项）；
  历史消息中的附件以 `[图片]` / `[文件：名称]` 占位，避免每轮重复上传
- 思考增量 → `thinking` 事件；正文 → `token` 事件；流尾 → `finish` 事件（含 usage）
- 关闭思考模式时：专家模型不申请深度思考（`need_deep_think` / `ext.use_deep_think`
  收起为 `0`，`reasoning_effort=3`），并丢弃上游思考增量；工作任务类模型的
  `menu_type` 是模式标识，不随思考开关改变
- 主端点仅在 **404 / 405 / 410 / 501-504 / 非 SSE / 网络错误** 时回退
  `/samantha`；风控、鉴权、参数错误与**带附件的请求**一律不回退
  （旧端点没有附件语义，静默丢弃附件属语义错误）
- 错误分类：
  - 登录失效（HTTP 401/403 或 71001200x）→ `AI_UPSTREAM_ERROR`，提示到网关页重新扫码
  - 风控（71002200x）→ `AI_UPSTREAM_ERROR` + `needs_captcha` 标记；管理员在浏览器
    完成人机验证后点「我已完成验证」清除
  - 其他上游错误 → `AI_UPSTREAM_ERROR`（detail 携带上游摘要）
  - 连接超时 → `AI_UPSTREAM_TIMEOUT`
  - 附件超限 / 音频 / 非法地址 → `AI_UPSTREAM_ERROR`（detail 为可读原因）

### 多模态附件（ImageX）

图片与文件走同一条 ImageX 链路（2026-10-25 实测）：

```
POST /alice/resource/prepare_upload   （图片 resource_type=2 / 文件 =1，拿 STS）
GET  /top/v1?Action=ApplyImageUpload  （SigV4，拿 StoreUri / Auth）
POST https://<upload_host>/upload/v1/<StoreUri>（Content-CRC32、X-Storage-U）
POST /top/v1?Action=CommitImageUpload （SigV4，SessionKey 为 base64 JSON）
POST /alice/message/pre_handle_v2_without_conv（触发服务端解析）
```

- 附件消息 `content_block[0].block_type = 10052`：图片 `type:1` + `image`，
  文件 `type:3` + `file`；同一批附件共用一个 `local_message_id`
- 默认限制：单附件 20 MB、一次 10 个（环境变量可调）
- data URL 直接解码上传；http(s) URL 会先下载（默认拒绝内网 / localhost 地址，
  防 SSRF；`DOUBAO_ALLOW_PRIVATE_URLS=1` 可放行）
- 音频输入仍不支持（返回可读错误）
- Momoi 的文本 / PDF / Excel 附件仍由 `files/parser.ts` 内联进文本，
  只有图片会以 `image_url` data URL 到达本层并走上传

### 思考链与流式解析

- `block_type=10040` 是 `BLOCK_THINKING`：优先读
  `content.thinking_block.think`；`cot_ui_style=summary` 时上游只下发
  `finish_title` / `streaming_title` 等步骤标题，映射为 thinking 增量
  （`DOUBAO_THINKING_SUMMARY=1` 默认开启），相同标题去重
- 无 `thinking_block` 的旧版 10040 仍按「思考分隔符」状态机兼容
- `CHUNK_DELTA` 的 `{"text":"…"}` 为正文增量、`{"think":"…"}` 为思考增量
- `SSE_REPLY_END` 视为正文结束（提前收尾）；`FULL_MSG_NOTIFY` 是用户消息回显，
  必须忽略，不能当作助手正文
- `SSE_ACK.ack_client_meta.conversation_id` 用于本轮流结束后的会话清理

### 会话自动清理

上游要求每轮创建会话（`need_create_conversation:true`），不删除会同步到豆包
账号的最近会话列表。流结束（含提前收尾 / 客户端取消）后，服务端异步调用：

```
POST /im/conversation/batch_del_user_conv?<web params>
Content-Type: application/json; encoding=utf-8
{ cmd:4171, uplink_body:{ batch_delete_user_conversation_uplink_body:{
  conversation_id:["<id>"], delete_all:false, conversation_type:3 } }, ... }
```

- 不阻塞客户端；失败重试一次（仅「下游服务器失败」712010703 与网络错误）
- 失败只记录统计与警告；`GET /api/admin/doubao/status` 的
  `conversation_cleanup` 字段可查看 attempted / deleted / failed
- `DOUBAO_AUTO_DELETE_CONVERSATION=0` 可关闭

## 模型映射

Agent 的 `model` 使用下列别名（未知值回落到 `doubao-fast`）：

| 客户端模型别名 | 网页端模式 | `model_item_key` | `menu_type` | `agent_mode` | `mode_id` | 深度思考 |
|---|---|---|---|---|---|---|
| `doubao-fast` | 快速 | `0` | 0 | 2 | 1 | 否 |
| `doubao-expert` | 专家 | `3` | 3 | 2 | 1 | 是（默认强度 4） |
| `doubao-work` | 工作任务 Auto | `9` | 9 | 1 | 3 | 否 |
| `doubao-work-pro` | 工作任务 Pro | `5` | 5 | 1 | 3 | 否 |
| `doubao-2.1-lite` | 豆包 2.1 Lite | `seed-lite-7b` | 10001 | 1 | 3 | 否 |
| `doubao` / `doubao-pro` / `doubao-think` | 别名 | — | — | — | — | — |

`need_deep_think` 与 `ext.use_deep_think` 取菜单 `menu_type`（不是 0/1 布尔）；
专家 / 工作任务类模型同时携带 `model_config.model_extra_params.total_window_size`。

Agent 表单的模型下拉由 `listDoubaoModels()` 提供，只列上表的 5 个正式预设（不含短别名）——
豆包网页端没有可编程的目录接口，这里不做网络请求（见 `module-agent.md` 的「模型目录与选择」）。
需要别名时在表单里选「自定义」手动填写。

## 能力边界

1. **图片 / 文件可用，音频不可用**：图片与文件走 ImageX 上传；音频输入返回可读错误。
   历史消息中的附件以占位符保留，不重复上传。
2. **不实现 tools / function calling**：豆包网页端没有稳定的原生 tool_call 协议，
   适配层不伪造该语义——工具定义被忽略，Agent 只拿文本回复
3. **不生成 `a_bogus`**：纯 HTTP + 登录 Cookie 在实测中可用；只在端点 / 协议 /
   网络错误时回退 `/samantha`，风控 / 鉴权 / 参数错误与带附件请求不回退
4. **不绕过人机验证**：只上报风控状态，等待管理员在浏览器完成验证或重新登录
5. **不读取豆包电脑版**：不依赖、不读取任何本地客户端文件
6. **每轮清理会话**：流结束后异步删除本轮会话；失败只记录统计，不影响回复
7. **首包超时含上传**：外层连接超时（120s）覆盖「附件上传 + 建立上游 SSE」；
   超大附件在慢速链路上可能先超时，需调大 `DOUBAO_UPLOAD_TIMEOUT_MS` 或网关超时

## 接口契约

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/doubao/status` | `{ logged_in, invalid?, source?, uid?, nickname?, saved_at?, cookie_count?, needs_captcha?, keepalive: { enabled, last_checked_at?, last_result?, last_message? } }` |
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
| `DOUBAO_CHAT_MODE` | `auto` | `auto`（仅端点 / 网络错误回退）/ `chat` / `samantha` |
| `DOUBAO_LOGIN_FLOW` | `douyin` | `douyin`（默认，抖音授权二维码）/ `doubao`（豆包自助扫码，无浏览器依赖） |
| `DOUBAO_LOGIN_HEADLESS` | `1` | 登录浏览器是否无头；二维码仍会回传管理端 |
| `DOUBAO_BROWSER_CHANNEL` | 空 | `msedge` / `chrome` / `chromium`；留空按平台自动尝试 |
| `DOUBAO_BROWSER_EXECUTABLE_PATH` | 空 | 指定浏览器可执行文件（容器 / 自定义 Chromium） |
| `DOUBAO_BROWSER_ARGS` | 空 | 追加浏览器启动参数（空格分隔；容器内常需 `--no-sandbox`） |
| `DOUBAO_QR_WAIT_MS` | `45000` | 等待抖音授权页产出二维码的上限 |
| `DOUBAO_LOGIN_POLL_MS` | `1500` | 登录状态轮询间隔 |
| `DOUBAO_LOGIN_TIMEOUT_MS` | `300000` | 登录会话超时 |
| `DOUBAO_KEEPALIVE_MS` | `900000` | 后台凭证巡检间隔（15 分钟） |
| `DOUBAO_KEEPALIVE_TIMEOUT_MS` | `15000` | 单次巡检请求超时 |
| `DOUBAO_COOKIES` | 空 | 灾备 Cookie 头（`sessionid=…; ttwid=…`），无本地凭证时使用；等同账号密码，仅建议临时使用 |
| `DOUBAO_UID` | 空 | 灾备账号 uid（仅展示） |
| `DOUBAO_DEVICE_ID` / `DOUBAO_WEB_ID` / `DOUBAO_FP` | 空 | 覆盖设备指纹；留空则登录时生成并随凭证保存 |
| `DOUBAO_UPLOAD` | `1` | 附件上传总开关（`0` = 图片/文件输入返回可读错误） |
| `DOUBAO_MAX_ATTACHMENT_MB` | `20` | 单附件大小上限（MB） |
| `DOUBAO_MAX_ATTACHMENTS` | `10` | 单次请求附件数量上限 |
| `DOUBAO_ALLOW_PRIVATE_URLS` | `0` | 允许下载内网 / localhost 附件 URL（默认拒绝，防 SSRF） |
| `DOUBAO_UPLOAD_TIMEOUT_MS` | `120000` | 单个上传请求超时 |
| `DOUBAO_PREPARE_UPLOAD_PATH` | `/alice/resource/prepare_upload` | ImageX 初始化路径 |
| `DOUBAO_PRE_HANDLE_PATH` | `/alice/message/pre_handle_v2_without_conv` | 附件预解析路径 |
| `DOUBAO_TOP_PATH` | `/top/v1` | ImageX TOP 网关路径 |
| `DOUBAO_UPLOAD_TENANT_ID` / `DOUBAO_UPLOAD_SCENE_ID` | `5` | ImageX 租户 / 场景 |
| `DOUBAO_AUTO_DELETE_CONVERSATION` | `1` | 每轮结束后删除豆包侧会话 |
| `DOUBAO_CLEANUP_TIMEOUT_MS` | `10000` | 会话清理请求超时 |
| `DOUBAO_THINKING_SUMMARY` | `1` | 把 `cot_ui_style=summary` 的步骤标题映射为思考增量 |
| `DOUBAO_DEBUG` | `0` | 打印协议调试日志（不含凭证值） |

## 行为约束

1. **Cookie 永不下发**：状态接口只包含账号、时间戳、条数、风控标记与巡检状态
2. **凭证全局唯一**：与 `api_key` 同级，一次扫码全站生效
3. **二维码等同临时凭据**：只在 `pending` / `scanned` 期间下发，成功后立即停止下发
4. **巡检不等于轮换**：上游没有 refresh token，巡检只探测有效性并吸收 Cookie 轮换；
   判定失效后必须重新扫码，服务端不会尝试静默续期或复用他人凭证
5. **失败可恢复**：豆包登录失效 / 风控只影响豆包上游；切回 `custom` 或 `workbuddy` 不受影响
6. **模型名由管理员指定**：Agent 表单的模型下拉列出上表 5 个预设；别名或目录外模型
   选「自定义」手动填写，未知值回落到 `doubao-fast`

## 验收标准

- 「上游类型」下拉出现 **Doubao**（选项文案固定为 `Doubao`）；选中后 API 端点/密钥输入框消失，
  出现二维码凭证面板；右上角「从环境变量加载」一并隐藏
- 点击「扫码登录」→ 面板展示**抖音官方授权二维码**（可用抖音 App 扫描，页面上也支持短信验证码）→ 手机确认后状态变为「已登录」，显示账号、登录时间、Cookie 条数
- 二维码来自 `open.douyin.com` 授权页，而不是豆包自助扫码接口；`flow=douyin` 且面板提示文案指向抖音 App
- 服务端重启后无需重新登录；凭证失效时对话返回「请在网关页重新扫码登录」的可读错误
- 已登录状态下，凭证详情显示「后台巡检：已启用 · 最近检查时间 · 凭证有效」；
  巡检判定失效时面板出现「豆包凭证已失效」提示，顶部状态显示「凭证已过期」
- 巡检 / 对话响应里的 `Set-Cookie` 轮换会写回加密存储；服务端重启后仍使用最新 Cookie
- 退出登录后状态回到「未登录」，凭证行从 `settings` 表删除
- 触发上游风控时面板出现提示与「我已完成验证」按钮
- 编辑 Agent 时模型下拉直接列出 5 个豆包预设（无网络请求），选「自定义」可填短别名
- 豆包上游开启思考且选择专家模型时，请求体 `need_deep_think:3`、`ext.use_deep_think:"3"`；
  关闭思考后两者为 `0`
- 发送图片：按 `prepare → Apply → TOS → Commit → pre_handle` 上传，聊天请求中
  附件消息为 `block_type:10052`、文本消息为 `block_type:10000`；回复正常流式返回
- 带附件的请求遇到主端点 404 时**不**回退 `/samantha`，错误直接返回
- 上游返回 `thinking_block` 步骤标题时，前端思考块出现对应标题；`FULL_MSG_NOTIFY`
  的用户消息回显不会混入助手正文
- 每轮生成结束后，豆包账号的最近会话列表不残留该轮会话；管理端
  `GET /api/admin/doubao/status` 的 `conversation_cleanup` 统计递增
