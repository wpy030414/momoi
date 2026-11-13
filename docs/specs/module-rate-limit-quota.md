# 模块：限流与配额

## 职责

回答两个问题：**单用户能发多快**（限流），以及**一个组织本周能花多少**（配额）。
两者都是附加保护层，坏了不能让主链路停摆——所有失败路径一律**失败开放**。

详细论证见 `docs/DECISIONS.md` D76（单实例约束）、D77（分桶限流与积分账本）。

## 限流

### 分桶

| 桶 | 覆盖 | 默认阈值 | 配置项 |
|---|---|---|---|
| 生成桶 | `POST /api/chat`（含群聊 / 世界 / 无限模式追轮） | 10 / min | `rate_limit_generate_per_min` |
| 普通桶 | 其余 `/api/*` | 120 / min | `rate_limit_rest_per_min` |
| 不计 | `/api/events` 长连接、`OPTIONS` 预检 | — | — |

总开关 `rate_limit_enabled`（默认 `true`）。任一阈值填 `0` 表示该档不限制。

### 算法

**滑动窗口**（记录时间戳队列，滑出 60 秒即释放）。不用固定窗口——固定窗口在整分钟边界会放行双倍突发。

被拒绝的请求**不记账**，因此不会「越拒越久」。

### 维度

`userId` + `IP` 双维度，**命中任一即拒绝**：

- 按 `userId`：同一 NAT 下多人不互相拖累
- 按 `IP`：限制未登录 / 共享账号在单机上的爆破

普通桶的 `userId` 要等下游 `userAuthMiddleware` 执行完才有，因此**入口记 IP、出口补记 userId**。
补记只记账、不判拒绝——请求已经执行完。这样避免了重复验签和重复查封禁状态。

### 拒绝形态

`429` + `{ code: 'RATE_LIMIT_EXCEEDED', params: { retry_after } }`，`retry_after` 为建议重试秒数
（窗口内最早一条滑出所需时间）。

## 配额

### 计量单位

**1 MTok = 1e6 token = 1 积分**。

账本**只存 token 数**（`usage_ledger.tokens INTEGER`），**不存积分**。
积分是**纯派生量**：每次读取时由 `SUM(tokens) / 1e6` 实时算出。

| 单位 | 换算 |
|---|---|
| 1 积分 | `1e6` token |
| 1 MTok | `1` 积分 |
| 1 token | `1e-6` 积分 |

额度上限以 MTok（= 积分）配置，比较时乘成 token 再比——只做单向换算，
不在中间落任何积分值。

**这样做的好处**：积分永远不会与原始数据脱节。不存在「记账时攒下的误差」，
改换算规则也不需要迁移历史数据。

### 显示精度

所有展示积分的地方**一律固定 2 位小数**（`toFixed(2)`）：`1.50`、`3.77`、`0.03`、`0.00`。
服务端返回值同样是 2 位精度，前端再 `toFixed(2)` 补齐（JS 会把 `5.00` 序列化成 `5`）。
无限额度显示 `∞`。

### 两层额度

| 层级 | 存储 | 设定位置 |
|---|---|---|
| 个人 | `users.weekly_quota_mtok` | 后台「用户」页，行内编辑 |
| 实例总额度 | `settings.instance_weekly_quota_mtok` | 后台「网关」页 |

**先到者拦截**。两层都不设 = 不限制（新装开箱即用不会被卡住）。

### 周窗口

自然周，周一 00:00（**服务器本地时区**）。

`usage_ledger.week_start` 在**写入时**算好落库，读取时直接按它聚合。这样时区配置变化
不会让历史行错位，跨年也不需要额外处理。

### 记账

**纯追加**：每次生成向 `usage_ledger` 插入一行，无 RMW 竞态。

落点在 `lib/stats-store.ts#persistConversationStats`——网页 / QQ / 微信三条渠道的**唯一汇聚点**
（见 D52），因此记账与状态条同口径，不会漏渠道。

失败开放：账本写失败只打日志，绝不中断对话。

### 拦截时机

**生成前拦截，生成中不掐断。**

超额的当前轮照常跑完并计费，下一次发起时才被拦下。中途掐断会让用户拿到半截回复，
比「这一轮先让我说完，下一轮再拦」糟糕得多。

### 拒绝形态

`429` + `{ code: 'QUOTA_EXCEEDED', params: { scope, reset_at } }`。

- `scope`：`'personal' | 'instance'`，由前端 `errT` 通过 `quotaScope.*` 翻译
- `reset_at`：下周一零点的 epoch 秒，由**前端**按用户本地时区格式化
  （服务端时区可能与用户不同，后端 `toLocaleString()` 会给出错误时间）

## 成本看板

`GET /api/admin/stats/cost?days=7`，返回 `AdminCostBoard`：

```ts
{
  days: number
  total_tokens: number
  by_user: Array<{ username: string; tokens: number }>
  by_day:  Array<{ date: string; tokens: number }>   // date = 'YYYY-MM-DD'（本地时区）
}
```

按天分桶在 JS 侧用**本地时区**完成，与周额度同一口径，不在 SQL 里硬编码时区偏移。

UI 位置：后台「审查」Tab 顶部。

## 单实例约束

限流窗口、IM 锁、事件总线、配置缓存等共享状态**全部在进程内存**。
本项目**只支持单实例部署**，详见 D76 与 `lib/process-state.ts`。

`warnIfMultiInstanceSuspected()` 在启动时检测 `NODE_APP_INSTANCE` / `PM2_INSTANCE_ID` / `PM_ID`，
命中则打显式告警（不强制退出——自托管场景下误伤比放过更糟）。

## 验收

- 阈值 3 时连发 6 次 → 前 3 次通过、后 3 次 `429`
- 跨整分钟边界不打满新窗口（滑动窗口性质）
- 同一用户换 IP、同一 IP 换用户，均按各自维度受限
- 两个桶互相独立
- `/api/events` 不被计数
- 额度 1 MTok、已用 2 MTok → 发起聊天返回 `QUOTA_EXCEEDED`
- 额度清空 → 正常进入生成流程
- `reset_at` 换算回本地时间为下周一 00:00
- 1,234,567 token 显示为 1.23 积分（四舍五入到 2 位）
- 积分随 token 数实时变化，不读取任何积分存储列