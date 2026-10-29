# Spec — OIDC 第三方登录

## 概述

OIDC 模块提供第三方身份提供商（IdP）登录能力，使用标准 **OpenID Connect Authorization Code Flow**。

与已废弃的 OAuth2 实现（D35 早期版本）相比，本模块的核心变化：

| 维度 | 旧（OAuth2） | 新（OIDC） |
|---|---|---|
| 端点来源 | 管理员手填 3 个 URL | `issuer` + discovery 自动获取 |
| 身份来源 | userinfo 端点，`sub → id → user_id → randomUUID()` 猜测 | **验签后的 id_token.sub**，语义唯一确定 |
| 签名校验 | 无 | HS256（clientSecret）或 RS256+（JWKS） |
| 兜底 | `randomUUID()`（每次登录都成新用户） | 无 id_token 时回退 userinfo，无 sub 直接报错 |

整体分为三种场景：

1. **已有绑定直接登录**：OIDC 身份已在 `user_oidc_bindings` 表中绑定到某个本地用户 → 直接签发 JWT 并跳转回 SPA，无需输入 PIN。
2. **已登录绑定新账号**：用户已在浏览器中持有有效 JWT（`momoi_token` Cookie），但该 OIDC 身份尚未绑定任何本地账户 → 自动绑定到当前登录账户。
3. **全新 OIDC 用户注册**：无绑定且无有效 JWT → 若 `oidc_registration_open` 开关打开，跳转至 SPA 注册页面（`oidc_register=1`），由前端引导用户选择「绑定已有账户」（link）或「创建新账户」（create）。

职责边界：服务端负责 OIDC 协议交互（discovery、跳转、code 换 token、id_token 验签、userinfo）与绑定管理；前端负责注册 UI。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `apps/server/src/routes/oidc.ts` | OIDC 服务端实现：登录发起、回调处理、注册完成 |
| `apps/server/src/lib/oidc-discovery.ts` | discovery 拉取、缓存（1h TTL）、issuer 一致性校验、端点解析（含覆盖项） |
| `apps/server/src/lib/oidc-verify.ts` | id_token 验签（HS256 / 非对称双路径） |
| `apps/server/src/db/schema.sqlite.ts` / `schema.pg.ts` | `user_oidc_bindings` 表定义 |
| `apps/server/src/lib/config.ts` | `oidc_providers` 配置读写 + `oidc_registration_open` 开关 |
| `apps/server/src/lib/auth.ts` | JWT 签发、Cookie 管理、PIN 哈希与校验 |
| `apps/web/src/components/auth/OidcRegisterScreen.tsx` | 注册 UI（link / create 双 Tab） |
| `packages/shared/src/types.ts` | `OidcProvider` 类型定义 |

## 数据模型

### OidcProvider 配置结构

`oidc_providers` 作为 `AppConfig` 的一个字段，以 JSON 字符串形式存储在 DB `settings` 表（key = `oidc_providers`），运行时通过 `getConfig()` 返回。

```typescript
interface OidcProvider {
  id: string              // 提供商标识，用于路由路径与绑定记录
  name: string            // 前端展示名称
  issuer: string          // 必填。discovery 基座，如 https://dingtalk.auth.xrl.im/my_org
  client_id: string
  client_secret: string   // 服务端保管，绝不下发给前端；HS256 场景下同时用作验签密钥
  scopes: string          // 默认 openid；服务端会确保含有 openid
  // ---- 可选覆盖项：留空即走 discovery，仅非标 Provider 才填 ----
  authorize_url?: string
  token_url?: string
  userinfo_url?: string
}
```

**关键约定**：

- `issuer` 必填，且会与 discovery 返回的 `issuer` 做**一致性校验**——不一致直接报错，防止中间人把 discovery 换成别的 issuer。
- `client_secret` 仅用于服务端与 IdP 通信，**永不**通过 `/providers` 端点下发给前端。
- 三个 URL 覆盖项是**逃生舱**：`authorize_url` 与 `token_url` **同时**填写时完全跳过 discovery（非 OIDC Provider 场景）；只填其中之一仍会拉 discovery 补齐其余端点。
- `oidc_providers` 可通过 admin 配置接口热更新，无需重启。

### 注册开关

`oidc_registration_open` 存储在 DB `settings` 表（key = `oidc_registration_open`），默认 `"true"`。

| 函数 | 行为 |
|---|---|
| `isOidcRegistrationOpen()` | 读新键；新键缺失时回退读旧键 `oauth_registration_open`（升级兼容） |
| `setOidcRegistrationOpen(open)` | 只写新键 |

**影响范围**：

- 开关关闭 → 全新 OIDC 用户回调时 302 至 `?oidc_error_code=OIDC_REGISTRATION_CLOSED`。
- 开关关闭 → `POST /api/oidc/register` 的 `action=create` 分支被拒绝（403）。
- 开关关闭**不影响**已有绑定登录（场景 1）和已登录用户绑定（场景 2）。

### user_oidc_bindings 表

```sql
CREATE TABLE user_oidc_bindings (
  id               TEXT PRIMARY KEY,   -- UUID
  user_id          TEXT NOT NULL,      -- 对应 users.username
  provider_id      TEXT NOT NULL,      -- 对应 OidcProvider.id
  provider_user_id TEXT NOT NULL,      -- id_token 的 sub
  created_at       INTEGER NOT NULL,   -- Unix 秒
  UNIQUE(provider_id, provider_user_id)
);
```

**迁移**：旧表 `user_oauth_bindings` 改名为 `user_oidc_bindings`。SQLite 启动时执行幂等
`INSERT OR IGNORE INTO user_oidc_bindings SELECT * FROM user_oauth_bindings`；
旧表**保留不删**以便回退。PG 部署需手动 `ALTER TABLE user_oauth_bindings RENAME TO user_oidc_bindings`。

**唯一性**：`(provider_id, provider_user_id)` 唯一约束保证一个 OIDC 身份只绑定一个本地用户；一个本地用户可绑定多个 Provider。

## Discovery

### 拉取

```
GET ${issuer}/.well-known/openid-configuration
```

使用字段：

| 字段 | 用途 |
|---|---|
| `issuer` | 与配置值比对，不一致即拒绝 |
| `authorization_endpoint` | 登录发起时的跳转目标 |
| `token_endpoint` | code 换 token |
| `userinfo_endpoint` | id_token 缺失时的身份回退 |
| `jwks_uri` | 非对称签名算法的公钥源 |
| `id_token_signing_alg_values_supported` | 决定验签走对称还是非对称 |
| `token_endpoint_auth_methods_supported` | 决定 client 凭据放 body 还是 Basic 头 |

### 缓存

- 进程内 `Map<issuer, { doc, fetchedAt }>`，**TTL 1 小时**。
- `clearDiscoveryCache()` 供测试与配置变更后强制刷新。
- 不落库：discovery 是纯派生的远端元数据，落库会在多实例部署下产生陈旧副本。

## id_token 验签

### 算法选择

按 discovery 的 `id_token_signing_alg_values_supported` 自动决定：

| 场景 | 密钥 | 说明 |
|---|---|---|
| 列表含 `HS256`/`HS384`/`HS512` | `TextEncoder.encode(client_secret)` | 参考 Provider `oidc-dingtalk` 用的是 HS256 |
| 仅非对称（`RS256`/`ES256` 等） | `createRemoteJWKSet(new URL(jwks_uri))` | 标准 OIDC Provider |

### 校验项

```ts
await jwtVerify(idToken, key, {
  issuer: provider.issuer,          // 防 issuer 混用
  audience: provider.client_id,     // 防 audience 混用
  algorithms: signingAlgs,          // 白名单，防 alg:none 降级
  clockTolerance: 30,               // 允许 30s 时钟偏差
})
```

- **必须传 `algorithms`**：不传则攻击者可把 header 改为 `alg: none` 绕过验签。
- `sub` 必须非空，否则拒绝。
- **不校验 `nonce`**：`oidc-dingtalk` 无状态，无法把 nonce 绑进 id_token（其 README 明确声明）；CSRF 由 state 独立承担。

## API 契约

### GET /api/oidc/providers

列出已配置的 OIDC 提供商（仅 `id` 与 `name`）。无需认证。

```json
{ "providers": [{ "id": "dingtalk", "name": "钉钉" }] }
```

---

### GET /api/oidc/:providerId/login

发起登录：生成 state、设 Cookie、解析端点、302 重定向。无需认证。

**Set-Cookie**（三个，`HttpOnly; SameSite=Lax; Path=/api/oidc; Max-Age=600`）：

| Cookie | 内容 |
|---|---|
| `momoi_oidc_state` | 32 字节随机 hex（CSRF） |
| `momoi_oidc_provider` | 提供商标识 |
| `momoi_oidc_origin` | SPA 原始 origin（从 Referer 解析） |

**Referer 解析**：开发模式下请求经 Vite 代理，`c.req.url` 指向后端端口，必须用 Referer 取真实 SPA origin；失败时回退 `c.req.url` 的 origin。

**构造授权 URL**：

```
GET {discovery.authorization_endpoint | provider.authorize_url}
  ?client_id={client_id}
  &redirect_uri={baseOrigin}/api/oidc/callback
  &response_type=code
  &scope={确保含 openid}
  &state={momoi_oidc_state}
```

**错误**：Provider 不存在 → `404 OIDC_UNKNOWN_PROVIDER`；discovery 失败 → 302 `?oidc_error_code=OIDC_PROVIDER_ERROR`。

---

### GET /api/oidc/callback

OIDC 回调。核心决策点。

**流程**：

```
验证 state / code / providerId / error
  → 解析端点（覆盖项优先，否则拉 discovery）
  → POST token_endpoint（client_secret_post）换 token
  → 若响应含 id_token：
        verifyIdToken(...) → sub 即 provider_user_id
        验签失败 → 302 ?oidc_error_code=OIDC_ID_TOKEN_INVALID
  → 否则回退 GET userinfo_endpoint 取 sub（非标 Provider）
  → 三态决策（见下）
```

**三态决策**：

```
1. 查 user_oidc_bindings WHERE provider_id + provider_user_id
   → 存在 → 签发 JWT → 302 /?oidc_user=xxx&oidc_expires=xxx

2. 不存在 → 当前有有效 momoi_token Cookie？
   → 有 → 自动绑定 → 302 /

3. 都没有 → oidc_registration_open？
   → 关闭 → 302 /?oidc_error_code=OIDC_REGISTRATION_CLOSED
   → 开启 → 302 /?oidc_register=1&provider_id=...&provider_user_id=...[&provider_name=...&provider_picture=...]
```

**失败码**（均 302 至 `{spaOrigin}/?oidc_error_code=<CODE>`）：

| 码 | 触发条件 |
|---|---|
| `OIDC_PROVIDER_ERROR` | IdP 回传 error、discovery 失败、身份无法解析 |
| `OIDC_INVALID_STATE` | state 不匹配或缺失（防 CSRF） |
| `OIDC_NO_AUTH_CODE` | 缺 code |
| `OIDC_UNKNOWN_PROVIDER` | Provider 不在配置中 |
| `OIDC_TOKEN_EXCHANGE_FAILED` | token 端点失败或无 access_token |
| `OIDC_ID_TOKEN_INVALID` | id_token 签名 / iss / aud / exp 校验失败 |
| `OIDC_LINKED_USER_NOT_FOUND` | 绑定指向的用户已不存在 |
| `USER_DISABLED` | 用户被封禁 |

---

### POST /api/oidc/register

完成注册（前端 `oidc_register` 界面调用）。无需认证。

**请求**：

```json
{
  "provider_id": "dingtalk",
  "provider_user_id": "userid-from-id-token",
  "action": "link" | "create",
  "username": "xrl",
  "pin": "1234"
}
```

**action="link"**：校验 `(provider_id, provider_user_id)` 未被绑定 → 用户存在 → 已设 PIN → 未被封禁 → PIN 校验通过 → 插入绑定 → 签发 JWT。

**action="create"**：检查开关 → 用户名未占用 → 创建用户 + 插入绑定 → 签发 JWT。

**错误**：

| 情况 | 状态码 | 码 |
|---|---|---|
| 缺必填字段 | 400 | `OIDC_MISSING_FIELDS` |
| PIN 非 4-8 位 | 400 | `USER_PIN_FORMAT` |
| OIDC 身份已绑定 | 409 | `OIDC_ALREADY_LINKED` |
| link: 用户不存在 | 404 | `OIDC_ACCOUNT_NOT_FOUND` |
| link: 未设 PIN | 400 | `OIDC_ACCOUNT_NO_PIN` |
| link: 被封禁 | 403 | `USER_DISABLED` |
| link: PIN 错 | 401 | `AUTH_INVALID_PIN` |
| create: 用户名占用 | 409 | `USER_NAME_TAKEN` |
| create: 注册关闭 | 403 | `OIDC_REGISTRATION_CLOSED` |

---

### GET /api/user/oidc-bindings

列出当前用户的 OIDC 绑定。需 `userAuthMiddleware`。

```json
{ "bindings": [{ "id": "uuid", "provider_id": "dingtalk", "created_at": 1700000000 }] }
```

### DELETE /api/user/oidc-bindings/:id

解除绑定。需认证。校验所有权与「至少保留一种登录方式」（PIN 或其他绑定）。

---

## 安全考量

### State 防 CSRF

- 每次登录生成 `randomBytes(32)` 的 hex state，同时写 HttpOnly Cookie 与 URL 查询参数。
- 回调对比 `c.req.query('state')` 与 Cookie，不匹配即拒绝。
- 攻击者无法读 HttpOnly Cookie，也无法在跨站请求中携带 SameSite=Lax 的 Cookie。Cookie 有效期 600 秒。

### id_token 验签

- 必须传 `algorithms` 白名单，杜绝 `alg: none` 降级。
- `iss` 与 `aud` 由 `jwtVerify` 强制校验。
- HS256 场景下 `client_secret` 既是客户端凭据又是验签密钥——这要求 Provider 与 RP 共享同一秘密，是 `oidc-dingtalk` 的取舍（自用单部署，零密钥运维）。对第三方 IdP 应使用非对称算法。

### Discovery 校验

- 拉回文档后比对 `doc.issuer === 配置 issuer`，不一致即拒绝。这防止攻击者篡改 discovery 响应把验签锚点换掉。

### 其他

- `client_secret` 不出现在 `/providers` 响应、任何前端可见 URL 或 Cookie 中。
- OIDC 临时 Cookie 路径限定 `/api/oidc`，与 `momoi_token`（`/`）隔离。
- 回调完成后立即清除三个临时 Cookie。
- `action=link` 要求提供已有账户 PIN——OIDC 绑定不能绕过 PIN 获取账户控制权。
- 每次成功认证 / 绑定均更新 `users.last_login_at`。

## 行为约束

1. **一个 OIDC 身份只能绑定一个本地用户**：`(provider_id, provider_user_id)` 在代码与 DB 约束双重保证。
2. **一个本地用户可以绑定多个 Provider**。
3. **OIDC 绑定不能绕过 PIN**：link 需 PIN 验证，create 需设置 PIN。
4. **`sub` 不再做模糊兜底**：旧实现 `sub → id → user_id → randomUUID()` 全部废弃——`randomUUID()` 会让同一用户每次登录都被当成新用户。现在只认 `id_token.sub`，缺失即报错。
5. **临时 Cookie 作用域隔离**：三个 `momoi_oidc_*` 的 `Path=/api/oidc`。
6. **注册与回调端点不挂认证中间件**：用户尚未持有 JWT 时调用，认证逻辑在 handler 内处理。
7. **回调的 users 表存在性校验**：即使绑定存在，也必须确认用户行仍存在且未封禁。
8. **可观测性**：所有失败路径经 URL 参数（`oidc_error_code`，可选 `oidc_error_detail`）向 SPA 报告。

## 验收标准

### 功能

- [ ] 未配置任何 Provider 时 `/providers` 返回空数组。
- [ ] 填了合法 issuer 后点击登录按钮，正确跳转至 IdP 授权页，URL 参数齐全。
- [ ] discovery 第二次调用不重复发请求（缓存生效）。
- [ ] **场景 1**：已有绑定 → 直接签发 JWT → SPA 收到 `oidc_user` + `oidc_expires`。
- [ ] **场景 2**：已登录用户绑定新身份 → 自动插入绑定 → 页面刷新后显示已绑定。
- [ ] **场景 3a**：全新用户（开关开启）→ 注册页 → 创建账户 → 成功登录。
- [ ] **场景 3b**：全新用户（开关开启）→ 注册页 → 绑定已有账户 → PIN 校验通过后登录。
- [ ] **场景 3c**：全新用户（开关关闭）→ `oidc_error_code=OIDC_REGISTRATION_CLOSED`。

### 安全

- [ ] state 不匹配被拒绝。
- [ ] id_token 用错误 client_secret 签名 → `OIDC_ID_TOKEN_INVALID`。
- [ ] id_token 的 `iss` / `aud` 不匹配 → `OIDC_ID_TOKEN_INVALID`。
- [ ] id_token 过期 → `OIDC_ID_TOKEN_INVALID`。
- [ ] 算法降级（声明 HS256 但 token 用 HS512）→ 拒绝。
- [ ] discovery 返回的 issuer 与配置不一致 → `OIDC_PROVIDER_ERROR`。
- [ ] 绕过前端直接 `POST /api/oidc/register` 且关闭开关 + `action=create` → 403。
- [ ] 沿用旧 PIN 攻击：`action=link` + 错误 PIN → 401。
- [ ] 已绑定身份尝试二次绑定 → 409。
- [ ] `GET /api/oidc/providers` 响应不含 `client_secret`。

### 边界

- [ ] Referer 缺失时 `redirect_uri` 回退 `c.req.url` 的 origin。
- [ ] 同时填 `authorize_url` + `token_url` 时完全跳过 discovery。
- [ ] 只填 `authorize_url` 时仍拉 discovery 补全 `token_endpoint`。
- [ ] IdP 不返回 id_token 时回退 userinfo；userinfo 也无 sub 则报错（不再兜底 randomUUID）。
- [ ] token 端点返回非 JSON → catch → `OIDC_PROVIDER_ERROR`。

### 迁移

- [ ] 旧库 `user_oauth_bindings` 数据完整迁移到 `user_oidc_bindings`。
- [ ] 旧配置键 `oauth_providers` / `oauth_registration_open` 在升级后仍可读。