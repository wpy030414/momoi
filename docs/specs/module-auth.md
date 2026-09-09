# Spec — 认证系统（Auth）

## 概述

认证分为两层：**用户认证**（用户名 + 4 位 PIN → 用户 JWT）与**管理员授权**（用户 JWT + `ADMIN` 环境变量用户名名单）。没有独立的管理员密钥或管理员 token——管理员端点接受普通用户 JWT，并由 `adminAuthMiddleware` 逐请求校验用户名是否在 `ADMIN` 名单内。

## 涉及文件

| 文件 | 职责 |
|---|---|
| `src/server/auth.ts` | PIN 哈希/校验 + 用户 JWT 签发验证 + 签名密钥管理 + `isAdmin()`/`adminAuthMiddleware` |
| `src/server/middleware/userAuth.ts` | 独立的用户 JWT 认证中间件（严格模式，不接受 `X-User` 回退） |
| `src/server/routes/user.ts` | 用户 PIN 相关端点（状态查询/验证/设置/修改）+ `GET /me`（管理员身份探测） |
| `src/server/config.ts` | `env.ADMIN` 名单解析、`env.JWT_SECRET` 读取 |
| `src/server/rateLimiter.ts` | IP 速率限制器（PIN 暴力破解防护） |
| `src/client/components/auth/LoginScreen.tsx` | 三步登录 UI |
| `src/client/components/settings/ChangePinDialog.tsx` | 修改 PIN 表单 |

## 用户认证流程

```
打开应用
  → localStorage 中有 user + token？
    → 有 → 携带 Bearer token 请求，成功则直接进入
  → 无 → LoginScreen
    → 步骤 1：输入用户名 → GET /api/user/status（X-User 头）
    → 步骤 2a（已有 PIN）：输入 4 位 PIN → POST /api/user/verify
    → 步骤 2b（新用户）：设置 4 位 PIN → POST /api/user/set-pin
    → 返回 { token, expires_at } → 存入 localStorage → 进入主界面
```

## PIN 存储与哈希

- **算法**：PBKDF2，`10000` 次迭代，`sha512`，派生长度 64 字节
- **盐**：`randomBytes(16).toString('hex')`，每个用户独立随机生成
- **存储格式**：`{salt}:{hash}`（均为 hex 字符串）
- **存储位置**：`settings` 表，键为 `pin:{username}`，值为上述哈希串
- **比较**：`crypto.timingSafeEqual` 防止时序侧信道

## JWT 实现细节

| 项 | 用户 Token |
|---|---|
| 算法 | HS256 |
| Payload | `{ role: 'user', sub: username }` |
| 有效期 | 14 天（`USER_TOKEN_TTL_SECONDS`） |
| 签发函数 | `signUserToken(username)`（`/verify`、`/set-pin`、`/refresh` 共用） |
| 验证函数 | `verifyUserToken(token)` |
| 响应字段 | `{ token, expires_at }` |

- **滑动续期**：token 剩余寿命**不足一半**（< 7 天）时，客户端调 `POST /api/user/refresh` 换新 14 天 token（`App.tsx` 定时调度 + 页面唤醒时检查）。应用保持打开则永不过期；超过 14 天未打开应用，token 自然失效，需重新输 PIN

- **签名密钥**：`JWT_SECRET` 环境变量（若提供）；否则首次启动生成 32 字节随机密钥并持久化到 `settings` 表（键 `jwt_secret`），重启后复用，用户 token 不因重启失效
- 验证时除签名外还须匹配 `role === 'user'`，且 `sub` 为字符串
- 管理员授权与 token 无关：`adminAuthMiddleware` 验证用户 JWT 后检查 `isAdmin(username)`（`env.ADMIN` 名单，进程生命周期内固定）

## IP 速率限制

内存级 IP 速率限制器，仅用于 PIN 登录防护。

**规则**：同一 IP 连续 5 次 PIN 错误 → 封禁 5 分钟。状态存于内存，重启服务即清除。

**API**：
- `checkIpBlocked(ip)` → 返回 null（放行）或封禁原因字符串（含剩余秒数）
- `recordPinFailure(ip)` → 记录一次失败，达到阈值后封禁
- `clearPinFailures(ip)` → 验证成功后清除记录
- `getClientIp(c)` → 从请求提取 IP（优先 `x-forwarded-for`，兜底 `socket.remoteAddress`）

**行为**：
- 封禁期内失败不再累加
- 定时清理过期条目（每分钟）
- 封禁到期后自动清除

## 中间件实现

| 导出位置 | 是否被路由使用 | 行为 |
|---|---|---|
| `src/server/middleware/userAuth.ts` | ✅ 是（chat / conversations / upload / workspace） | 严格模式：只接受 `Authorization: Bearer <jwt>` |
| `src/server/auth.ts` 中的同名函数 | ❌ **否（当前无路由导入，属遗留代码）** | 允许 `X-User` 头回退 |

**严格版本（实际生效）**：

1. 只接受 `Authorization: Bearer <jwt>`
2. 缺失或无效 → `401`
3. 成功则 `c.set('userId', username)` 并 `await next()`

> ⚠️ 注意：`auth.ts` 中带 `X-User` 回退的版本虽仍被导出，但没有任何路由导入它。**新增路由务必从 `middleware/userAuth.js` 导入**，否则会意外放行伪造的 `X-User` 头。该冗余导出可在后续清理。

`/api/user/*` 端点不经过任何认证中间件（登录前无 token），改为在 handler 内直接读取 `x-user` 头解析用户名。

## 接口契约

### GET /api/user/status

查询当前用户名是否已设置 PIN。**此端点用 `X-User` 头识别用户（登录前无 JWT）。**

**响应**：`{ "has_pin": true | false }`

**错误**：缺少 `X-User` → `400 { "error": "Username required" }`

### POST /api/user/verify

验证 PIN 并签发用户 JWT。

**请求头**：`X-User: 用户名`

**请求**：
```json
{ "pin": "1234" }
```

**响应**：
```json
{ "token": "eyJhbGciOiJIUzI1NiJ9...", "expires_at": 1702598400 }
```

**错误**：

| 情况 | 状态码 |
|---|---|
| PIN 非 4 位数字 | 400 `PIN must be 4 digits` |
| 该用户未设置 PIN | 404 `PIN not set` |
| PIN 不匹配 | 401 `Invalid PIN` |
| 连续 5 次 PIN 错误 | 429 Too many failed attempts |

### POST /api/user/set-pin

首次设置 PIN（无需旧 PIN），成功后直接签发 JWT。

**请求头**：`X-User: 用户名`
**请求**：`{ "pin": "1234" }`
**响应**：同 `verify`
**错误**：PIN 非 4 位 → 400；已设置过 → 409 `PIN already set, use change-pin`

### POST /api/user/change-pin

修改 PIN，需验证旧 PIN。

**请求头**：`X-User: 用户名`
**请求**：`{ "old_pin": "1234", "new_pin": "5678" }`
**响应**：`{ "success": true }`
**错误**：任一 PIN 非 4 位 → 400；未设置过 → 404；旧 PIN 不匹配 → 401 `Invalid current PIN`

### GET /api/user/me（需用户 JWT）

返回当前登录用户信息，客户端用它探测管理员身份以决定「后台设置」入口的显隐与路由守卫。

**响应**：`{ "username": "xrl", "is_admin": true | false }`

**错误**：缺失/无效 token → 401

### POST /api/user/refresh（需用户 JWT）

以仍有效的 token 换发全新的 14 天 token（滑动续期；客户端在剩余不足一半时调用）。服务器不记录 token 清单：旧 token 到其自身过期前依旧有效，刷新只是重新签发。

**响应**：`{ "token": "eyJ...", "expires_at": 1700086400 }`
**错误**：缺失/无效/已过期 token → 401

> 原端点 `POST /api/admin/auth`（密钥换管理员 JWT）已随 `ADMIN_KEY` 一并废除。

## 行为约束

1. 用户 PIN 明文与 `JWT_SECRET` **永不**通过任何 API 返回前端；`ADMIN` 名单也不下发（客户端只能通过 `/me` 得知**自己**是否管理员）
2. 管理员判定即 `env.ADMIN.includes(username)`，逐请求执行——停机改 `.env` 重启后立即生效（含撤销），不存在残留的管理员 token
3. PIN 校验一律 `^\d{4}$`，前后端一致
4. 受保护资源：`/api/chat/*`、`/api/conversations/*`、`/api/upload/*`、`/api/workspace/*` 需用户 JWT；`/api/admin/*` 需用户 JWT 且用户名在 `ADMIN` 名单内（401 未认证 / 403 非管理员）
5. 管理员端点的保护通过 `adminRoute.use('<path>', adminAuthMiddleware)` 按路径挂载
   - ⚠️ **Hono 的 `use('/stats', mw)` 只精确匹配 `/stats`，不覆盖 `/stats/conversations` 等子路径**；保护一组端点须同时挂载精确路径与 `/*` 通配（本项目 `skills/*`、`stats` + `stats/*` 均已如此）。这是曾经踩过的坑：`/stats/conversations` 一度完全未鉴权，匿名即可拖取全站对话
6. **认证 ≠ 授权**：JWT 只证明「是谁」，不证明「有权访问这条数据」。所有涉及具体资源的端点必须在 handler 内二次校验 `user_id` 归属（见 `chat.ts`、`conversations.ts` 的 `and(eq(id), eq(user_id, userId))` 查询），越权一律返回 404 而非 403（不泄露资源是否存在）
7. **401 自动驱逐**：前端 `lib/api.ts` 收到 401 时触发 `window.dispatchEvent(new CustomEvent('auth:expired'))`，`App.tsx` 监听该事件→清空 token→回到登录页。403（非管理员）不触发驱逐
8. **前端路由守卫**：`#/settings` 仅对 `/me` 返回 `is_admin: true` 的用户开放；其他用户（含未登录）访问该 hash 会被 `replaceState` 遣返首页。守卫只是体验层，真正的屏障是第 4 条的服务端鉴权
9. **续期不等于吊销**：`/refresh` 只换发新 token，旧 token 在其过期前依然有效（无服务端会话表）。需要强制全员下线时，更换 `JWT_SECRET` 或删除 `settings` 表的 `jwt_secret` 行后重启