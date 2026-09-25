// ============================================================
// useWorld — 世界模拟的状态层
// ============================================================
// 组合 useGroupChat（后者又组合 useChat），而不是让 App 同时调两个聊天 hook。
//
// ⚠️ 命名纪律：本 hook 的返回值会被 `{ ...groupChat, ...世界成员 }` 合并，而
//    useGroupChat 已经做过一次 `{ ...chat, ...群聊成员 }`。同名成员会**静默覆盖**
//    内层实现（useGroupChat.ts 的文件注释里记录了这条真实踩过的坑：群聊版
//    forceComplianceRetryGroup 就是为避开同名覆盖才带 Group 后缀的）。
//    故这里一律用 world 前缀/后缀：worldState、worldAgents、worldLoading、
//    worldError、createWorld、saveWorldLaws —— 绝不用裸 world，绝不用 reload。

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useGroupChat } from './useGroupChat'
import type { WorldState, WorldStatus } from '@momoi/shared/types'

export interface WorldAgentBrief {
  id: string
  name: string
  avatar: string
}

/** 生成中轮询的间隔与上限：实时连接断开的设备靠它兜底 */
const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 30

/**
 * 模块级空数组：必须沿用同一个引用。
 * 若在返回值里写 `?? []`，每次渲染都会产出新数组 —— 它会顺着 props 传进
 * WorldCanvas / WorldFallback 并进入它们的 effect 依赖，导致每次父渲染都重建
 * 整个 three.js 场景。引用稳定的空数组让「没有成员」与「成员没变」无法区分，
 * 从而不触发多余重建。
 */
const NO_AGENTS: WorldAgentBrief[] = []

export function useWorldChat() {
  const groupChat = useGroupChat()
  const { activeId, isWorldMode, selectConversation, refreshConversations } = groupChat

  const [worldByConv, setWorldByConv] = useState<Record<string, WorldState>>({})
  const [worldAgentsByConv, setWorldAgentsByConv] = useState<Record<string, WorldAgentBrief[]>>({})
  const [worldLoading, setWorldLoading] = useState(false)
  const [worldError, setWorldError] = useState<string | null>(null)
  const [worldSavingLaws, setWorldSavingLaws] = useState(false)

  // ref 镜像：事件处理器需要读当前值而非闭包旧值（useChat 的既有惯例）
  const worldRef = useRef(worldByConv)
  worldRef.current = worldByConv
  // 世代计数：乱序响应不得覆盖用户已经切走后的视图
  const worldGenRef = useRef(0)

  const loadWorld = useCallback(async (convId: string) => {
    const gen = ++worldGenRef.current
    setWorldLoading(true)
    setWorldError(null)
    try {
      const res = await api.getWorld(convId)
      if (worldGenRef.current !== gen) return
      setWorldByConv((prev) => ({ ...prev, [convId]: res.world }))
      setWorldAgentsByConv((prev) => ({ ...prev, [convId]: res.agents }))
    } catch (err) {
      if (worldGenRef.current !== gen) return
      setWorldError((err as Error).message)
    } finally {
      if (worldGenRef.current === gen) setWorldLoading(false)
    }
  }, [])

  // 切到世界会话时取状态。已有 ready 缓存则直接用，避免切换会话来回闪。
  useEffect(() => {
    if (!activeId || !isWorldMode) {
      worldGenRef.current++ // 作废在途响应
      setWorldLoading(false)
      setWorldError(null)
      return
    }
    const cached = worldRef.current[activeId]
    if (cached?.status === 'ready') {
      setWorldError(null)
      return
    }
    void loadWorld(activeId)
    // refreshConversations 仅用于让本设备的侧边栏立刻出现新世界（广播在其它设备生效）
  }, [activeId, isWorldMode, loadWorld])

  // 实时：地形生成状态变更
  useEffect(() => {
    const onStatus = (e: Event) => {
      const detail = (e as CustomEvent).detail as
        | { conversation_id?: string; status?: WorldStatus }
        | undefined
      const convId = detail?.conversation_id
      if (!convId) return

      if (convId !== activeId) {
        // 非当前会话：丢弃缓存，下次打开时重拉（避免为一个没在看的世界拉数 KB 的 spec）
        setWorldByConv((prev) => {
          if (!(convId in prev)) return prev
          const next = { ...prev }
          delete next[convId]
          return next
        })
        return
      }
      if (detail?.status === 'ready' || detail?.status === 'failed') {
        // 转入终态：重拉以取回 terrain_spec（事件只带状态，不带 spec）
        void loadWorld(convId)
      } else if (detail?.status) {
        setWorldByConv((prev) =>
          prev[convId] ? { ...prev, [convId]: { ...prev[convId], status: detail.status! } } : prev,
        )
      }
    }
    window.addEventListener('realtime:world_status', onStatus)
    return () => window.removeEventListener('realtime:world_status', onStatus)
  }, [activeId, loadWorld])

  // 生成中轮询：实时连接掉线的设备的兜底，也天然覆盖「面板打开时生成早已完成」
  const activeStatus = activeId ? worldByConv[activeId]?.status : undefined
  useEffect(() => {
    if (!activeId || !isWorldMode || activeStatus !== 'generating') return
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      if (attempts > POLL_MAX_ATTEMPTS) {
        clearInterval(timer)
        return
      }
      void loadWorld(activeId)
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [activeId, isWorldMode, activeStatus, loadWorld])

  /**
   * 创生世界。**不走「新会话草稿态」**（D34）—— 世界创生时立即落库并生成地形，
   * 因为地形必须在渲染沙盘之前存在，而地形规则是不可变的、不能等到首条消息才定。
   * 代价是确认后放弃会留下一个真实的世界，这在 D48 里作为对 D34 的显式例外记录。
   */
  const createWorld = useCallback(
    async (agentIds: string[], prompt: string): Promise<string> => {
      const res = await api.createWorld(prompt, agentIds)
      setWorldByConv((prev) => ({ ...prev, [res.conversation.id]: res.world }))
      refreshConversations()
      await selectConversation(res.conversation.id)
      return res.conversation.id
    },
    [refreshConversations, selectConversation],
  )

  const saveWorldLaws = useCallback(
    async (laws: string) => {
      if (!activeId) return
      setWorldSavingLaws(true)
      try {
        const res = await api.updateWorldLaws(activeId, laws)
        setWorldByConv((prev) => ({ ...prev, [activeId]: res.world }))
      } finally {
        setWorldSavingLaws(false)
      }
    },
    [activeId],
  )

  return {
    ...groupChat,
    // isWorldMode 由 useGroupChat 提供（与 isGroupMode 在完全相同的三处赋值点同步）
    worldState: activeId ? worldByConv[activeId] ?? null : null,
    worldAgents: activeId ? worldAgentsByConv[activeId] ?? NO_AGENTS : NO_AGENTS,
    worldLoading,
    worldError,
    worldSavingLaws,
    createWorld,
    saveWorldLaws,
  }
}
