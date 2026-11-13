/**
 * 限流器核心（lib/requestGate）单测
 *
 * 重点覆盖「规模上去才暴露」的几个性质：
 *   · 滑动窗口在边界处不放行突发（固定窗口的典型缺陷）
 *   · 多维度「任一超限即拒」
 *   · 0 / 非法阈值 = 不限制
 *   · 窗口滑出后自动恢复
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { checkAndRecord, resetGate } from '../src/lib/requestGate.js'

describe('requestGate', () => {
  beforeEach(() => {
    resetGate()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-13T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('放行到上限，超出一个即拒绝', () => {
    for (let i = 0; i < 3; i++) {
      expect(checkAndRecord('rest', ['u:a'], 3).allowed).toBe(true)
    }
    const blocked = checkAndRecord('rest', ['u:a'], 3)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThan(0)
  })

  it('滑动窗口：不因跨分钟边界而放行双倍突发', () => {
    // 12:00:30 起 30 秒内打满 3 次（都落在 12:00:30–12:00:50）
    vi.setSystemTime(new Date('2026-11-13T12:00:30Z'))
    for (let i = 0; i < 3; i++) {
      expect(checkAndRecord('rest', ['u:a'], 3).allowed).toBe(true)
      vi.advanceTimersByTime(10_000)
    }
    // 跨过整分钟边界（12:01:00）：固定窗口会在这里清零并再放行 3 次；
    // 滑动窗口下三条都还在 60 秒内（最早 12:00:30，窗口到 12:01:30），必须拒绝。
    vi.setSystemTime(new Date('2026-11-13T12:01:00Z'))
    expect(checkAndRecord('rest', ['u:a'], 3).allowed).toBe(false)
    expect(checkAndRecord('rest', ['u:a'], 3).allowed).toBe(false)

    // 首条在 12:00:30 → 12:01:30 滑出，此后恢复
    vi.setSystemTime(new Date('2026-11-13T12:01:31Z'))
    expect(checkAndRecord('rest', ['u:a'], 3).allowed).toBe(true)
  })

  it('多维度：任一超限即拒绝', () => {
    // 打满 u:a
    for (let i = 0; i < 2; i++) checkAndRecord('rest', ['u:a', 'ip:1.1.1.1'], 2)
    // 换一个全新 IP 但同一用户 → 仍被用户维度拦下
    expect(checkAndRecord('rest', ['u:a', 'ip:2.2.2.2'], 2).allowed).toBe(false)
    // 换一个全新用户但同一 IP → 被 IP 维度拦下
    expect(checkAndRecord('rest', ['u:b', 'ip:1.1.1.1'], 2).allowed).toBe(false)
    // 全新用户 + 全新 IP → 放行
    expect(checkAndRecord('rest', ['u:c', 'ip:3.3.3.3'], 2).allowed).toBe(true)
  })

  it('被拒绝的请求不计入窗口（不会越拒越久）', () => {
    for (let i = 0; i < 2; i++) checkAndRecord('rest', ['u:a'], 2)
    for (let i = 0; i < 5; i++) checkAndRecord('rest', ['u:a'], 2)
    const r = checkAndRecord('rest', ['u:a'], 2)
    expect(r.allowed).toBe(false)
    // 60 秒后必然恢复（若被拒请求也记账，这里会仍然被拒）
    vi.advanceTimersByTime(60_001)
    expect(checkAndRecord('rest', ['u:a'], 2).allowed).toBe(true)
  })

  it('两个分桶互相独立', () => {
    for (let i = 0; i < 2; i++) checkAndRecord('generate', ['u:a'], 2)
    expect(checkAndRecord('generate', ['u:a'], 2).allowed).toBe(false)
    // rest 桶不受影响
    expect(checkAndRecord('rest', ['u:a'], 2).allowed).toBe(true)
  })

  it('阈值 0 或非法 = 不限制', () => {
    for (let i = 0; i < 100; i++) {
      expect(checkAndRecord('rest', ['u:a'], 0).allowed).toBe(true)
    }
    expect(checkAndRecord('rest', ['u:a'], Number.NaN).allowed).toBe(true)
  })
})
