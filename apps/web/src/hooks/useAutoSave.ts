// ============================================================
// useAutoSave — 后台设置的「改完即存」
// ============================================================
//
// 后台「网关」「体验」两页不再有显式保存按钮，而是改动后自动提交。
// 但直接「onChange 就发请求」会被打爆（每击键一次），所以按**字段类型**区分时机：
//
//   · 即时（immediate）：开关、下拉——一次操作就是一个完整意图，立刻存
//   · 失焦（blur）     ：单行文本、数字输入——离开字段时才是一次完整的编辑
//   · 合并（group）    ：列表类（推荐问题 / 常问问题）——多项一起改，
//                        统一在一次失焦后提交，且只在通过校验时才提交
//
// 目标：既做到「改完就存」，又不会在输入中途发请求或弹校验错误。
//
// 并发：同一时刻只允许一个请求在飞；若有新改动在飞行期间到来，等它落地后
// 再发一次（last-write-wins，不会丢最后一次编辑）。
// ============================================================

import { useCallback, useRef, useState } from 'react'

export interface AutoSaveOptions {
  /** 真正提交的函数（通常包一层 api.updateConfig） */
  save: () => Promise<void>
  /** 提交成功回调（如刷新本地 config） */
  onSaved?: () => void
  /** 提交失败回调（API 层已 toast；这里只用于回滚本地状态等） */
  onError?: (err: unknown) => void
}

export interface AutoSaveHandle {
  /** 立即提交（开关 / 下拉用） */
  saveNow: () => void
  /** 延迟提交：失焦时调用；内部做去抖，避免同一次操作触发多次 */
  saveSoon: () => void
  /** 是否有请求在飞 */
  saving: boolean
  /** 是否有尚未提交的改动 */
  dirty: boolean
  /** 标记有未提交改动（不再由调用方手动调 save，而是靠 saveSoon/saveNow 落地） */
  markDirty: () => void
}

export function useAutoSave({ save, onSaved, onError }: AutoSaveOptions): AutoSaveHandle {
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  // 用 ref 保存最新函数，避免调用方每次渲染重建导致 hook 内部闭包过期
  const saveRef = useRef(save)
  saveRef.current = save
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  /** 飞行中标志 + 飞行期间又来了改动（落地后补发一次） */
  const inFlightRef = useRef(false)
  const pendingRef = useRef(false)
  /** 去抖计时器：同一次失焦操作可能触发多次，合并成一次请求 */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(async () => {
    if (inFlightRef.current) {
      // 已有请求在飞：记下待提交，落地后再发
      pendingRef.current = true
      return
    }
    inFlightRef.current = true
    pendingRef.current = false
    setSaving(true)
    try {
      await saveRef.current()
      setDirty(false)
      onSavedRef.current?.()
    } catch (err) {
      // API 层通常已经 toast 过；这里只把错误交给调用方做本地回滚
      onErrorRef.current?.(err)
    } finally {
      inFlightRef.current = false
      setSaving(false)
      // 飞行期间有新改动 → 补发一次
      if (pendingRef.current) {
        pendingRef.current = false
        void flush()
      }
    }
  }, [])

  const saveNow = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setDirty(true)
    void flush()
  }, [flush])

  const saveSoon = useCallback(() => {
    setDirty(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    // 120ms 去抖：同一次编辑里多个事件（change + blur）合并成一次提交
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      void flush()
    }, 120)
  }, [flush])

  const markDirty = useCallback(() => setDirty(true), [])

  return { saveNow, saveSoon, saving, dirty, markDirty }
}