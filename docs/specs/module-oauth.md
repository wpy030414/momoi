# Spec — OAuth2 第三方登录（OAuth）

## 概述

OAuth2 模块提供第三方身份提供商（Identity Provider, IdP）登录能力，使用标准 Authorization Code 流程。整体分为三种场景：

1. **已有绑定直接登录**：OAuth 身份已在 `user_oauth_bindings` 表中绑定到某个本地用户 → 直接签发 JWT 并跳转回 SPA，无需输入 PIN。
2. **已登录绑定新账号**：用户已在浏览器中持有有效 JWT（`momoi_token` Cookie），但该 OAuth 身份尚未绑定任何本地账户 → 自动将 OAuth 身份绑定到当前登录账户，无需额外交互。
3. **全新 OAuth 用户注册**：该 OAuth 身份无绑定，且当前浏览器无有效 JWT → 若 `oauth_registration_open` 开关打开，跳转至 SPA 注册页面（`oauth_register=1`），由前端引导用户选择「绑定已有账户」（link）或「创建新账户」（create）。

整个流程的核心职责边界：服务端只负责 OAuth2 协议交互（跳转、code 换 token、取用户信息）和数据库绑定管理；前端负责注册 UI（用户名输入 + PIN 设置 / 已有账户 PIN 验证）。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/server/routes/oauth.ts` | OAuth2 完整服务端实现：登录发起、回调处理、注册完成 |
| `src/server/schema.ts` | `user_oauth_bindings` 表定义 |
| `src/server/config.ts` | `oauth_providers` 配置管理（DB 持久化、运行时读取）+ `oauth_registration_open` 开关 |
| `src/server/auth.ts` | JWT 签发（`signUserToken`）、Cookie 管理（`setAuthCookie`/`getAuthToken`/`verifyUserToken`）、PIN 哈希与校验（`hashPin`/`verifyPin`） |
| `src/shared/types.ts` | `OAuth2Provider` 类型定义 |

## 数据模型

### oauth_providers 配置结构

`oauth_providers` 作为 `AppConfig` 的一个字段，以 JSON 字符串形式存储在 DB `settings` 表（key = `oauth_providers`），运行时通过 `getConfig()` 返回。字段由 `OAuth2Provider` 类型定义：

```typescript
interface OAuth2Provider {
  id: string            // 提供商标识（如 "github"、"google"），用于路由路径与绑定记录
  name: string          // 前端展示名称（如 "GitHub"、"Google"）
  client_id: string     // OAuth2 客户端 ID
  client_secret: string // OAuth2 客户端密钥（服务端保管，绝不下发给前端）
  authorize_url: string // 授权端点 URL
  token_url: string     // Token 交换端点 URL
  userinfo_url: string  // 用户信息端点 URL
  scopes: string        // 请求的作用域（空格分隔，如 "openid profile email"）
}
```

**关键约定**：

- `client_secret` 仅用于服务端与 IdP 的 `token_url` 交换，**永不**通过 `/providers` 端点下发给前端。
- `/providers` 端点只返回 `id` 和 `name` 两个字段，前端无需知道 `client_secret`、`scopes` 等内部细节。
- `oauth_providers` 可通过 admin 配置接口（`updateConfig`）热更新，无需重启服务。

### 注册开关

`oauth_registration_open` 存储在 DB `settings` 表（key = `oauth_registration_open`），默认值 `"true"`。管理员可通过 admin 接口动态控制 OAuth 新用户注册的开启与关闭。

| 函数 | 行为 |
|---|---|
| `isOauthRegistrationOpen()` | 读取 DB 设置，返回 `boolean` |
| `setOauthRegistrationOpen(open)` | 写入 DB 设置 |

**影响范围**：
- 开关关闭时：callback 检测到全新 OAuth 用户 → 跳转 SPA 页面并携带 `oauth_error=OAuth registration is currently closed`。
- 开关关闭时：`POST /api/oauth/register` 的 `action=create`（新建账户）分支被拒绝 → 403。
- 开关关闭**不影响**：已有绑定的登录（场景 1）和已登录用户的绑定（场景 2）。

### user_oauth_bindings 表

```sql
CREATE TABLE user_oauth_bindings (
  id              TEXT PRIMARY KEY,   -- UUID
  user_id         TEXT NOT NULL,      -- 对应 users.username
  provider_id     TEXT NOT NULL,      -- 对应 OAuth2Provider.id
  provider_user_id TEXT NOT NULL,     -- IdP 返回的用户唯一标识（sub / id / user_id）
  created_at      INTEGER NOT NULL    -- Unix 秒级时间戳
);
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `text` | UUID 主键 |
| `user_id` | `text` | 本地用户 `users.username`，映射到 `users` 表 |
| `provider_id` | `text` | 提供商标识，如 `"github"` |
| `provider_user_id` | `text` | IdP 端用户唯一标识，依次尝试 `sub` → `id` → `user_id` → 兜底 `randomUUID()` |
| `created_at` | `integer` | 绑定创建时间（Unix 秒） |

**唯一性约束**：代码层面通过查询 `WHERE provider_id = ? AND provider_user_id = ?` 保证一个 OAuth 身份只能绑定到一个本地用户。一个本地用户可绑定多个 OAuth 提供商。

## API 契约

### GET /api/oauth/providers

列出已配置的 OAuth2 提供商列表（仅公开 `id` 和 `name`）。

**无需认证**。

**响应**：
```json
{
  "providers": [
    { "id": "github", "name": "GitHub" },
    { "id": "google", "name": "Google" }
  ]
}
```

**行为**：从 `getConfig()` 获取 `oauth_providers` 数组，映射为仅含 `id` 和 `name` 的缩略列表返回。

---

### GET /api/oauth/:providerId/login

发起 OAuth2 登录——生成 `state`、设置 Cookie、构造授权 URL 并 302 重定向。

**无需认证**。

**路径参数**：`:providerId` — 提供商标识。

**Set-Cookie**（三个，均为 `HttpOnly; SameSite=Lax; Path=/api/oauth; Max-Age=600`）：

| Cookie 名 | 内容 | 用途 |
|---|---|---|
| `momoi_oauth_state` | 32 字节随机 hex | CSRF 防护 state 令牌 |
| `momoi_oauth_provider` | 提供商标识（如 `"github"`） | 回调时定位对应提供商配置 |
| `momoi_oauth_origin` | SPA 原始 origin（从 Referer 解析） | 回调完成后跳回 SPA 的正确 origin |

**Referer 解析逻辑**：

```
从 c.req.header('Referer') 提取 origin
  → 成功 → 写入 momoi_oauth_origin Cookie，并作为 redirect_uri 的 baseOrigin
  → 失败/不存在 → 以 c.req.url 的 origin 作为回退
```

因为开发环境请求经 Vite proxy 转发，`c.req.url` 返回的是后端端口（如 `http://localhost:3001`），而浏览器实际访问的是 Vite dev server（如 `http://localhost:5173`），因此必须通过 Referer 获取真实的 SPA origin。无 Referer 时回退到 `c.req.url` 的 origin（适用于非开发环境或 Referer 不可控的场景）。

**构造授权 URL**：

```
GET {provider.authorize_url}
  ?client_id={provider.client_id}
  &redirect_uri={baseOrigin}/api/oauth/callback
  &response_type=code
  &scope={provider.scopes}
  &state={momoi_oauth_state}
```

**响应**：`302 Found` 重定向至 IdP 授权页面。

**错误**：`providerId` 在 `oauth_providers` 中找不到 → `404 { "error": "Unknown OAuth2 provider" }`

---

### GET /api/oauth/callback

OAuth2 回调端点——IdP 将用户授权后带着 `code` 和 `state` 重定向至此。这是整个 OAuth 流程的核心决策点。

**无需认证**。

**查询参数**（IdP 回传）：

| 参数 | 说明 |
|---|---|
| `code` | 授权码（一次性） |
| `state` | CSRF 令牌，须与 `momoi_oauth_state` Cookie 一致 |
| `error` | 若存在则直接失败（如用户拒绝授权） |

**三步决策流程**：

```
验证 state + code + providerId + error
  → 用 code 向 IdP token_url 交换 access_token
  → 用 access_token 调 IdP userinfo_url 获取 remoteId

1. 查 user_oauth_bindings WHERE provider_id + provider_user_id
   → 存在 → 已绑定 → 直接登录（签发 JWT + Set-Cookie）→ 302 → /?oauth_user=xxx&oauth_expires=xxx

2. 不存在 → 检查当前请求是否有有效 momoi_token Cookie
   → 有（已登录）→ 自动绑定（INSERT user_oauth_bindings）→ 302 → /

3. 没有 → 检查 oauth_registration_open 开关
   → 关闭 → 302 → /?oauth_error=OAuth registration is currently closed
   → 开启 → 302 → /?oauth_register=1&provider_id=xxx&provider_user_id=xxx
```

**失败处理**：任一环节失败均执行 `cleanupCookies()`（清除三个 OAuth Cookie），然后 302 重定向至 `{spaOrigin}/?oauth_error={message}`。

**安全校验**（按执行顺序）：

1. `error` 参数存在 → 失败，错误消息使用 IdP 回传的 error 值
2. `state` 为空 / Cookie 中无 state / 两者不匹配 → 失败 `"Invalid state"`（防 CSRF）
3. `code` 为空 → 失败 `"No authorization code"`
4. `providerId` 为空 / 在配置中找不到 → 失败 `"Unknown provider"` / `"Provider not found"`
5. Token 交换失败（无 `access_token`）→ 失败，携带 IdP 响应体原文
6. 已有绑定但绑定的 `user_id` 在 `users` 表中不存在 → 失败 `"Linked user account not found"`
7. 已有绑定但用户被 banned → 失败 `"Account is disabled"`

**HttpOnly Cookie 生命周期**：`cleanupCookies()` 在回调处理完（成功或失败）后执行，确保这三个临时 Cookie 不会残留。如果用户中途关闭浏览器，Cookie 自己有 `maxAge=600`（10 分钟），自然过期。

**remoteId 提取策略**：从 IdP `userinfo_url` 返回的 JSON 中依次尝试 `sub` → `id` → `user_id`，兜底使用 `randomUUID()`（兼容各种 IdP 的字段命名差异）。

---

### POST /api/oauth/register

完成 OAuth 注册的最后一步——由前端注册页面调用。用户在 SPA 的 `oauth_register` 界面选择操作类型并提交。

**无需认证**（前端注册阶段，尚未有 JWT）。

**请求**：
```json
{
  "provider_id": "github",
  "provider_user_id": "12345678",
  "action": "link" | "create",
  "username": "xrl",
  "pin": "1234"
}
```

| 字段 | 说明 |
|---|---|
| `provider_id` | 提供商标识，须与 callback 阶段写入 URL 的值一致 |
| `provider_user_id` | IdP 用户唯一标识，由 callback 阶段的 `oauth_register` 重定向 URL 携带 |
| `action` | `"link"` — 绑定到已有本地账户 / `"create"` — 创建新账户并绑定 |
| `username` | 目标用户名（link 时须为已存在账户，create 时须为未占用用户名） |
| `pin` | 4-8 位数字 PIN（正则 `^\d{4,8}$`） |

**action="link" 处理流程**：

```
验证 provider_id + provider_user_id 尚未被绑定（防竞态重复绑定）
  → 查 users 表，确认 username 存在
  → 确认用户已设置 PIN（pin_hash 不为空）
  → 确认用户未被 banned
  → verifyPin(pin, userRow.pin_hash) 验证 PIN
  → INSERT user_oauth_bindings
  → 更新 last_login_at
  → signUserToken + setAuthCookie → 返回 JSON（含 username + expires_at）
```

**action="create" 处理流程**：

```
检查 oauth_registration_open 开关
  → 关闭 → 403
  → 开启 → 查 users 表，确认 username 未被占用
  → hashPin(pin) + INSERT users（PIN 哈希、时间戳）
  → INSERT user_oauth_bindings
  → signUserToken + setAuthCookie → 返回 JSON（含 username + expires_at）
```

**响应（成功）**：
```json
{
  "username": "xrl",
  "expires_at": 1702598400
}
```
外加 `Set-Cookie: momoi_token=<jwt>; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600`

**错误**：

| 情况 | 状态码 | 消息 |
|---|---|---|
| 缺少必填字段 | 400 | `Missing required fields` |
| PIN 非 4-8 位数字 | 400 | `PIN must be 4-8 digits` |
| OAuth 身份已被绑定 | 409 | `This OAuth account is already linked` |
| link: 用户名不存在 | 404 | `Account not found` |
| link: 用户未设置 PIN | 400 | `Account has no PIN set` |
| link: 用户被 banned | 403 | `Account is disabled` |
| link: PIN 不匹配 | 401 | `Invalid PIN` |
| create: 用户名已被占用 | 409 | `Username already taken` |
| create: 注册开关关闭 | 403 | `OAuth registration is currently closed` |

## 完整认证流程

### 流程图

```
用户点击 "Login with GitHub"
  │
  ▼
GET /api/oauth/github/login
  │  ├─ 生成 state (randomBytes 32)
  │  ├─ Set-Cookie: momoi_oauth_state / momoi_oauth_provider / momoi_oauth_origin
  │  └─ 302 → https://github.com/login/oauth/authorize?...
  │
  ▼
用户在 IdP 授权页面确认
  │
  ▼
IdP 302 → /api/oauth/callback?code=xxx&state=yyy
  │
  ├─ [state 不匹配] ──→ 302 /?oauth_error=Invalid state
  │
  ├─ [error 参数存在] ──→ 302 /?oauth_error={error}
  │
  ├─ [code 为空] ──→ 302 /?oauth_error=No authorization code
  │
  ▼
POST IdP token_url（code → access_token）
  │
  ├─ [交换失败] ──→ 302 /?oauth_error=Token exchange failed: ...
  │
  ▼
GET IdP userinfo_url（access_token → user info）
  │
  ▼
查 user_oauth_bindings（provider_id + provider_user_id）
  │
  ├── [存在绑定] ──────────────────────────────────────────────┐
  │     │                                                        │
  │     ├─ [对应用户不存在] ──→ 302 /?oauth_error=...             │
  │     ├─ [对应用户 banned] ──→ 302 /?oauth_error=...            │
  │     │                                                        │
  │     └─ 签发 JWT → Set-Cookie: momoi_token                     │
  │        → 302 /?oauth_user=xxx&oauth_expires=xxx  ◄── 登录成功 │
  │                                                               │
  ├── [无绑定 + 有有效 momoi_token] ──────────────────────────────┤
  │     │                                                        │
  │     └─ INSERT user_oauth_bindings（绑定到当前用户）            │
  │        → 302 /                              ◄── 绑定成功      │
  │                                                               │
  └── [无绑定 + 无有效 token] ────────────────────────────────────┤
        │                                                        │
        ├─ [oauth_registration_open = false]                      │
        │     └─ 302 /?oauth_error=OAuth registration is closed   │
        │                                                        │
        └─ [oauth_registration_open = true]                       │
              └─ 302 /?oauth_register=1&provider_id=...&...       │
                    │                                             │
                    ▼  (前端注册页面)                              │
              POST /api/oauth/register                            │
                    │                                             │
                    ├─ action=link（绑定已有账户）                  │
                    │     ├─ 验证 PIN                              │
                    │     ├─ INSERT binding                        │
                    │     └─ 签发 JWT + Set-Cookie → 登录成功       │
                    │                                             │
                    └─ action=create（创建新账户）                  │
                          ├─ 检查开关                              │
                          ├─ 创建用户 + PIN 哈希                   │
                          ├─ INSERT binding                        │
                          └─ 签发 JWT + Set-Cookie → 登录成功       │
```

### 三种场景汇总

| 场景 | 触发条件 | 服务端行为 | 最终结果 |
|---|---|---|---|
| 已有绑定直接登录 | `user_oauth_bindings` 中存在匹配行 | 签发 JWT → 302 `/?oauth_user=xxx&oauth_expires=xxx` | 用户进入主界面 |
| 已登录绑定新账号 | 无绑定 + `momoi_token` Cookie 有效 | `INSERT user_oauth_bindings` → 302 `/` | 绑定完成，保持登录态 |
| 新用户注册 | 无绑定 + 无有效 token + 开关开启 | 302 `/?oauth_register=1&...` → 前端注册页 → `POST /register` | 创建账户 + 绑定 + 签发 JWT |

## 安全考量

### State Cookie 防 CSRF

- 每次发起登录请求时服务端生成一个 `crypto.randomBytes(32).toString('hex')` 的随机 state 值。
- State 通过两个通道传输：**Cookie**（`momoi_oauth_state`，HttpOnly + SameSite=Lax）和 **URL 查询参数**（`state={value}`，经 IdP 回传）。
- 回调时对比 `c.req.query('state')` 与 `getCookie(c, 'momoi_oauth_state')`，不匹配则拒绝。
- 攻击者无法读取 `HttpOnly` Cookie，也无法在跨站请求中携带 `SameSite=Lax` 的 Cookie 到 GET 端点（但注意 SameSite=Lax 允许顶级导航 GET 携带 Cookie，state 校验是真正的防线）。
- State Cookie 有效期 600 秒（10 分钟），超过则自然失效。

### Referer 检测 SPA Origin

- `redirect_uri` 的构造依赖 SPA origin 的正确识别。
- 开发环境（Vite proxy）：`c.req.url` 指向后端端口，必须从 `Referer` 请求头提取真实 SPA origin。
- 生产环境：无 proxy 时 `c.req.url` 的 origin 即为正确值，但 Referer 策略同样适用。
- Referer 解析失败时回退到 `c.req.url` 的 origin。
- **注意**：Referer 可由浏览器策略或隐私插件移除，回退机制保证即使无 Referer 时流程仍可继续（只是可能在生产环境多一次重定向链路调整）。

### Registration Gate（注册开关）

- `oauth_registration_open` 默认 `"true"`（允许注册），管理员可通过 admin API 动态关闭。
- **双重检查**：callback 阶段和 `POST /register` 的 `action=create` 分支均检查此开关。
  - Callback 阶段拦截：防止新用户进入注册页面（尽早拒绝）。
  - Register 阶段拦截：防止绕过前端校验直接调用 API（即使 URL 参数被人为保留）。
- 开关关闭**不影响**已有绑定登录和已登录用户的绑定——这两个路径无需创建新账户。

### 其他安全点

- `client_secret` 仅用于服务端与 IdP 的 `token_url` 通信，不出现在 `/providers` 响应中，也不出现在任何前端可见的 URL 或 Cookie 中。
- Token 交换使用服务端 fetch，浏览器无法观察到 `client_secret`。
- OAuth Cookie 路径限定为 `/api/oauth`，其他路径无法读取这些 Cookie。
- 回调完成后 `cleanupCookies()` 立即清除三个 OAuth Cookie，防止残留。
- `POST /register` 的 `action=link` 要求提供已有账户的 PIN——OAuth 绑定不能绕过 PIN 验证获取账户控制权。
- 每次成功认证 / 绑定均更新 `users.last_login_at`。

## 行为约束

1. **一个 OAuth 身份只能绑定一个本地用户**：`user_oauth_bindings` 的 `(provider_id, provider_user_id)` 在代码层面保证唯一性（callback 阶段第 1 步先查已有绑定；register 阶段 `action=link` 和 `action=create` 各自在 INSERT 前二次检查）。若发现已绑定则返回 409。
2. **一个本地用户可以绑定多个 OAuth 提供商**：`user_oauth_bindings` 允许多行共享同一个 `user_id`。
3. **OAuth 绑定不能绕过 PIN**：`action=link` 需要用户提供已有账户的 PIN 进行验证；`action=create` 需要用户设置新 PIN。OAuth 是登录方式，不是 PIN 替代品。
4. **provider_user_id 字段兼容性**：IdP 的用户标识字段名称不统一（有的叫 `sub`，有的叫 `id`，有的叫 `user_id`），服务端依次尝试 `sub` → `id` → `user_id`，兜底使用 `randomUUID()`。这确保即使 IdP 返回了未知结构的响应，流程也不会崩溃，只是会将此 OAuth 身份视为全新用户。
5. **OAuth Cookie 作用域隔离**：三个临时 Cookie（`momoi_oauth_state`、`momoi_oauth_provider`、`momoi_oauth_origin`）的 `Path=/api/oauth`，与认证 Cookie `momoi_token`（`Path=/`）互不干扰。
6. **OAuth 注册端点不经过任何认证中间件**：`GET /callback` 和 `POST /register` 在用户尚未持有 JWT 时调用，因此不挂载 `userAuthMiddleware`。认证逻辑在 handler 内自行处理。
7. **Callback 的 user 表存在性校验**：即使 `user_oauth_bindings` 中存在绑定行，也必须确认对应 `users` 行仍然存在且未被 banned。覆盖用户被管理员删除或封禁的边缘情况。
8. **可观测性**：所有失败路径均通过 URL 参数（`oauth_error`）向 SPA 报告错误消息，前端可据此向用户展示友好提示。

## 验收标准

### 功能验收

- [ ] 未配置任何 `oauth_providers` 时，`/providers` 返回空数组，不报错。
- [ ] 点击 OAuth 登录按钮后正确跳转至 IdP 授权页面，URL 参数（client_id、redirect_uri、scope、state）齐全。
- [ ] 用户在 IdP 拒绝授权时，回调携带 `error` 参数，SPA 收到 `oauth_error` 并展示错误。
- [ ] **场景 1**：已有绑定的 OAuth 账号登录 → 直接签发 JWT → SPA 收到 `oauth_user` + `oauth_expires` → 前端自动完成登录。
- [ ] **场景 2**：已登录用户绑定新 OAuth 账号 → 自动 INSERT `user_oauth_bindings` → 页面刷新后 `oauth_providers` 列表中该提供商显示已绑定。
- [ ] **场景 3a**：全新 OAuth 用户（开关开启）→ 跳转注册页面 → 选择"创建新账户"→ 输入用户名 + PIN → 成功登录，`users` 表新增行 + `user_oauth_bindings` 表新增行。
- [ ] **场景 3b**：全新 OAuth 用户（开关开启）→ 跳转注册页面 → 选择"绑定已有账户"→ 输入已有用户名 + PIN → 验证通过 → 成功绑定并登录。
- [ ] **场景 3c**：全新 OAuth 用户（开关关闭）→ callback 返回 `oauth_error=OAuth registration is currently closed`，不进入注册页面。

### 安全验收

- [ ] State 不匹配时回调被拒绝（302 至 `?oauth_error=Invalid state`），无法完成登录。
- [ ] 绕过前端直接 `POST /register` 且 `action=create` + 开关关闭时 → 403 拒绝。
- [ ] 绕过前端直接 `POST /register` 且 `action=link` + 错误 PIN → 401 拒绝。
- [ ] 对已被绑定到用户 A 的 OAuth 身份，尝试通过 `POST /register` 绑定到用户 B → 409 拒绝。
- [ ] 对已被 banned 的用户，OAuth 登录被拒绝（`oauth_error=Account is disabled`）。
- [ ] `GET /api/oauth/providers` 响应中不包含 `client_secret` 字段。
- [ ] OAuth Cookie（state/provider/origin）在 callback 完成后被清除（`Max-Age=0` Set-Cookie）。

### 边界验收

- [ ] Referer 缺失时，`redirect_uri` 回退到 `c.req.url` 的 origin，流程不崩溃。
- [ ] IdP userinfo 返回结构异常（无 `sub`/`id`/`user_id`）时，兜底 `randomUUID()`，视为新用户进入注册流程。
- [ ] `oauth_providers` 配置为空数组时，所有 OAuth 端点返回 404（login）或空列表（providers）。
- [ ] Token 交换超时或 IdP 返回非 JSON → catch 块捕获 → 302 `?oauth_error=OAuth error: {message}`。
- [ ] `POST /register` 缺少任意必填字段 → 400。
- [ ] PIN 不符合 `^\d{4,8}$` → 400。