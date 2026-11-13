// ============================================================
// Weekly Quota — 周额度（积分账本）
// ============================================================
//
// 口径（见 docs/DECISIONS.md D77）：
//   **1 MTok = 1 积分**。账本只记积分，不引入 token 这层中间单位。
//
//   存储用「微积分」整数：1 积分 = 1e6 微积分（micro_credits）。
//   理由只有一个——token 是整数，1e6 token = 1 积分，所以积分最多需要 6 位小数；
//   用 1e-6 积分作最小单位既能精确表达任意 token 数，又永远是整数（不丢精度）。
//   展示时除以 1e6 得到积分。
//
//   换算只有一条：
//     micro_credits = round(token 数 / 1e6 × 1e6) = token 数
//   即 **1 token 恰好等于 1 微积分**——因为 1 MTok = 1e6 token = 1 积分 = 1e6 微积分。
//   这个巧合让记账可以直接存 token 数，展示时才 ÷ 1e6。
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
import type { MyQuotaInfo } from '@momoi/shared/types'

/** 1 积分 = 1e6 微积分（账本存储单位）；也等于 1 MTok 的 token 数 */
export const MICRO_CREDITS_PER_CREDIT = 1_000_000

/** 1 MTok = 1 积分 */
export const CREDITS_PER_MTOK = 1

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

// ---- 换算（唯一入口，避免单位散落各处）----

/** MTok（= 积分）额度 → 微积分。负数/非法视为不限制（0）。 */
export function mtokToMicroCredits(mtok: number): number {
  if (!Number.isFinite(mtok) || mtok <= 0) return 0
  return Math.round(mtok * CREDITS_PER_MTOK * MICRO_CREDITS_PER_CREDIT)
}

/** token 数 → 微积分。因为 1 token = 1 微积分（1e6 token = 1 积分），恒等返回。 */
export function tokensToMicroCredits(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0
  return Math.round(tokens)
}

/** 微积分 → 积分（保留 2 位小数，展示用） */
export function microCreditsToCredits(micro: number): number {
  return Math.round((micro / MICRO_CREDITS_PER_CREDIT) * 100) / 100
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

/**
 * 新账号创建时的默认周额度（MTok → 存储值）。
 * 后台「用户」页可配置；0 / 未配置 = 不限制（返回 null，与「不设额度」同义）。
 * **只影响此后新建的账号**，不追溯已有用户。
 */
export async function getDefaultNewUserQuota(): Promise<number | null> {
  try {
    const config = await getConfig()
    const mtok = config.default_new_user_quota_mtok
    return Number.isFinite(mtok) && mtok > 0 ? Math.round(mtok) : null
  } catch {
    // 配置读失败按「不限制」处理——新用户注册不该被配置异常挡住
    return null
  }
}

// ---- 用量读取 ----

/** 某用户在某周已用（微积分） */
export async function getWeeklyUsedMicro(username: string, weekStart: number): Promise<number> {
  const row = await db.select({ total: sql<number>`COALESCE(SUM(${usageLedger.micro_credits}), 0)` })
    .from(usageLedger)
    .where(and(eq(usageLedger.user_id, username), eq(usageLedger.week_start, weekStart)))
    .get()
  return Number(row?.total ?? 0)
}

/** 全实例在某周已用（微积分，各用户之和） */
export async function getInstanceWeeklyUsedMicro(weekStart: number): Promise<number> {
  const row = await db.select({ total: sql<number>`COALESCE(SUM(${usageLedger.micro_credits}), 0)` })
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
  const micro = tokensToMicroCredits(billTokens)
  if (micro <= 0) return
  try {
    await db.insert(usageLedger).values({
      user_id: username || '',
      conversation_id: conversationId || '',
      micro_credits: micro,
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
    const userLimit = mtokToMicroCredits(userQuotaMtok)
    if (username && userLimit > 0) {
      const used = await getWeeklyUsedMicro(username, weekStart)
      if (used >= userLimit) return { ok: false, scope: 'user', resetAt }
    }

    // 实例总额度
    const instanceLimit = mtokToMicroCredits(config.instance_weekly_quota_mtok)
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

/**
 * 取当前用户的积分余额（所有者自查，用于侧栏用户菜单）。
 *
 * 两层额度取**更紧的那一个**作为对外的「余额」：个人额度与实例总额度先到者拦截，
 * 所以用户真正还能用多少 = min(个人剩余, 实例剩余)。任一未设则取另一个；
 * 两者都未设 → `limit_credits = null`（前端显示 ∞）。
 *
 * 失败开放：查询异常时返回「不限制」，不阻塞用户菜单渲染。
 */
export async function getMyQuota(username: string): Promise<MyQuotaInfo> {
  const weekStart = weekStartOf()
  const resetAt = nextWeekStartOf()
  try {
    const [config, userQuotaMtok] = await Promise.all([
      getConfig(),
      username ? getUserWeeklyQuotaMtok(username) : Promise.resolve(0),
    ])

    const usedMicro = username ? await getWeeklyUsedMicro(username, weekStart) : 0

    // 个人额度（微积分容量）。剩余可为负（超额），保留原值供取 min 比较。
    const personalLimit = mtokToMicroCredits(userQuotaMtok)
    const personalRemaining = personalLimit > 0 ? personalLimit - usedMicro : null

    // 实例额度：全实例已用 vs 实例上限
    let instanceRemaining: number | null = null
    const instanceLimit = mtokToMicroCredits(config.instance_weekly_quota_mtok)
    if (instanceLimit > 0) {
      const instanceUsed = await getInstanceWeeklyUsedMicro(weekStart)
      instanceRemaining = instanceLimit - instanceUsed
    }

    // 取更紧的那一个。上限统一表示为「本人已用 + 剩余」——对使用者可见的分母
    // 永远是他自己的口径，不会因为别人花得多而突然变小到看不懂。
    let remaining: number | null
    if (personalRemaining !== null && instanceRemaining !== null) {
      remaining = Math.min(personalRemaining, instanceRemaining)
    } else if (personalRemaining !== null) {
      remaining = personalRemaining
    } else if (instanceRemaining !== null) {
      remaining = instanceRemaining
    } else {
      remaining = null
    }

    const limit = remaining === null ? null : usedMicro + Math.max(0, remaining)

    return {
      used_credits: microCreditsToCredits(usedMicro),
      limit_credits: limit === null ? null : microCreditsToCredits(limit),
      remaining_credits: remaining === null ? null : microCreditsToCredits(Math.max(0, remaining)),
      reset_at: resetAt,
    }
  } catch (err) {
    console.error('[quota] getMyQuota failed:', (err as Error).message)
    return { used_credits: 0, limit_credits: null, remaining_credits: null, reset_at: resetAt }
  }
}