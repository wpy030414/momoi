// ============================================================
// Weekly Quota — 周额度（μtoken 整数账本）
// ============================================================
//
// 口径（见 docs/DECISIONS.md D74）：
//   1 MTok = 1e6 token = 1 积分；内部一律用 μtoken 整数记账，永不丢精度。
//   token 数 × 1e6 = μtoken —— 因为上游 usage 已是整数 token，转 μtoken 不会有小数。
//   （保留 μ 的单位是为了与未来可能的亚 token 计量口径对齐；当下等价于 token。）
//
// 两层额度，**先到者拦截**：
//   · 个人额度 users.weekly_quota_mtok（NULL/0 = 不设）
//   · 实例总额度 settings.instance_weekly_quota_mtok（0 = 不设）
//   两者都不设 = 不限制（新装开箱即用不会被卡）。
//
// 周定义：自然周，周一 00:00（服务器本地时区）起算。weekStart 在写入时算好并落库，
// 读时直接按它聚合——时区配置变化不会让历史行错位。
//
// 拦截时机：**每次发起生成前**检查。生成过程中不掐断（用户已等到一半，掐断更糟），
// 消耗照常入账，下一次发起时被拦。
// ============================================================

import { db, usageLedger, users } from '../db/index.js'
import { eq, and, sql } from 'drizzle-orm'
import { getConfig } from './config.js'

/** 1 MTok = 1e6 token = 1 积分 */
export const MICRO_PER_MTok = 1_000_000

/** 计算某个时刻所属自然周的周一 00:00（本地时区）的 epoch 秒 */
export function weekStartOf(at: Date = new Date()): number {
  const d = new Date(at.getFullYear(), at.getMonth(), at.getDate())
  // getDay(): 0=周日, 1=周一 … 6=周六 → 回退到本周一
  const day = d.getDay()
  const back = day === 0 ? 6 : day - 1
  d.setDate(d.getDate() - back)
  return Math.floor(d.getTime() / 1000)
}

/** 下一个周一 00:00（本地时区）的 epoch 秒——额度重置时刻 */
export function nextWeekStartOf(at: Date = new Date()): number {
  const start = weekStartOf(at)
  const d = new Date(start * 1000)
  d.setDate(d.getDate() + 7)
  return Math.floor(d.getTime() / 1000)
}

/** MTok → μtoken（负数/非法视为不限制） */
export function mtokToMicro(mtok: number): number {
  if (!Number.isFinite(mtok) || mtok <= 0) return 0
  return Math.round(mtok * MICRO_PER_MTok)
}

/** token 数 → μtoken */
export function tokensToMicro(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  return Math.round(tokens * MICRO_PER_MTok)
}

// ---- 个人额度 ----

export async function getUserWeeklyQuotaMtok(username: string): Promise<number> {
  const row = await db.select({ q: users.weekly_quota_mtok })
    .from(users).where(eq(users.username, username)).get()
  return (row?.q as number | null | undefined) ?? 0
}

export async function setUserWeeklyQuotaMtok(username: string, mtok: number): Promise<void> {
  const v = Number.isFinite(mtok) && mtok > 0 ? Math.round(mtok) : null
  await db.update(users).set({ weekly_quota_mtok: v }).where(eq(users.username, username)).run()
}

// ---- 用量读取 ----

/** 某用户在某周已用 μtoken */
export async function getWeeklyUsedMicro(username: string, weekStart: number): Promise<number> {
  const row = await db.select({ total: sql<number>`COALESCE(SUM(${usageLedger.micro}), 0)` })
    .from(usageLedger)
    .where(and(eq(usageLedger.user_id, username), eq(usageLedger.week_start, weekStart)))
    .get()
  return Number(row?.total ?? 0)
}

/** 全实例在某周已用 μtoken（各用户之和） */
export async function getInstanceWeeklyUsedMicro(weekStart: number): Promise<number> {
  const row = await db.select({ total: sql<number>`COALESCE(SUM(${usageLedger.micro}), 0)` })
    .from(usageLedger).where(eq(usageLedger.week_start, weekStart)).get()
  return Number(row?.total ?? 0)
}

// ---- 记账 ----

/**
 * 记录一次生成的消耗。**失败开放**：账本写失败只打日志，绝不中断对话。
 *
 * @param username   消耗归属者；空串表示无法归属（计入实例总额度，不计个人额度）
 * @param billTokens 本次生成的账单口径 token 数
 * @param estimated  是否含估算
 */
export async function recordUsage(
  username: string,
  conversationId: string,
  billTokens: number,
  estimated: boolean,
): Promise<void> {
  const micro = tokensToMicro(billTokens)
  if (micro <= 0) return
  try {
    await db.insert(usageLedger).values({
      user_id: username || '',
      conversation_id: conversationId || '',
      micro,
      estimated: estimated ? 1 : 0,
      week_start: weekStartOf(),
      created_at: Math.floor(Date.now() / 1000),
    }).run()
  } catch (err) {
    console.error('[quota] Failed to record usage:', (err as Error).message)
  }
}

// ---- 检查 ----

export type QuotaScope = 'user' | 'instance'

export interface QuotaCheckResult {
  ok: boolean
  /** 拦截者：personal = 个人额度；instance = 实例总额度 */
  scope?: QuotaScope
  /** 下周额度重置时刻（epoch 秒） */
  resetAt?: number
}

/**
 * 检查某用户本周是否还有额度。两层额度先到者拦截；都不设 = 放行。
 * **失败开放**：查询异常时不拦人（账本坏了不该让全站停摆）。
 */
export async function checkWeeklyQuota(username: string): Promise<QuotaCheckResult> {
  try {
    const weekStart = weekStartOf()
    const resetAt = nextWeekStartOf()

    const [config, userQuotaMtok] = await Promise.all([
      getConfig(),
      username ? getUserWeeklyQuotaMtok(username) : Promise.resolve(0),
    ])

    // 个人额度
    const userLimit = mtokToMicro(userQuotaMtok)
    if (username && userLimit > 0) {
      const used = await getWeeklyUsedMicro(username, weekStart)
      if (used >= userLimit) return { ok: false, scope: 'user', resetAt }
    }

    // 实例总额度
    const instanceLimit = mtokToMicro(config.instance_weekly_quota_mtok)
    if (instanceLimit > 0) {
      const used = await getInstanceWeeklyUsedMicro(weekStart)
      if (used >= instanceLimit) return { ok: false, scope: 'instance', resetAt }
    }

    return { ok: true }
  } catch (err) {
    console.error('[quota] check failed, allowing request:', (err as Error).message)
    return { ok: true }
  }
}
