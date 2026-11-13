/**
 * 周额度口径单测（lib/quota 的纯函数部分）
 *
 * 库依赖（checkWeeklyQuota / recordUsage）需要真实 DB，这里只测最容易算错的
 * 口径函数：周窗口边界、积分与微积分的换算。
 *
 * 口径：**1 MTok = 1 积分**；存储单位为微积分（1 积分 = 1e6 微积分）。
 * 因为 1 MTok = 1e6 token，所以 token 数与微积分数值相等——这条恒等关系
 * 是记账能直接存 token 数的依据，必须锁住。
 */

import { describe, it, expect } from 'vitest'
import {
  weekStartOf,
  nextWeekStartOf,
  mtokToMicroCredits,
  tokensToMicroCredits,
  microCreditsToCredits,
  MICRO_CREDITS_PER_CREDIT,
  CREDITS_PER_MTOK,
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

  describe('换算', () => {
    it('0 是「不限制」的哨兵值', () => {
      expect(mtokToMicroCredits(0)).toBe(0)
      expect(tokensToMicroCredits(0)).toBe(0)
    })

    it('1 MTok = 1 积分 = 1e6 微积分', () => {
      expect(CREDITS_PER_MTOK).toBe(1)
      expect(MICRO_CREDITS_PER_CREDIT).toBe(1_000_000)
      expect(mtokToMicroCredits(1)).toBe(1_000_000)
    })

    it('token 数与微积分数值相等（1e6 token = 1 积分）', () => {
      expect(tokensToMicroCredits(1_000_000)).toBe(1_000_000)
      expect(tokensToMicroCredits(1)).toBe(1)
    })

    it('额度与用量同单位：10 积分额度可容纳 1000 万 token', () => {
      const limit = mtokToMicroCredits(10)      // 10 MTok = 10 积分
      const used = tokensToMicroCredits(10e6)   // 1000 万 token
      expect(used).toBe(limit)
    })

    it('小数 MTok 向下取整到微积分', () => {
      expect(mtokToMicroCredits(0.5)).toBe(500_000)
      expect(mtokToMicroCredits(1.0000004)).toBe(1_000_000)
    })

    it('负数/非法 MTok 视为不限制', () => {
      expect(mtokToMicroCredits(-5)).toBe(0)
      expect(mtokToMicroCredits(Number.NaN)).toBe(0)
      expect(tokensToMicroCredits(-1)).toBe(0)
      expect(tokensToMicroCredits(Number.POSITIVE_INFINITY)).toBe(0)
    })

    it('微积分 → 积分：保留 2 位', () => {
      expect(microCreditsToCredits(1_000_000)).toBe(1)
      expect(microCreditsToCredits(1_234_567)).toBe(1.23)
      expect(microCreditsToCredits(0)).toBe(0)
    })
  })
})