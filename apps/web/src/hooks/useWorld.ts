// ============================================================
// useWorld — 世界模拟的状态层
// ============================================================
// 组合 useGroupChat（后者又组合 useChat），而不是让 App 同时调两个聊天 hook。
//
// ⚠️ 命名纪律：本 hook 的返回值会被 `{ ...groupChat, ...世界成员 }` 合并，而
//    useGroupChat 已经做过一次 `{ ...chat, ...群聊成员 }`。同名成员会**静默覆盖**
//    内层实现（useGroupChat.ts 的文件注释里记录了这条真实踩过的坑：群聊版
//    forceComplianceRetryGroup 就是为避开同名覆盖才带 Group 后缀的）。
//    故这里一律用 world 前缀：worldState、worldEntities、worldEvents、actWorld ……，
//    绝不用裸 world，绝不用 reload。

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../lib/api'
import { useGroupChat } from './useGroupChat'
import type { ServerMessage, WorldEntity, WorldEvent, WorldState, WorldStatus } from '@momoi/shared/types'

export interface WorldAgentBrief {
  id: string
  name: string
  avatar: string
}

/** 一个会话的世界运行时（把五个并行字典收成一个，避免状态散落） */
interface WorldRuntime {
  state: WorldState | null
  entities: WorldEntity[]
  events: WorldEvent[]
  agents: WorldAgentBrief[]
  loading: boolean
  error: string | null
  /** 有回合在跑（禁用输入） */
  acting: boolean
  /** 当前正在行动的实体名 —— 回合进行中给用户看的进度 */
  actingName: string | null
}

const EMPTY_RUNTIME: WorldRuntime = {
  state: null,
  entities: [],
  events: [],
  agents: [],
  loading: false,
  error: null,
  acting: false,
  actingName: null,
}

/** 生成中轮询的间隔与上限：实时连接断开的设备靠它兜底 */
const POLL_INTERVAL_MS = 2000
const POLL_MAX_ATTEMPTS = 30

export function useWorldChat() {
  const groupChat = useGroupChat()
  const { activeId, isWorldMode, selectConversation, refreshConversations } = groupChat
  const { i18n } = useTranslation()

  const [worldByConv, setWorldByConv] = useState<Record<string, WorldRuntime>>({})
  const [worldSavingLaws, setWorldSavingLaws] = useState(false)

  // ref 镜像：事件处理器需要读当前值而非闭包旧值（useChat 的既有惯例）
  const worldRef = useRef(worldByConv)
  worldRef.current = worldByConv
  // 世代计数：乱序响应不得覆盖用户已经切走后的视图
  const worldGenRef = useRef(0)

  const patch = useCallback((convId: string, next: Partial<WorldRuntime>) => {
    setWorldByConv((prev) => ({ ...prev, [convId]: { ...(prev[convId] ?? EMPTY_RUNTIME), ...next } }))
  }, [])

  const loadWorld = useCallback(async (convId: string) => {
    const gen = ++worldGenRef.current
    setWorldByConv((prev) => ({ ...prev, [convId]: { ...(prev[convId] ?? EMPTY_RUNTIME), loading: true, error: null } }))
    try {
      const res = await api.getWorld(convId)
      if (worldGenRef.current !== gen) return
      setWorldByConv((prev) => ({
        ...prev,
        [convId]: {
          ...(prev[convId] ?? EMPTY_RUNTIME),
          state: res.world,
          entities: res.entities ?? [],
          events: res.events ?? [],
          agents: res.agents ?? [],
          loading: false,
          error: null,
        },
      }))
    } catch (err) {
      if (worldGenRef.current !== gen) return
      patch(convId, { loading: false, error: (err as Error).message })
    }
  }, [patch])

  /** 应用一条世界消息（本地 SSE 流与实时中继共用；按事件 id 去重） */
  const applyWorldMessage = useCallback((convId: string, msg: ServerMessage) => {
    switch (msg.type) {
      case 'world_turn_start':
        patch(convId, { entities: msg.entities, acting: true, actingName: null })
        break
      case 'world_agent_start':
        patch(convId, { acting: true, actingName: msg.name })
        break
      case 'world_agent_done':
        patch(convId, { actingName: null })
        break
      case 'world_event':
        setWorldByConv((prev) => {
          const rt = prev[convId] ?? EMPTY_RUNTIME
          // ⚠️ 去重：broadcastWorldEvent 不跳过来源设备，故触发本次回合的设备会
          //    既从本地 SSE 流收到、又从实时通道收到同一条事件
          if (rt.events.some((e) => e.id === msg.event.id)) return prev
          return { ...prev, [convId]: { ...rt, events: [...rt.events, msg.event] } }
        })
        break
      case 'world_turn_end':
        patch(convId, { acting: false, actingName: null })
        break
      case 'error':
        patch(convId, { acting: false, actingName: null, error: msg.message })
        break
    }
  }, [patch])

  // 切到世界会话时取状态。已有 ready 缓存则直接用，避免切换会话来回闪。
  useEffect(() => {
    if (!activeId || !isWorldMode) {
      worldGenRef.current++ // 作废在途响应
      return
    }
    if (worldRef.current[activeId]?.state?.status === 'ready') return
    void loadWorld(activeId)
  }, [activeId, isWorldMode, loadWorld])

  // 实时：地形生成状态 + 回合生命周期 + 单条事件
  useEffect(() => {
    const onStatus = (e: Event) => {
      const d = (e as CustomEvent).detail as { conversation_id?: string; status?: WorldStatus } | undefined
      if (!d?.conversation_id) return
      if (d.conversation_id !== activeId) {
        // 非当前会话：丢弃缓存，下次打开时重拉（避免为没在看的世界拉数 KB 的 spec）
        setWorldByConv((prev) => {
          if (!(d.conversation_id! in prev)) return prev
          const next = { ...prev }
          delete next[d.conversation_id!]
          return next
        })
        return
      }
      if (d.status === 'ready' || d.status === 'failed') {
        void loadWorld(d.conversation_id) // 转入终态：重拉以取回 terrain_spec
      } else if (d.status) {
        setWorldByConv((prev) => {
          const rt = prev[d.conversation_id!]
          return rt ? { ...prev, [d.conversation_id!]: { ...rt, state: rt.state ? { ...rt.state, status: d.status! } : null } } : prev
        })
      }
    }
    const onTurn = (e: Event) => {
      const d = (e as CustomEvent).detail as { conversation_id?: string; running?: boolean } | undefined
      if (!d?.conversation_id || d.conversation_id !== activeId) return
      patch(d.conversation_id, { acting: d.running === true })
    }
    const onEvent = (e: Event) => {
      const d = (e as CustomEvent).detail as { conversation_id?: string; event?: WorldEvent } | undefined
      if (!d?.conversation_id || !d.event) return
      // 事件本身可跨会话累积（切回去就能看到），但只为当前会话实时渲染
      if (d.conversation_id !== activeId) return
      applyWorldMessage(d.conversation_id, { type: 'world_event', event: d.event })
    }
    window.addEventListener('realtime:world_status', onStatus)
    window.addEventListener('realtime:world_turn', onTurn)
    window.addEventListener('realtime:world_event', onEvent)
    return () => {
      window.removeEventListener('realtime:world_status', onStatus)
      window.removeEventListener('realtime:world_turn', onTurn)
      window.removeEventListener('realtime:world_event', onEvent)
    }
  }, [activeId, loadWorld, patch, applyWorldMessage])

  // 生成中轮询：实时连接掉线的设备的兜底，也天然覆盖「面板打开时生成早已完成」
  const activeStatus = activeId ? worldByConv[activeId]?.state?.status : undefined
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
      setWorldByConv((prev) => ({
        ...prev,
        [res.conversation.id]: { ...EMPTY_RUNTIME, state: res.world },
      }))
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
        setWorldByConv((prev) => {
          const rt = prev[activeId] ?? EMPTY_RUNTIME
          return { ...prev, [activeId]: { ...rt, state: res.world } }
        })
      } finally {
        setWorldSavingLaws(false)
      }
    },
    [activeId],
  )

  /**
   * 上帝行动 —— 跑一个回合。用 fetch + ReadableStream 读 SSE
   * （与 useChat 的 sendMessage 同款，但世界回合没有重试 / 草稿 / 分区迁移，简单得多）。
   */
  const actWorld = useCallback(
    async (content: string) => {
      const convId = activeId
      const text = content.trim()
      if (!convId || !text) return
      const rt = worldRef.current[convId]
      if (!rt || rt.state?.status !== 'ready' || rt.acting) return

      patch(convId, { acting: true, actingName: null, error: null })
      try {
        const res = await fetch(`/api/worlds/${convId}/act`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text, language: i18n.language }),
        })
        if (!res.ok || !res.body) {
          const body = await res.text().catch(() => '')
          let message = body
          try {
            message = (JSON.parse(body) as { error?: string }).error ?? body
          } catch {
            /* 非 JSON 响应，原样使用 */
          }
          throw new Error(message || `HTTP ${res.status}`)
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            try {
              applyWorldMessage(convId, JSON.parse(line.slice(6)) as ServerMessage)
            } catch {
              /* 保活注释或半行 */
            }
          }
        }
      } catch (err) {
        patch(convId, { error: (err as Error).message })
      } finally {
        patch(convId, { acting: false, actingName: null })
      }
    },
    [activeId, applyWorldMessage, i18n.language, patch],
  )

  const runtime = activeId ? worldByConv[activeId] ?? EMPTY_RUNTIME : EMPTY_RUNTIME

  return {
    ...groupChat,
    // isWorldMode 由 useGroupChat 提供（与 isGroupMode 在完全相同的三处赋值点同步）
    worldState: runtime.state,
    worldEntities: runtime.entities,
    worldEvents: runtime.events,
    worldAgents: runtime.agents,
    worldLoading: runtime.loading,
    worldError: runtime.error,
    worldActing: runtime.acting,
    worldActingName: runtime.actingName,
    worldSavingLaws,
    createWorld,
    saveWorldLaws,
    actWorld,
  }
}
