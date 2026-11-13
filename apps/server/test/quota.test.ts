/**
 * 周额度口径单测（lib/quota 的纯函数部分）
 *
 * 库依赖（checkWeeklyQuota / recordUsage）需要真实 DB，这里只测最容易算错的
 * 口径函数：周窗口边界、token ↔ 积分换算。
 *
 * 口径：**1 MTok = 1e6 token = 1 积分**。
 * 账本只存 token 数，积分是**派生量**（读取时实时算），不落库。
 */

import { describe, it, expect } from 'vitest'
import {
  weekStartOf,
  nextWeekStartOf,
  mtokToTokens,
  tokensToCredits,
  tokensToCreditsFixed,
  TOKENS_PER_CREDIT,
} from '../src/lib/quota.js'

describe('quota 口径', () => {
  describe('weekStartOf', () => {
    // 用本地时间构造，避免测试机时区影响断言
    const local = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h, 0, 0)

    it('周五 → 本周一 00:00', () => {
      // 2026-11-13 是周五
      const start = weekStartOf(local(2026, 11, 13))
      const d = new Date(start * 1000)
      expect(d.getDay()).toBe(1) // 周一
      expect(d.getHours()).toBe(0)
      expect(d.getMinutes()).toBe(0)
      expect([d.getMonth() + 1, d.getDate()]).toEqual([11, 9])
    })

    it('周一当天 → 仍是当天 00:00', () => {
      const start = weekStartOf(local(2026, 11, 9))
      const d = new Date(start * 1000)
      expect([d.getMonth() + 1, d.getDate()]).toEqual([11, 9])
    })

    it('周日 → 回退到同一周的周一（不是下一个周一）', () => {
      // 2026-11-15 是周日
      const start = weekStartOf(local(2026, 11, 15))
      const d = new Date(start * 1000)
      expect([d.getMonth() + 1, d.getDate()]).toEqual([11, 9])
      expect(d.getDay()).toBe(1)
    })

    it('跨月/跨年正确', () => {
      // 2026-01-01 是周四
      const start = weekStartOf(local(2026, 1, 1))
      const d = new Date(start * 1000)
      expect(d.getFullYear()).toBe(2025)
      expect([d.getMonth() + 1, d.getDate()]).toEqual([12, 29])
    })
  })

  describe('nextWeekStartOf', () => {
    it('恰好是当前周的起点 + 7 天', () => {
      const at = new Date(2026, 10, 13, 15, 0, 0)
      expect(nextWeekStartOf(at) - weekStartOf(at)).toBe(7 * 86400)
    })
  })

  describe('换算（token 为唯一真实单位，积分是派生量）', () => {
    it('1 积分 = 1 MTok = 1e6 token', () => {
      expect(TOKENS_PER_CREDIT).toBe(1_000_000)
      expect(mtokToTokens(1)).toBe(1_000_000)
      expect(tokensToCredits(1_000_000)).toBe(1)
    })

    it('额度与用量同单位：10 积分额度 = 1000 万 token', () => {
      expect(mtokToTokens(10)).toBe(10e6)
      // 用满 1000 万 token 时已用积分恰好到 10
      expect(tokensToCredits(10e6)).toBe(10)
    })

    it('mtokToTokens：0 / 负数 / 非法 = 不限制', () => {
      expect(mtokToTokens(0)).toBe(0)
      expect(mtokToTokens(-5)).toBe(0)
      expect(mtokToTokens(Number.NaN)).toBe(0)
    })

    it('tokensToCredits：非正数归零', () => {
      expect(tokensToCredits(0)).toBe(0)
      expect(tokensToCredits(-1)).toBe(0)
      expect(tokensToCredits(Number.POSITIVE_INFINITY)).toBe(0)
    })

    it('显示固定 2 位小数（四舍五入）', () => {
      expect(tokensToCreditsFixed(1_000_000)).toBe(1)
      expect(tokensToCreditsFixed(1_234_567)).toBe(1.23)
      expect(tokensToCreditsFixed(1_235_000)).toBe(1.24)
      expect(tokensToCreditsFixed(30_000)).toBe(0.03)
      expect(tokensToCreditsFixed(0)).toBe(0)
    })

    it('小额用量不会被吞掉（这正是「实时推算」要保住的东西）', () => {
      // 150 万 token = 1.5 积分
      expect(tokensToCreditsFixed(1_500_000)).toBe(1.5)
      // 单次几百 token 的零头也要保留到百分位
      expect(tokensToCreditsFixed(5_000)).toBe(0.01)
    })
  })
})