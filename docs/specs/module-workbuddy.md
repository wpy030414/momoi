# Spec — WorkBuddy 上游

## 概述

网关的第二种上游类型：管理员在「后台 → 网关 → 上游类型」选择 **WorkBuddy** 后，
Momoi 不再使用自配置的 OpenAI 兼容端点，而是把对话请求转发到 WorkBuddy 官方网关
（`https://copilot.tencent.com`），使用管理员本人的 WorkBuddy 账号凭证。

凭证由 **服务端** 持有并**后台自动轮换**，前端只看到登录状态、账号与有效期，
任何 token 都不下发浏览器、不写入日志。

登录页默认展示「微信扫码登录」：服务端用**纯 HTTP 链路**从 Keycloak 登录网关
直接取得微信二维码图片、回传到管理端面板，管理员用微信扫码即可。
扫码确认后服务端完成 OIDC 回跳并直接换取 accessToken —— **全过程不需要任何浏览器**。
二维码获取失败时面板提供「复制登录页链接」的最终回退。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `apps/server/src/ai/workbuddy/config.ts` | 网关端点、客户端身份头版本、轮换与登录超时常量（可用环境变量覆盖） |
| `apps/server/src/ai/workbuddy/web-login.ts` | state 握手 → 轮询换票 → 取账号（自包含网页登录，不依赖 WorkBuddy App） |
| `apps/server/src/ai/workbuddy/wechat-qr.ts` | 纯 HTTP 完成扫码登录：建会话 → wechat-url → 二维码 → 回跳换 session → enterprise 换 token |
| `apps/server/src/ai/workbuddy/credentials.ts` | 凭证落 `settings` 表，AES-256-GCM 加密（`aesgcm:v1:` 信封） |
| `apps/server/src/ai/workbuddy/token-manager.ts` | 缓存 → 存储 → 续期编排、登录会话状态机、后台轮换 keeper |
| `apps/server/src/ai/workbuddy/chat.ts` | 对话转发（认证头 / 401 重试 / 链路头） |
| `apps/server/src/ai/workbuddy/headers.ts` | 网关客户端身份头（对话与模型目录共用） |
| `apps/server/src/ai/workbuddy/models.ts` | 云端模型目录拉取（Agent 表单的模型下拉） |
| `apps/server/src/routes/workbuddy.ts` | 管理端点（状态 / 登录 / 登录进度 / 退出） |
| `apps/server/src/ai/provider.ts` | `gateway_source=workbuddy` 时把请求交给 `chat.ts`，解析逻辑不变 |
| `apps/web/src/components/admin/tabs/WorkBuddyCredentialPanel.tsx` | 微信二维码展示 + 登录轮询 + 凭证状态 |
| `apps/web/src/components/admin/tabs/GatewaySettings.tsx` | 上游类型选择（custom / workbuddy） |
| `apps/web/src/components/admin/AdminPanelMain.tsx` | 右上角动作随上游类型切换（仅自配置时显示「从环境变量加载」，WorkBuddy 时不显示） |

## 登录流程

```
POST /api/admin/workbuddy/login
  → 服务端 POST {authBase}/v2/plugin/auth/state?platform=workbuddy（握手，取 state/authUrl）
  → 返回 { auth_url, state }
  → 服务端异步（纯 HTTP，无浏览器）：
      A) GET  /auth/realms/copilot/protocol/openid-connect/auth
              ?client_id=console&state=<32位hex>&redirect_uri=/console/accounts/.apisix/redirect
              （建立 Keycloak 会话；apisix 专用 redirect_uri）
      B) GET  /auth/realms/copilot/console/auth/wechat-url?client_id=login&…
              → { url: open.weixin.qq.com/connect/qrconnect… }
      C) 从 qrconnect 页面提取 uuid → 下载 /connect/qrcode/<uuid> 二维码
         管理端轮询 /login/status 拿到 qr_data_url 并展示
  → 管理员用微信扫码确认（服务端不经手口令）
  → 服务端轮询 open.weixin.qq.com/connect/l/qrconnect?uuid=…（408/404/405）
  → 确认后带 code 回跳 broker，跟随 Keycloak 重定向链，
      落到 /console/accounts/.apisix/redirect?…&code=… → **下发 session / session_2**
  → 立即 POST /console/login/enterprise?state=<A 步的 state>
      → { code:0, data:{ accessToken, refreshToken } }
  → GET  /v2/plugin/account（Bearer）取 uid / nickname
  → 凭证加密落库，前端轮询 /login/status 拿到 success
```

关键约束（均为线上实测所得）：

- **必须用 `.apisix/redirect` 作为 OIDC redirect_uri**：微信登录绑定到这条流程后，
  回跳才会落到能下发 `session_2` 的端点。
- **拿到 `session_2` 后必须立即换票**：若继续跟随到 `/console/accounts`，
  平台会以 `set-cookie: session=; session_2=;` 清空会话。
- `wechat-url` 依赖 A 步下发的 `AUTH_SESSION_ID` / `KC_RESTART`，缺了返回 502。
- `x-device-token`（TDID）**非必需**，无需在服务端复现。
- 全程不依赖 `playwright-core` 或系统浏览器（该依赖已移除）。

面板状态：

- 二维码阶段通过 `qr_state` 下发：`loading`（「正在获取二维码」）→ `ready`（展示二维码）
  或 `unavailable`（才下发 `auth_url`，面板提供「复制登录页链接」回退）
- 微信扫码长轮询的 `wx_errcode=404` 映射为 `scanned`，面板显示「已扫码，请在手机上确认」
- 登录会话 5 分钟超时

## 凭证存储与轮换

- 落库键：`workbuddy_credential`；加密密钥：`workbuddy_store_key`（首次使用生成）
- 信封格式：`aesgcm:v1:<iv>:<tag>:<ciphertext>`（base64url），明文不落库、不上 wire
- 取票顺序：内存缓存 → 加密存储 → refresh 续期；续期失败/无凭证时返回可读提示
- **后台自动轮换**：`startWorkBuddyKeeper()` 随服务启动，每 60s 巡检一次；access token
  进入到期前 5 分钟窗口即用 refresh token 续期。**refresh token 每次续期都会轮换**，
  续期结果立即加密写回，避免重启后拿已失效的旧票
- 巡检不以「当前是否选中 WorkBuddy」为前提：只要本地有凭证就续期，防止
  「已登录但尚未保存配置」期间凭证悄悄过期

## 可选环境变量

协议适配用的覆盖项（通常无需设置；WorkBuddy 客户端升级时才可能需要调整）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `WORKBUDDY_BASE_URL` | `https://copilot.tencent.com` | 推理网关（对话 / 续期） |
| `WORKBUDDY_AUTH_BASE_URL` | `https://www.workbuddy.cn` | 登录网关（握手 / 换票 / 账号） |
| `WORKBUDDY_DOMAIN` | `www.workbuddy.cn` | 请求头 `X-Domain` |
| `WORKBUDDY_IDE_VERSION` | `5.8.3` | 伪装客户端版本（`User-Agent` / `X-IDE-Version`） |
| `WORKBUDDY_REFRESH_AHEAD_MS` | `300000` | access token 提前续期窗口 |
| `WORKBUDDY_KEEPALIVE_MS` | `60000` | 后台巡检间隔 |
| `WORKBUDDY_LOGIN_TIMEOUT_MS` | `300000` | 网页登录超时 |
| `WORKBUDDY_QR_WAIT_MS` | `30000` | 单次二维码相关请求的超时（建会话 / 取地址 / 下载图片） |
| `WORKBUDDY_AUTH_URL_BASE` | `https://www.workbuddy.cn/auth` | Keycloak 鉴权根地址 |
| `WORKBUDDY_REALM` | `copilot` | Keycloak realm |
| `WORKBUDDY_CONSOLE_CLIENT_ID` | `console` | 建立会话所用的 OIDC 客户端 |
| `WORKBUDDY_WECHAT_CLIENT_ID` | `login` | 申请微信授权地址所用的客户端 |
| `WORKBUDDY_WECHAT_IDP_HINT` | `weixinwebchat` | 强制走微信扫码身份提供商 |
| `WORKBUDDY_MODELS_PATH` | `/v2/enterprises/personal/models` | 云端模型目录路径（Agent 表单的模型下拉） |

## 模型目录

- 来源：`GET {WORKBUDDY_BASE_URL}{WORKBUDDY_MODELS_PATH}`，响应 `{ data: { models: [{ id, name, vendor, tags }] } }`
- 身份头与对话转发共用 `headers.ts`；目录请求用 `Accept: application/json`，不带对话链路头
- 401/403 与转发同语义：强制续期后重试一次
- 过滤 `tags` 含 `text-to-image` 的模型，去重后返回（契约见 `module-agent.md` 的「模型目录与选择」）
- 目录拉取失败不影响 Agent 编辑：接口降级为 `models: []` + `warning`，前端回退手动填写
- 目录不做缓存：每次打开 Agent 表单重新拉取，避免展示套餐已移除的模型

## 转发行为

- 始终以上游流式请求（网关非流式返回 `400 / code 11101`）；Momoi 的
  `streamChatCompletion` 本就是流式，SSE 解析与工具调用聚合完全复用
- 不发送 `enable_thinking` / `thinking_budget`（非 WorkBuddy 规范字段）
- 上游 401/403：强制续期后重试一次；仍失败则把上游响应交给既有错误链路
- 无凭证：抛 `AI_UPSTREAM_ERROR`，提示管理员到网关页登录

## 接口契约

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/workbuddy/status` | `{ logged_in, expired?, uid?, nickname?, expires_at?, refresh_expires_at?, has_refresh_token?, auto_refresh }` |
| POST | `/api/admin/workbuddy/login` | 发起登录 → `{ auth_url, state }` |
| GET | `/api/admin/workbuddy/login/status` | `{ status: 'idle' \| 'pending' \| 'scanned' \| 'success' \| 'failed', message?, qr_data_url?, qr_state?: 'loading' \| 'ready' \| 'unavailable', auth_url?, credential? }`（`auth_url` 仅在 `qr_state=unavailable` 时下发） |
| POST | `/api/admin/workbuddy/logout` | 清除本地凭证 → `{ success: true }` |

全部端点位于 `adminAuthMiddleware` 之后（`/api/admin/workbuddy*`）。

## 行为约束

1. **token 永不下发**：状态与日志只包含 uid / 昵称 / 时间戳与 token 存在性
2. **凭证全局唯一**：与 `api_key` 同级，一次登录全站生效
3. **不读取本机 WorkBuddy App 登录态**：仅走网页登录，避免绑定特定机器与 App 版本
4. **失败可恢复**：续期失败只影响 WorkBuddy 上游，切回 `custom` 不受影响
5. **模型名由管理员指定**：Agent 表单的模型下拉来自云端目录；目录外模型选「自定义」
   手动填写，`model` 仍是 WorkBuddy 模型 ID（如 `glm-5.3`）

## 验收标准

- 选择 WorkBuddy 后，API 端点/密钥输入框消失，出现凭证面板；右上角「从环境变量加载」按钮一并隐藏（登录入口在凭证面板内）
- 编辑 Agent 时模型下拉展示该账号的云端目录；未登录时提示先登录，仍可「自定义」手动填写
- 点击登录 → 按钮显示「正在获取二维码…」→ 面板直接显示**微信扫码二维码**（不自动弹窗）→ 微信扫码确认后凭证面板显示「已登录 + 账号 + 有效期」
- 二维码出现前按钮保持「正在获取二维码…」且禁用；二维码出现后才变为「刷新二维码」，
  正常流程（`qr_state=loading/ready`）不显示任何「打开登录页」链接
- 二维码获取失败时，`qr_state=unavailable`，面板显示写入错误提示，提供**复制登录页链接按钮**与「在浏览器中打开登录页」链接作为最终回退
- 服务端重启后无需重新登录；access token 临近过期时表内凭证自动更新（refresh token 轮换）
- 退出登录后状态回到「未登录」，对话请求给出「请先登录」的可读错误
