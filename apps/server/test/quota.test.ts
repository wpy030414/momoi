/**
 * 周额度口径单测（lib/quota 的纯函数部分）
 *
 * 库依赖（checkWeeklyQuota / recordUsage）需要真实 DB，这里只测最容易算错的
 * 口径函数：周窗口边界、μtoken 换算。周窗口是「自然周、周一 00:00、本地时区」。
 */

import { describe, it, expect } from 'vitest'
import {
  weekStartOf,
  nextWeekStartOf,
  mtokToMicro,
  tokensToMicro,
  MICRO_PER_MTok,
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
    it('1 MTok = 1e6 token = 1e12 μtoken', () => {
      expect(MICRO_PER_MTok).toBe(1_000_000)
      expect(tokensToMicro(1_000_000)).toBe(1_000_000 * MICRO_PER_MTok)
      // 1 MTok 的额度：mtokToMicro 给的是「多少个 token 的容量」
      expect(mtokToMicro(1)).toBe(1_000_000)
    })

    it('mtokToMicro：0 / 负数 / 非法 = 不限制', () => {
      expect(mtokToMicro(0)).toBe(0)
      expect(mtokToMicro(-5)).toBe(0)
      expect(mtokToMicro(Number.NaN)).toBe(0)
    })

    it('mtokToMicro：小数 MTok 四舍五入到整 token', () => {
      expect(mtokToMicro(0.5)).toBe(500_000)
      expect(mtokToMicro(1.0000004)).toBe(1_000_000)
    })

    it('tokensToMicro：非正数归零', () => {
      expect(tokensToMicro(0)).toBe(0)
      expect(tokensToMicro(-1)).toBe(0)
      expect(tokensToMicro(Number.POSITIVE_INFINITY)).toBe(0)
    })
  })
})
