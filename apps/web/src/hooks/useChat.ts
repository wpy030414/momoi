import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { api, getUser, clearSession, notifyAuthExpired, getDeviceIdForRequest, subscribeRealtime, connectRealtime } from '../lib/api'
import type { Conversation, Attachment, TraceEntry } from '@momoi/shared/types'
import { THINKING_SEGMENT_OPEN } from '@momoi/shared/constants'

interface ChatMessage {
  id?: number
  role: 'user' | 'assistant'
  content: string
  toolCalls?: Array<{ id?: string; name: string; input: Record<string, unknown>; status?: 'running' | 'done' | 'error'; result?: string; artifacts?: Array<{ filename: string; displayName: string; mimeType: string; downloadUrl: string }> }>
  trace?: TraceEntry[]
  suggestions?: string[]
  attachments?: Attachment[]
  streaming?: boolean
  created_at?: string
  /** Group chat: which agent sent this message */
  agent_id?: string | null
  /** Group chat: agent display name */
  agent_name?: string | null
}

/** Agent 向用户提问的待答事件（ask_user），按会话分区存储 */
type PendingQuestion = import('@momoi/shared/types').ServerMessage & { type: 'ask_user' }

const MAX_RETRIES = 3
const RETRY_BASE_MS = 2000

/** 草稿分区 key 前缀：无会话 ID 的草稿以唯一自增 `draft:N` 作为分区标识，
 *  与真实会话 ID 命名空间隔离，双草稿互不冲突。 */
const DRAFT_PREFIX = 'draft:'
const isDraftKey = (k: string) => k.startsWith(DRAFT_PREFIX)

/** 远程流判活 TTL：他设备流事件的终态（done/error）可能丢失，窗口内
 *  快照合并按「流进行中」处理，避免吞掉尾部正在生成的消息。
 *  与本地空闲超时一致（60s）：远程流静默（长工具执行 / 群聊 agent 间隔）
 *  超过本地也会放弃的时长，才视为结束。 */
const REMOTE_STREAM_TTL_MS = 60_000

/** 服务端 Message → 本地 ChatMessage 映射（历史加载 / 收尾 refetch / 会话切换共用） */
function mapServerMessage(m: { id: number; role: string; content: string; tool_calls?: unknown; suggestions?: unknown; attachments?: unknown; agent_id?: string | null; trace?: unknown }): ChatMessage {
  const toolCalls = m.tool_calls as any || undefined
  const dbTrace = m.trace as any
  const trace = Array.isArray(dbTrace) && dbTrace.length > 0
    ? dbTrace as TraceEntry[]
    : undefined
  return {
    id: m.id,
    role: m.role as 'user' | 'assistant',
    content: m.content,
    toolCalls,
    trace,
    suggestions: m.suggestions as any || undefined,
    attachments: m.attachments as any || undefined,
    agent_id: m.agent_id ?? null,
  }
}

/**
 * 快照合并：DB 快照为历史权威，若该分区仍有活动流（本地 / 远程），
 * 保留分区尾部「比快照新」的消息（流式占位 / 未落库气泡），避免切换
 * 会话时丢掉正在生成的回复。非活动分区由调用方直接整体覆盖。
 *
 * mode='merge'（视图加载）：非空快照下 id > maxSnapId 视为「比快照新」
 *   （如已落库但快照更旧的远程中继消息）；空快照只保留活动尾部。
 * mode='reconcile'（conv_changed 对账 / 流收尾）：DB 完全权威——带 id
 *   但不在快照中的持久化消息视为「已被他端删除」，绝不复活。
 * （导出以便将来接入单测；纯函数，无外部依赖。） */
export function mergeSnapshotIntoPartition(prev: ChatMessage[], snapshot: ChatMessage[], mode: 'merge' | 'reconcile' = 'merge'): ChatMessage[] {
  const maxSnapId = snapshot.reduce((mx, m) => Math.max(mx, m.id ?? 0), 0)
  let cut = prev.length
  while (cut > 0) {
    const m = prev[cut - 1]
    // 活动尾部 = 流式中（streaming===true）或乐观消息（无 id 且未被标记结束
    // ——streaming 为 undefined，如本地乐观 user 气泡）。done/agent_done 后的
    // 无 id 气泡（streaming===false）不算：DB 快照已含其落库版本，再 keep 会重复。
    const live = m.streaming === true || (m.id == null && m.streaming !== false)
    // reconcile：只保留活动尾部——快照里已有的由快照自身提供，不在快照中的
    //   持久化消息视为已被他端删除。
    // merge：非空快照下 id > maxSnapId 视为「比快照新」（如已落库但快照更旧
    //   的远程中继消息）仍需保留；空快照（回退到零条）只保留活动尾部。
    const keep = live || (mode === 'merge' && snapshot.length > 0 && m.id != null && m.id > maxSnapId)
    if (!keep) break
    cut--
  }
  return [...snapshot, ...prev.slice(cut)]
}

/** 本地流元数据：abort 控制器与模式标记跟随分区 key 存取（替代全局单份 ref） */
interface LocalStream {
  abort: AbortController
  infinite: boolean
  group: boolean
  /** 用户主动取消（cancel / 回退）：sendMessage 的 catch 据此区分「用户取消」与「空闲超时重试」 */
  userCancelled?: boolean
}

export function useChat() {
  const { t, i18n } = useTranslation()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  /** 草稿会话标记：新建会话在发出第一条消息前不落库、不建记录。
   *  direct / group 表示当前处于「新会话草稿」状态（activeId 为 null），
   *  首条消息发送时服务端按 conversation_type + agent_ids 建会，收到
   *  conversation_id 事件后分区迁移至真实 ID，转为真实会话。 */
  const [draftType, setDraftType] = useState<'direct' | 'group' | null>(null)
  /** 当前草稿的分区 key（唯一 draft:N）；activeId 与其互斥，二者合称视图 key */
  const [draftKey, setDraftKey] = useState<string | null>(null)

  // ---- 按会话分区的状态（渲染派生）；ref 镜像同步最新值供事件处理器读取 ----
  const [messagesByConv, setMessagesByConv] = useState<Record<string, ChatMessage[]>>({})
  const [loadingByConv, setLoadingByConv] = useState<Record<string, boolean>>({})
  const [pendingByConv, setPendingByConv] = useState<Record<string, PendingQuestion | null>>({})

  const messagesByConvRef = useRef<Record<string, ChatMessage[]>>({})
  const loadingRef = useRef<Record<string, boolean>>({})
  const pendingRef = useRef<Record<string, PendingQuestion | null>>({})
  const conversationsRef = useRef<Conversation[]>([])

  // ---- 未读消息计数（侧边栏红点） ----
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>({})
  const unreadCountsRef = useRef<Record<string, number>>({})

  const setUnreadCountFor = useCallback((key: string, count: number) => {
    if (unreadCountsRef.current[key] === count) return
    const all = { ...unreadCountsRef.current, [key]: count }
    unreadCountsRef.current = all
    setUnreadCounts(all)
  }, [])

  const clearUnreadFor = useCallback((key: string) => {
    if (unreadCountsRef.current[key] === undefined) return
    const all = { ...unreadCountsRef.current }
    delete all[key]
    unreadCountsRef.current = all
    setUnreadCounts(all)
  }, [])

  /** 「浏览中即已读」自动续读：推进服务端 last_read_at。
   *  正在查看的会话收到 unread_update(>0)（= 消息输出完成事件）时调用——
   *  仅本地忽略红点是不够的：服务端权威计数仍在，切走后一次
   *  refreshConversations / 迟到的 unread_update 会把红点补回来。
   *  群聊多 Agent 连发时同一会话会密集触发：in-flight 去重 + dirty 补发，
   *  保证在途期间新完成的消息也被最终水位覆盖。 */
  const markReadInFlightRef = useRef<Set<string>>(new Set())
  const markReadDirtyRef = useRef<Set<string>>(new Set())
  const markConversationRead = useCallback((cid: string) => {
    if (markReadInFlightRef.current.has(cid)) {
      markReadDirtyRef.current.add(cid)
      return
    }
    markReadInFlightRef.current.add(cid)
    api.markConversationRead(cid)
      .catch(() => { /* 失败静默：下一次 unread_update / 列表刷新会再次触发 */ })
      .finally(() => {
        markReadInFlightRef.current.delete(cid)
        if (markReadDirtyRef.current.has(cid)) {
          markReadDirtyRef.current.delete(cid)
          markConversationRead(cid)
        }
      })
  }, [])

  /** 视图 key：activeId ?? draftKey（null = 首页空态）。事件回调经 ref 读最新值。 */
  const activeIdRef = useRef<string | null>(null)
  const activeKeyRef = useRef<string | null>(null)
  const draftKeyRef = useRef<string | null>(null)
  const draftSeqRef = useRef(0)
  /** 视图加载世代：mount 恢复 / hashchange / 主动切换共用，乱序响应按世代丢弃 */
  const loadGenRef = useRef(0)
  /** 本地流注册表（含 abort 与模式标记），key = 分区 key */
  const streamsRef = useRef<Map<string, LocalStream>>(new Map())
  /** 远程流（他设备）最近事件时间戳，TTL 内视为流进行中 */
  const remoteLastAtRef = useRef<Map<string, number>>(new Map())
  /** 会话类型缓存（direct / group），供远程流事件判组 */
  const convTypesRef = useRef<Map<string, 'direct' | 'group'>>(new Map())

  useEffect(() => {
    conversationsRef.current = conversations
  }, [conversations])

  /** 视图 key 唯一写入口：三个 ref 同步更新 + 两个 state 镜像。
   *  所有「切换 activeId / 草稿」的站点必须经此——setActiveId 的 effect
   *  是异步提交的，散落的手工 ref patch 会留下毫秒级不一致窗口
   *  （视图已显示新会话、activeKeyRef 仍指向旧值，cancel/revert 失灵）。 */
  const setViewKey = useCallback((active: string | null, draft: string | null) => {
    activeIdRef.current = active
    draftKeyRef.current = draft
    activeKeyRef.current = active ?? draft
    setActiveId(active)
    setDraftKey(draft)
  }, [])

  // ---- 分区写入辅助：ref 为事实源、state 为渲染镜像，所有分区写必须经此 ----

  const updateMessages = useCallback((key: string, updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    const cur = messagesByConvRef.current[key] ?? []
    const next = updater(cur)
    if (next === cur) return // 「返回原引用」= 不变，短路（沿用旧 setMessages 语义）
    const all = { ...messagesByConvRef.current, [key]: next }
    messagesByConvRef.current = all
    setMessagesByConv(all)
  }, [])

  const setLoadingFor = useCallback((key: string, v: boolean) => {
    if (loadingRef.current[key] === v) return
    const all = { ...loadingRef.current, [key]: v }
    loadingRef.current = all
    setLoadingByConv(all)
  }, [])

  const setPendingFor = useCallback((key: string, q: PendingQuestion | null) => {
    const all = { ...pendingRef.current, [key]: q }
    pendingRef.current = all
    setPendingByConv(all)
  }, [])

  const clearPendingFor = useCallback((key: string) => {
    if (!(key in pendingRef.current)) return
    const all = { ...pendingRef.current }
    delete all[key]
    pendingRef.current = all
    setPendingByConv(all)
  }, [])

  /** 会话类型：草稿视为单聊；缓存 → 会话列表 → direct 兜底 */
  const convTypeOf = useCallback((key: string): 'direct' | 'group' => {
    if (isDraftKey(key)) return 'direct'
    const cached = convTypesRef.current.get(key)
    if (cached) return cached
    const conv = conversationsRef.current.find((c) => c.id === key)
    return ((conv?.type as 'direct' | 'group') || 'direct')
  }, [])

  /** 分区是否有活动流：本地流注册表中存在，或远程流 TTL 窗口内 */
  const isStreamLive = useCallback((key: string): boolean => {
    if (streamsRef.current.has(key)) return true
    return Date.now() - (remoteLastAtRef.current.get(key) ?? 0) < REMOTE_STREAM_TTL_MS
  }, [])

  /** 快照落分区：活动流走合并（保住正在生成的尾部），否则整体覆盖。
   *  mode 语义见 mergeSnapshotIntoPartition（merge=视图加载 / reconcile=DB 对账）。 */
  const applySnapshot = useCallback((key: string, snapshot: ChatMessage[], mode: 'merge' | 'reconcile' = 'merge') => {
    updateMessages(key, (prev) => (isStreamLive(key) ? mergeSnapshotIntoPartition(prev, snapshot, mode) : snapshot))
  }, [updateMessages, isStreamLive])

  const updateLastMessage = useCallback((key: string, patch: Partial<ChatMessage>) => {
    updateMessages(key, (prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant') return prev
      return [...prev.slice(0, -1), { ...last, ...patch }]
    })
  }, [updateMessages])

  /** 分区重命名（conversation_id 到达、草稿转正）：消息 / loading / pending / 流注册表 / 远程戳整体迁移 */
  const renamePartition = useCallback((oldKey: string, newKey: string) => {
    const all = { ...messagesByConvRef.current }
    if (all[oldKey] !== undefined) {
      const msgs = all[oldKey]
      delete all[oldKey]
      if (all[newKey] === undefined) all[newKey] = msgs
      messagesByConvRef.current = all
      setMessagesByConv(all)
    }
    if (oldKey in loadingRef.current) {
      const l = { ...loadingRef.current }
      const v = l[oldKey]
      delete l[oldKey]
      if (!(newKey in l)) l[newKey] = v
      loadingRef.current = l
      setLoadingByConv(l)
    }
    if (oldKey in pendingRef.current) {
      const q = { ...pendingRef.current }
      const v = q[oldKey]
      delete q[oldKey]
      if (!(newKey in q)) q[newKey] = v
      pendingRef.current = q
      setPendingByConv(q)
    }
    const entry = streamsRef.current.get(oldKey)
    if (entry) {
      streamsRef.current.delete(oldKey)
      if (!streamsRef.current.has(newKey)) streamsRef.current.set(newKey, entry)
    }
    const remoteAt = remoteLastAtRef.current.get(oldKey)
    if (remoteAt !== undefined) {
      remoteLastAtRef.current.delete(oldKey)
      if (!remoteLastAtRef.current.has(newKey)) remoteLastAtRef.current.set(newKey, remoteAt)
    }
  }, [])

  /** 分区销毁（删除会话 / 登出）：掐断本地流并清空全部痕迹。
   *  掐流前标记 userCancelled，让流按「用户取消」收尾而不是重试。 */
  const clearPartition = useCallback((key: string) => {
    const entry = streamsRef.current.get(key)
    if (entry) {
      entry.userCancelled = true
      entry.abort.abort()
    }
    streamsRef.current.delete(key)
    remoteLastAtRef.current.delete(key)
    convTypesRef.current.delete(key)
    if (key in messagesByConvRef.current) {
      const all = { ...messagesByConvRef.current }
      delete all[key]
      messagesByConvRef.current = all
      setMessagesByConv(all)
    }
    if (key in loadingRef.current) {
      const l = { ...loadingRef.current }
      delete l[key]
      loadingRef.current = l
      setLoadingByConv(l)
    }
    clearPendingFor(key)
  }, [clearPendingFor])

  // Load conversations on mount
  useEffect(() => {
    api.listConversations()
      .then((res) => setConversations(res.conversations))
      .catch(console.error)
  }, [])

  const refreshConversations = useCallback(() => {
    api.listConversations()
      .then((res) => {
        setConversations(res.conversations)
        // Server is authoritative for unread counts; sync them.
        // 例外：正在查看的会话未读应恒为 0（浏览中即已读）——若服务端
        // 仍有计数（如 SSE 断线期间错过了 unread_update），推进已读水位
        // 自愈，且不写入本地计数，避免切走时旧值点亮红点。
        const counts: Record<string, number> = {}
        for (const conv of res.conversations) {
          const uc = (conv as any).unread_count as number | undefined
          if (uc && uc > 0) {
            if (activeKeyRef.current === conv.id) markConversationRead(conv.id)
            else counts[conv.id] = uc
          }
        }
        unreadCountsRef.current = counts
        setUnreadCounts(counts)
      })
      .catch(console.error)
  }, [markConversationRead])

  /**
   * 会话视图加载公共入口（mount 恢复 / hashchange / 主动切换共用）。
   * 世代守卫：发起时占用 gen，响应回来若已过期（用户又切走了）整体丢弃，
   * 杜绝慢响应覆盖新视图。快照经 applySnapshot 落分区，活动流的尾部
   * （正在生成的回复）不会被 DB 快照抹掉。
   *
   * 关键：setViewKey 在 await 之前同步更新——sendMessage 的 streamKey
   * 取自此 ref，若等 API 返回才更新，用户在「已切走、旧流已结束」的窗口
   * 发消息会被路由到旧会话（串会话的水龙头口）。
   */
  const loadConversation = useCallback(async (id: string, gen: number, mode: 'initial' | 'hash') => {
    // 即刻固定视图键位，让并发 sendMessage 读到正确分区
    setViewKey(id, null)
    setDraftType(null)
    const newHash = `#/c/${encodeURIComponent(id)}`
    if (mode === 'initial' && window.location.hash !== newHash) {
      history.pushState(null, '', newHash)
    }
    try {
      // 用户主动打开会话 → 唯一合法的「已读」入口：服务端推进 last_read_at
      // 并广播 unread_update(0)。其余 getConversation 调用（对账 / 导出等）
      // 均不标记，避免后台拉取误清侧边栏红点。
      const res = await api.getConversation(id, true)
      if (loadGenRef.current !== gen) return null
      const type = ((res.conversation as Conversation).type as 'direct' | 'group') || 'direct'
      convTypesRef.current.set(id, type)
      applySnapshot(id, res.messages.map(mapServerMessage))
      clearUnreadFor(id)
      return res
    } catch {
      if (loadGenRef.current !== gen) return null
      // Access denied or not found — clear hash, return to initial page
      setViewKey(null, draftKeyRef.current)
      setDraftType(null)
      history.replaceState(null, '', window.location.pathname + window.location.search)
      return null
    }
  }, [applySnapshot, clearUnreadFor, setViewKey])

  // Restore conversation from URL hash on mount (#/c/{id})
  useEffect(() => {
    const match = window.location.hash.match(/^#\/c\/(.+)$/)
    if (!match) return
    const id = decodeURIComponent(match[1])
    void loadConversation(id, ++loadGenRef.current, 'hash')
  }, [loadConversation])

  // Sync active conversation when URL hash changes (browser back/forward)
  useEffect(() => {
    const onHashChange = () => {
      const match = window.location.hash.match(/^#\/c\/(.+)$/)
      const id = match ? decodeURIComponent(match[1]) : null
      if (!id) {
        // 回到首页：作废在途加载；各分区保留，草稿绑定不动
        ++loadGenRef.current
        setViewKey(null, draftKeyRef.current)
        return
      }
      void loadConversation(id, ++loadGenRef.current, 'hash')
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [loadConversation, setViewKey])

  /** 全量重拉指定会话的消息（回退 / conv_changed 对账用）。
   *  分区存在即对账（含后台会话，切回即正确）；未打开过的会话不惰性建分区。 */
  const refetchConversation = useCallback(async (id: string) => {
    const res = await api.getConversation(id).catch(() => null)
    if (!res) return
    const type = ((res.conversation as Conversation).type as 'direct' | 'group') || 'direct'
    convTypesRef.current.set(id, type)
    if (messagesByConvRef.current[id] !== undefined) {
      // conv_changed = 他端改动 DB（回退等）：DB 权威对账，绝不复活已删消息
      applySnapshot(id, res.messages.map(mapServerMessage), 'reconcile')
    }
  }, [applySnapshot])

  /** 每次渲染后刷新 ref：让 useCallback 包裹的入口始终调到最新闭包（t 随语言变化等）。
   *  声明在 sendMessage 之前：其闭包经 ref 调用 handleSSEEvent——handleSSEEvent
   *  是每渲染重建的普通函数，直接引用入 deps 会使 sendMessage 每渲染重建。 */
  const handleSSEEventRef = useRef(handleSSEEvent)
  useEffect(() => {
    handleSSEEventRef.current = handleSSEEvent
  })

  const sendMessage = useCallback(async (text: string, thinkingMode = true, attachments?: Array<{ url: string; name: string; size: number; type: string }>, agentId?: string | null, groupMode?: boolean, groupAgentIds?: string[], infiniteMode?: boolean, _forceCompliance?: boolean) => {
    if (!text.trim()) return

    // 目标分区：当前会话 → 当前草稿 → 首页空态就地开隐式 direct 草稿（保持原有行为）
    let streamKey: string
    if (activeIdRef.current) {
      streamKey = activeIdRef.current
    } else if (draftKeyRef.current) {
      streamKey = draftKeyRef.current
    } else {
      streamKey = `${DRAFT_PREFIX}${++draftSeqRef.current}`
      setDraftType('direct')
      setViewKey(null, streamKey)
    }
    // 同会话串行（防重复发送）；跨会话不再互斥——这正是多会话并发的基础
    if (loadingRef.current[streamKey]) return

    const userMsg: ChatMessage = { role: 'user', content: text, attachments }
    const assistantMsg: ChatMessage = { role: 'assistant', content: '', streaming: true, trace: [] }
    updateMessages(streamKey, (prev) => [...prev, userMsg, ...(groupMode ? [] : [assistantMsg])])

    const entry: LocalStream = { abort: new AbortController(), infinite: !!infiniteMode, group: !!groupMode }
    streamsRef.current.set(streamKey, entry)
    setLoadingFor(streamKey, true)

    let convId = activeIdRef.current
    let attempt = 0
    let done = false
    /** 本轮 SSE 流中是否收到过 done 事件（收尾 refetch 的前置条件之一） */
    let gotDoneEvent = false

    while (attempt <= MAX_RETRIES && !done) {
      const isRetry = attempt > 0

      // 该流仍在本会话的「当前流注册表」中才可继续——done 后 SSE 连接
      // （等 suggestions）关闭前，同会话新一轮 send 已替换了 streamsRef 项；
      // 此时 old 流掉线若被重试，会误用 updateLastMessage 把新流的气泡抹掉。
      if (isRetry && streamsRef.current.get(streamKey) !== entry) break

      if (isRetry) {
        updateLastMessage(streamKey, { content: '', streaming: true })
        const delay = Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), 10_000)
        await new Promise((r) => setTimeout(r, delay))
        if (entry.abort.signal.aborted) break
      }

      try {
        const reqStartedAt = Date.now()
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User': encodeURIComponent(getUser() || ''),
          },
          body: JSON.stringify({
            message: text,
            conversation_id: convId || undefined,
            agent_id: agentId || undefined,
            _retry: isRetry,
            _force_compliance: _forceCompliance || undefined,
            thinking_mode: thinkingMode,
            attachments: attachments || undefined,
            conversation_type: groupMode ? 'group' : undefined,
            agent_ids: groupMode && groupAgentIds ? groupAgentIds : undefined,
            infinite_mode: infiniteMode || undefined,
            language: i18n.language,
            device_id: getDeviceIdForRequest() || undefined,
          }),
          signal: entry.abort.signal,
        })

        if (!res.ok) {
          if (res.status === 401) {
            clearSession()
            notifyAuthExpired(reqStartedAt)
          }
          const err = await res.json().catch(() => ({ error: res.statusText }))
          throw new Error(err.error || `HTTP ${res.status}`)
        }

        // Parse SSE stream with idle timeout
        const reader = res.body!.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let receivedDone = false
        let receivedTokens = false
        const IDLE_TIMEOUT = 60_000
        let idleTimer: ReturnType<typeof setTimeout> | null = null

        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => entry.abort.abort(), IDLE_TIMEOUT)
        }
        resetIdleTimer()

        try {
          while (true) {
            const { done: streamDone, value } = await reader.read()
            if (streamDone) break

            resetIdleTimer()
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() || ''

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue
              const data = line.slice(6).trim()
              if (!data || data === '[DONE]') continue

              try {
                const msg = JSON.parse(data)
                if (msg.type === 'token') receivedTokens = true
                if (msg.type === 'done' || msg.type === 'error') receivedDone = true
                if (msg.type === 'done') gotDoneEvent = true

                // 草稿转正：服务端为新会话（或重试轮）下发 conversation_id。
                // 分区整体迁移至真实 ID；仅当用户仍停留在这份草稿上才提升视图，
                // 避免把已切走的视图拽回来。
                if (msg.type === 'conversation_id') {
                  convId = msg.id
                  if (msg.id && msg.id !== streamKey) {
                    const oldKey = streamKey
                    renamePartition(oldKey, msg.id)
                    convTypesRef.current.set(msg.id, groupMode ? 'group' : 'direct')
                    if (activeKeyRef.current === oldKey) {
                      setViewKey(msg.id, null)
                      setDraftType(null)
                      const newHash = `#/c/${encodeURIComponent(msg.id)}`
                      if (window.location.hash !== newHash) {
                        history.replaceState(null, '', newHash)
                      }
                    }
                    streamKey = msg.id
                  }
                }

                handleSSEEventRef.current(msg, streamKey)
              } catch {
                // skip malformed lines
              }
            }
          }

          // Stream ended — check if we got a proper completion
          if (!receivedDone) {
            // Check if we received any tokens — partial response is better than retry loop
            if (receivedTokens) {
              // We got some tokens but stream closed without done/error.
              // Likely a transient network drop — treat as graceful close, don't retry
              // (retrying would duplicate the message and waste tokens)
              console.warn('Stream closed early but partial content received; keeping response')
              updateLastMessage(streamKey, { streaming: false })
              done = true
            } else {
              // No content at all — this is a real failure, retry
              throw new Error('Stream ended without response')
            }
          } else {
            done = true
          }
        } finally {
          if (idleTimer) clearTimeout(idleTimer)
        }
      } catch (err) {
        const isAbort = (err as Error).name === 'AbortError'
        // 读闭包里的 entry（而非注册表）：分区可能已被 clearPartition / resetChat
        // 连同注册表项一起删除，此时仍要按「用户取消」收尾而不是重试
        const isUserCancel = isAbort && !!entry.userCancelled

        if (isUserCancel) {
          // User explicitly cancelled (cancel / revert) — keep the local bubble
          updateLastMessage(streamKey, { streaming: false })
          done = true
        } else if (isAbort) {
          // Idle timeout or connection drop — retry
          if (attempt >= MAX_RETRIES) {
            updateLastMessage(streamKey, { content: t('chat.errorMessage', { message: t('chat.connectionTimeout') }), streaming: false })
            done = true
          }
          // else: loop continues
        } else if (attempt >= MAX_RETRIES) {
          console.error('Chat error:', err)
          updateLastMessage(streamKey, { content: t('chat.errorMessage', { message: (err as Error).message }), streaming: false })
          done = true
        }
        // Non-fatal network error — retry
      }

      attempt++
    }

    // 收尾：仅当本会话没有更新的流（同会话抢发）才动 loading / 注册表，
    // 避免误关新一轮的 loading 或误删其注册表项。分区已被销毁（删除会话 /
    // 登出重置）时 ownsStream 同样为 false —— 此时也不再发任何请求（401 教训）。
    const ownsStream = streamsRef.current.get(streamKey) === entry
    if (ownsStream) {
      setLoadingFor(streamKey, false)
      streamsRef.current.delete(streamKey)
      remoteLastAtRef.current.delete(streamKey)
      refreshConversations()
    }

    // Re-fetch messages from server to get real IDs for locally-created messages.
    // 写回本会话自己的分区（不再污染当前视图——用户可能已切到其他会话）。
    // 竞态守卫：done 已提前结束 loading，用户可能在流关闭前抢发了新消息（同会话
    // 新流已在流式）——此时注册表项已被新一轮覆盖，跳过全量 refetch，避免抹掉新气泡。
    // 另要求收到过 done 事件：用户取消 / 重试耗尽时保留本地气泡（含错误提示），
    // 不被 DB 快照覆盖。无限演算每轮都会发 done，会话结束时同样能触发对账。
    // 流已主动终止（cancel / revert）：绝对禁止后续 refetch——会覆盖掉本地
    //   故意保留的半生成内容或回退截断状态，并可能复活刚被回退的消息。
    const forciblyTerminated = streamTerminatedForciblyRef.current
    streamTerminatedForciblyRef.current = false
    if (convId && ownsStream && gotDoneEvent && !forciblyTerminated) {
      const res = await api.getConversation(convId).catch(() => null)
      if (res) {
        // 流已结束（gotDoneEvent）：DB 权威对账——不复活他端已删的消息
        applySnapshot(streamKey, res.messages.map(mapServerMessage), 'reconcile')
      }
    }

    // Safety net: ensure streaming is cleared（同样只在没有更新流时执行）
    if (!streamsRef.current.has(streamKey)) {
      updateLastMessage(streamKey, { streaming: false })
    }
  }, [updateMessages, updateLastMessage, setLoadingFor, renamePartition, applySnapshot, refreshConversations, setViewKey, t, i18n])

  /** 实时中继事件入口：他设备流事件写入其会话自己的分区 */
  const handleRemoteStreamEvent = useCallback((msg: import('@momoi/shared/types').ServerMessage, conversationId: string) => {
    handleSSEEventRef.current(msg, conversationId, { remote: true })
  }, [])

  function handleSSEEvent(msg: any, key: string, opts?: { remote?: boolean }) {
    const remote = !!opts?.remote
    switch (msg.type) {
      case 'user_message_id': {
        if (remote) return // 他设备的用户消息 ID 回填对本设备无意义
        // Assign the server-assigned ID to the locally-created user message
        // so the revert button becomes available immediately
        updateMessages(key, (prev) => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].role === 'user' && !prev[i].id) {
              const updated = [...prev]
              updated[i] = { ...updated[i], id: msg.id }
              return updated
            }
          }
          return prev
        })
        break
      }

      case 'user_message': {
        // 实时中继：他设备渲染用户气泡（source 设备本地已有，不重发）。
        // 单聊下同步预建流式 assistant 气泡 —— 与源设备 sendMessage 的
        // 初始状态对齐，否则后续 token 因「最后一条是 user」被丢弃。
        const isGroup = convTypeOf(key) === 'group'
        updateMessages(key, (prev) => {
          const userBubble = { role: 'user' as const, id: msg.id, content: msg.content, attachments: msg.attachments || undefined }
          if (isGroup) return [...prev, userBubble]
          return [
            ...prev,
            userBubble,
            { role: 'assistant' as const, content: '', streaming: true, trace: [] },
          ]
        })
        break
      }

      case 'token':
        updateMessages(key, (prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          const newContent = last.content + msg.text
          // 同步 trace：追加到最后一个 text 条目，或新建一个
          const trace = last.trace || []
          const lastEntry = trace[trace.length - 1]
          let newTrace: TraceEntry[]
          if (lastEntry && lastEntry.type === 'text') {
            const updated = [...trace]
            updated[updated.length - 1] = { ...lastEntry, text: lastEntry.text + msg.text }
            newTrace = updated
          } else {
            newTrace = [...trace, { type: 'text' as const, text: msg.text }]
          }
          // 远程流恢复：尾部气泡曾被 DB 快照整体覆盖（判活 TTL 过期所致），
          // 重新置为流式让后续 token 继续追加，而不是静默丢流
          if (remote && !last.streaming) {
            return [...prev.slice(0, -1), { ...last, content: newContent, streaming: true, trace: newTrace }]
          }
          return [...prev.slice(0, -1), { ...last, content: newContent, trace: newTrace }]
        })
        break

      case 'thinking': {
        updateMessages(key, (prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          // Separator = new round header; text = append to the last thinking entry in trace
          const isSegmentHeader = msg.text.startsWith(THINKING_SEGMENT_OPEN)
          let trace = last.trace || []
          if (isSegmentHeader) {
            trace = [...trace, { type: 'thinking' as const, text: '' }]
          } else if (trace.length === 0 || trace[trace.length - 1].type !== 'thinking') {
            trace = [...trace, { type: 'thinking' as const, text: msg.text }]
          } else {
            const updated = [...trace]
            const lastEntry = updated[updated.length - 1]
            if (lastEntry.type === 'thinking') {
              updated[updated.length - 1] = { ...lastEntry, text: lastEntry.text + msg.text }
            }
            trace = updated
          }
          return [...prev.slice(0, -1), { ...last, trace, ...(remote && !last.streaming ? { streaming: true } : {}) }]
        })
        break
      }

      case 'tool_call':
      case 'tool_execution_start':
        updateMessages(key, (prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          const newToolCall = { id: msg.id, name: msg.name, input: msg.input, status: 'running' as const }
          const trace = [...(last.trace || []), { type: 'tool_call' as const, ...newToolCall }]
          return [...prev.slice(0, -1), {
            ...last,
            toolCalls: [...(last.toolCalls || []), newToolCall],
            trace,
          }]
        })
        break

      case 'tool_result':
        updateMessages(key, (prev) => {
          const last = prev[prev.length - 1]
          if (!last || !last.toolCalls?.length) return prev
          const calls = [...last.toolCalls]
          // 优先按 id 精确匹配（并行回填仍能对齐）；退化到「最后一个同名未完成」
          let idx = -1
          if (msg.id) idx = calls.findIndex((c) => c.id === msg.id)
          if (idx === -1) {
            for (let i = calls.length - 1; i >= 0; i--) {
              if (calls[i].name === msg.name && calls[i].status !== 'done') { idx = i; break }
            }
          }
          if (idx === -1) idx = calls.length - 1
          const isError = msg.summary?.startsWith('Tool error') || msg.summary?.startsWith('BLOCKED')
          calls[idx] = {
            ...calls[idx],
            status: isError ? 'error' : 'done',
            result: msg.summary,
            artifacts: msg.artifacts || calls[idx].artifacts,
          }
          // 同步 trace：按 id / name 定位并更新对应条目
          const trace = [...(last.trace || [])]
          let traceIdx = -1
          if (msg.id) traceIdx = trace.findIndex((e) => e.type === 'tool_call' && e.id === msg.id)
          if (traceIdx === -1) {
            for (let i = trace.length - 1; i >= 0; i--) {
              const e = trace[i]
              if (e.type === 'tool_call' && e.name === msg.name && e.status !== 'done') { traceIdx = i; break }
            }
          }
          if (traceIdx === -1) traceIdx = trace.length - 1
          const traceEntry = trace[traceIdx]
          if (traceEntry && traceEntry.type === 'tool_call') {
            trace[traceIdx] = { ...traceEntry, status: isError ? 'error' : 'done', result: msg.summary, artifacts: msg.artifacts || traceEntry.artifacts }
          }
          return [...prev.slice(0, -1), { ...last, toolCalls: calls, trace }]
        })
        // 如果 pendingQuestion 的 tool_call_id 匹配，清除问题卡片（限本会话）
        if (pendingRef.current[key] && msg.id && pendingRef.current[key]!.tool_call_id === msg.id) {
          setPendingFor(key, null)
        }
        break

      case 'done':
        // 单聊对齐 group_done：收到 done 即结束 loading
        // （连接可能还要保持打开，等待中立 Agent 补发 suggestions）
        if (!remote && !streamsRef.current.get(key)?.infinite) {
          setLoadingFor(key, false)
        }
        // remote done 在无限演算中不清 TTL：每轮 done 之后还有
        // follow_up → 下一轮 agent_start，TTL 清早了会导致轮间
        // conv_changed 对账时 isStreamLive=false → 整体覆盖丢 follow_up
        if (remote && !streamsRef.current.get(key)?.infinite) {
          remoteLastAtRef.current.delete(key)
        }
        updateMessages(key, (prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          return [...prev.slice(0, -1), {
            ...last,
            content: msg.reply || last.content,
            suggestions: msg.suggestions,
            streaming: false,
          }]
        })
        break

      case 'error':
        console.error('Server error:', msg.message)
        if (remote) remoteLastAtRef.current.delete(key)
        updateMessages(key, (prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          return [...prev.slice(0, -1), { ...last, content: t('chat.errorMessage', { message: msg.message }), streaming: false }]
        })
        break

      // --- Voice Events ---
      case 'voice_segment':
        window.dispatchEvent(new CustomEvent('voice:segment', {
          detail: {
            messageId: msg.message_id,
            index: msg.index,
            audioUrl: msg.audio_url,
            text: msg.text,
            duration: msg.duration_seconds,
          }
        }))
        break

      case 'voice_done':
        window.dispatchEvent(new CustomEvent('voice:done', {
          detail: {
            messageId: msg.message_id,
            totalSegments: msg.total_segments,
          }
        }))
        break

      // --- Group Chat Events ---
      case 'agent_start':
        // Start a new agent message bubble in group chat
        updateMessages(key, (prev) => [
          ...prev,
          {
            role: 'assistant',
            content: '',
            streaming: true,
            agent_id: msg.agent_id,
            agent_name: msg.agent_name,
            trace: [],
          },
        ])
        break

      case 'agent_done':
        // Mark this agent's message as complete
        updateMessages(key, (prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant' || last.agent_id !== msg.agent_id) return prev
          return [...prev.slice(0, -1), {
            ...last,
            content: msg.reply || last.content,
            suggestions: msg.suggestions,
            streaming: false,
          }]
        })
        break

      case 'suggestions':
        // 中立 Agent 补发的追问建议：挂到本轮最后一条 assistant 消息。
        // 守卫 1：仅当最后一条消息仍是 assistant 气泡时应用——loading 已提前结束，
        //         用户可能已抢发下一条消息，此时晚到的建议直接丢弃（DB 已持久化，刷新可见）。
        // 守卫 2：群聊下 agent_id 不匹配（同上竞态）也丢弃。
        updateMessages(key, (prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          if (msg.agent_id && last.agent_id && last.agent_id !== msg.agent_id) return prev
          return [...prev.slice(0, -1), { ...last, suggestions: msg.suggestions }]
        })
        break

      case 'group_done':
        if (!remote && !streamsRef.current.get(key)?.infinite) {
          setLoadingFor(key, false)
        }
        // remote 无限演算：group_done 后可能还有下一轮，不清 TTL
        if (remote && !streamsRef.current.get(key)?.infinite) {
          remoteLastAtRef.current.delete(key)
        }
        break

      case 'infinite_mode_off':
        // Server-side infinite mode ended (user turned off or hit 500 limit)
        if (!remote) setLoadingFor(key, false)
        if (remote) remoteLastAtRef.current.delete(key)
        break

      case 'follow_up_start':
        // Infinite mode: neutral agent is about to generate a follow-up
        // Create a placeholder user message bubble with loading animation
        updateMessages(key, (prev) => [
          ...prev,
          { role: 'user' as const, content: '', streaming: true },
        ])
        break

      case 'follow_up': {
        // Infinite mode: neutral agent generated a follow-up question
        // Replace the placeholder user message with actual content
        // 群聊判定不能嗅探消息上的 agent_id——单聊消息同样记录发言 Agent，
        // 从 DB 加载过的单聊会话会被误判为群聊，导致 assistant 气泡不创建，
        // 后续 token/done 因「最后一条是 user」被整体丢弃（Agent 消息被吞）。
        // 本地流：以 sendMessage 时注册的流元数据（entry.group）为准；
        // 实时中继：以该会话的类型缓存（convTypeOf）为准。
        const isGroupChat = remote ? convTypeOf(key) === 'group' : !!streamsRef.current.get(key)?.group
        const translatedText = msg.text === '（继续）' ? t('chat.followUpFallback') : msg.text
        updateMessages(key, (prev) => {
          // Find the last user message (the placeholder) and replace its content
          const updated = [...prev]
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === 'user') {
              updated[i] = { ...updated[i], content: translatedText, streaming: false }
              break
            }
          }
          // For direct chat: also create the streaming assistant bubble
          if (!isGroupChat) {
            updated.push({ role: 'assistant' as const, content: '', streaming: true, trace: [] })
          }
          return updated
        })
        break
      }

      case 'ask_user':
        // Agent 向用户提问 —— 按会话分区存储，只弹在所属会话的视图上
        setPendingFor(key, msg as PendingQuestion)
        break
    }
  }

  const sendAnswer = useCallback(async (questionId: string, answer: string, selectedOptions?: string[]) => {
    // 按 question_id 反查所属会话——提问卡片只出现在所属会话视图上，
    // 但用户可能在卡片弹出后切走，答案必须送回原会话而非当前视图。
    let targetKey: string | null = null
    for (const [k, q] of Object.entries(pendingRef.current)) {
      if (q && q.question_id === questionId) { targetKey = k; break }
    }
    if (!targetKey || isDraftKey(targetKey)) return
    setPendingFor(targetKey, null)
    try {
      await api.answerQuestion(targetKey, questionId, answer, selectedOptions)
    } catch (err) {
      console.error('Failed to send answer:', err)
    }
  }, [setPendingFor])

  /** cancel / revertMessage 应绝对禁止后续任何对账——流已主动终止，
   *  收尾的全量 refetch 会覆盖掉本地故意保留的气泡（取消后的半生成内容、
   *  回退后的截断状态）。sendMessage 的收尾判此标志跳过 refetch。 */
  const streamTerminatedForciblyRef = useRef(false)
  const cancel = useCallback(() => {
    const key = activeKeyRef.current
    if (!key) return
    // 如果有待回答的问题，先发送空答案（跳过）
    const pq = pendingRef.current[key]
    if (pq) {
      setPendingFor(key, null)
      if (!isDraftKey(key)) {
        api.answerQuestion(key, pq.question_id, '', []).catch(console.error)
      }
    }
    const entry = streamsRef.current.get(key)
    if (entry) {
      entry.userCancelled = true
      entry.abort.abort()
    }
    streamTerminatedForciblyRef.current = true
    setLoadingFor(key, false)
  }, [setPendingFor, setLoadingFor])

  const selectConversation = useCallback(async (id: string) => {
    return loadConversation(id, ++loadGenRef.current, 'initial')
  }, [loadConversation])

  /** 本地状态重置：登出 / 切换身份时使用，绝不发任何网络请求。
   *  （若在这里发请求，无会话的请求会 401 → auth:expired → handleLogout →
   *   再发请求 → ……形成无限 401 死循环，且会误杀刚登录拿到的新 cookie。） */
  const resetChat = useCallback(() => {
    // 掐断所有本地流并清空全部分区。
    // 先标记 userCancelled 再 abort：否则流会按「连接中断」进重试循环，
    // 带着已失效的凭证重新请求（401 死循环的教训见下方注释）。
    for (const entry of streamsRef.current.values()) {
      entry.userCancelled = true
      entry.abort.abort()
    }
    streamsRef.current.clear()
    remoteLastAtRef.current.clear()
    convTypesRef.current.clear()
    ++loadGenRef.current // 在途的会话加载全部作废
    messagesByConvRef.current = {}
    setMessagesByConv({})
    loadingRef.current = {}
    setLoadingByConv({})
    pendingRef.current = {}
    setPendingByConv({})
    setViewKey(null, null)
    setDraftType(null)
    setConversations([])
    unreadCountsRef.current = {}
    setUnreadCounts({})
    if (window.location.hash.startsWith('#/c/')) {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [setViewKey])

  /** 新建会话（单聊）—— 只进入草稿态，不落库。
   *  会话记录在「发出第一条消息」时由服务端创建（侧边栏同步出现）。
   *  注意：不掐断其他会话正在进行的后台流（多会话并发的关键）。 */
  const createConversation = useCallback(() => {
    const key = `${DRAFT_PREFIX}${++draftSeqRef.current}`
    ++loadGenRef.current // 作废在途的会话加载，防止慢响应覆盖新草稿
    setViewKey(null, key)
    setDraftType('direct')
    // 草稿态无会话 ID，hash 归位
    if (window.location.hash) {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [setViewKey])

  /** 新建群聊草稿：由 useGroupChat 传入所选 Agent，先暂存组态。
   *  会话记录在「发出第一条消息」时由服务端创建。 */
  const startGroupDraft = useCallback(() => {
    const key = `${DRAFT_PREFIX}${++draftSeqRef.current}`
    ++loadGenRef.current // 作废在途的会话加载，防止慢响应覆盖新草稿
    setViewKey(null, key)
    setDraftType('group')
    if (window.location.hash) {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [setViewKey])

  const deleteConversation = useCallback(async (id: string) => {
    try {
      await api.deleteConversation(id)
      ++loadGenRef.current // 作废在途加载——防止慢响应在删除后复活会话
      setConversations((prev) => prev.filter((c) => c.id !== id))
      clearPartition(id)
      clearUnreadFor(id)
      if (activeIdRef.current === id) {
        setViewKey(null, null)
        setDraftType(null)
        // Clear hash since we deleted the active conversation
        if (window.location.hash) {
          history.replaceState(null, '', window.location.pathname + window.location.search)
        }
      }
    } catch (err) {
      console.error('Failed to delete conversation:', err)
    }
  }, [clearPartition, clearUnreadFor, setViewKey])

  const renameConversation = useCallback(async (id: string, title: string) => {
    try {
      await api.renameConversation(id, title)
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title } : c))
      )
    } catch (err) {
      console.error('Failed to rename conversation:', err)
    }
  }, [])

  const exportConversation = useCallback(async (id: string) => {
    try {
      const res = await api.getConversation(id)
      // Agent 名称映射：群聊成员（res.agents）+ 全局 Agent 列表（覆盖单聊与已退群成员）
      const agentMap = new Map<string, string>()
      res.agents?.forEach((a) => agentMap.set(a.id, a.name))
      try {
        const appInfo = await api.getAppName()
        appInfo.agents?.forEach((a) => {
          if (!agentMap.has(a.id)) agentMap.set(a.id, a.name)
        })
      } catch { /* 名称补全失败不影响导出 */ }
      // 单聊：历史消息可能没有 agent_id，回退到会话所属 Agent
      const conversationAgentName = res.conversation.type === 'direct' && res.conversation.agent_id
        ? agentMap.get(res.conversation.agent_id)
        : undefined
      const nameOf = (m: { role: string; agent_id?: string | null }): string => {
        if (m.role === 'user') return t('chat.roleUser')
        if (m.role === 'system') return t('chat.roleSystem')
        if (m.role === 'tool') return t('chat.roleTool')
        return (m.agent_id ? agentMap.get(m.agent_id) : undefined) || conversationAgentName || t('chat.roleAssistant')
      }
      const lines = res.messages.map((m) => {
        const time = m.created_at ? new Date(m.created_at * 1000).toLocaleString() : ''
        return `### ${nameOf(m)}${time ? ` — ${time}` : ''}\n${m.content}`
      })
      const title = res.conversation.title || t('chat.exportDefaultTitle')
      const body = `# ${title}\n\n${lines.join('\n\n---\n\n')}\n`
      const blob = new Blob([body], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}.md`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to export conversation:', err)
    }
  }, [t])

  const revertMessage = useCallback(async (index: number) => {
    const key = activeKeyRef.current
    if (!key) return null
    const message = messagesByConvRef.current[key]?.[index]
    if (!message) return null

    // If stream is active, abort it first — the revert must interrupt any ongoing AI generation
    // （仅限本会话的流；标记 userCancelled 使 sendMessage 按用户取消收尾而非重试）
    // 禁止收尾 refetch：full-overwrite 会覆盖本地回退后的截断状态（复活刚删的消息）
    // 不以 loadingRef 为条件：done 早就在流结束前清 loading 了（suggestions
    //   阶段 SSE 仍打开），回退时流仍存活，不掐就会留下孤儿流误伤后续消息。
    const entry = streamsRef.current.get(key)
    if (entry) {
      entry.userCancelled = true
      entry.abort.abort()
      setLoadingFor(key, false)
      streamTerminatedForciblyRef.current = true
    }

    // If message has a server-assigned ID, delete from server
    if (!isDraftKey(key) && message.id) {
      try {
        await api.revertMessages(key, message.id)
      } catch (err) {
        console.error('Failed to revert message on server:', err)
      }
    }

    // Update local state — remove this message and all after it
    updateMessages(key, (prev) => prev.slice(0, index))

    return message.content
  }, [updateMessages, setLoadingFor])

  /** 强制合规重试：回退到指定消息 → 以 _force_compliance 标记立即重发。
   *  与 revertMessage 不同：不回填输入框，直接绕过内容审查重试。
   *  useGroupChat 会覆盖此实现以传入群聊 Agent ID。 */
  const forceComplianceRetry = useCallback(async (index: number): Promise<void> => {
    const key = activeKeyRef.current
    if (!key) return

    // 1. Revert: abort stream, delete from server, truncate local, get original text
    const originalText = await revertMessage(index)
    if (!originalText) return

    // 2. Re-send with _force_compliance flag (direct chat only — group chat overrides this)
    const agentId = conversationsRef.current.find((c) => c.id === key)?.agent_id || undefined
    await sendMessage(originalText, true, undefined, agentId || null, false, undefined, false, true)
  }, [revertMessage, sendMessage, conversationsRef])

  // ---- Realtime: 同账号多设备实时同步 ----
  // 建立 SSE 长连接（GET /api/events），接收其他设备的聊天流事件与
  // 会话列表 / 内容变更信号，实时渲染而不需手动刷新。
  // 依赖 getUser()：登录/登出切换账号时重建连接（旧连接在 cleanup 关闭）。
  useEffect(() => {
    const username = getUser()
    if (!username) return
    connectRealtime(username)
    const unsubscribe = subscribeRealtime((payload) => {
      switch (payload.type) {
        case 'conv_sync':
          // 会话列表变更（新建 / 删除 / 重命名 / 群成员数）—— 侧边栏刷新
          refreshConversations()
          break
        case 'conv_changed':
          // 其他设备回退了某会话的消息 —— 分区存在则整条重拉对齐（含后台会话）
          refetchConversation(payload.conversation_id)
          refreshConversations()
          break
        case 'group_members':
          // 群成员变更 —— 若正在查看该群，重拉以刷新成员数（App 侧同时刷新）
          refreshConversations()
          window.dispatchEvent(new CustomEvent('realtime:group_members', { detail: { conversation_id: payload.conversation_id } }))
          break
        case 'stream': {
          // 其他设备正在流式输出 —— 事件写入该会话自己的分区：
          // 当前正在查看（activeKey 或 hash 指向），或该分区已存在（打开过的
          // 会话后台也实时更新，切回即见）。写入自己分区不会再污染当前视图。
          const cid = payload.conversation_id
          const hashConvId = (() => {
            const m = window.location.hash.match(/^#\/c\/(.+)$/)
            return m ? decodeURIComponent(m[1]) : null
          })()
          if (activeKeyRef.current === cid || hashConvId === cid || messagesByConvRef.current[cid] !== undefined) {
            remoteLastAtRef.current.set(cid, Date.now())
            handleRemoteStreamEvent(payload.event, cid)
          }
          break
        }
        case 'unread_update': {
          const cid = payload.conversation_id
          const count = payload.unread_count
          // 正在查看的会话收到「消息输出完成」：不点红点，且必须推进服务端
          // 已读水位——否则切走后服务端权威计数会把红点补回来（幽灵红点）。
          if (activeKeyRef.current === cid) {
            if (count > 0) markConversationRead(cid)
            else clearUnreadFor(cid)
            return
          }
          if (count <= 0) {
            clearUnreadFor(cid)
          } else {
            setUnreadCountFor(cid, count)
          }
          break
        }
      }
    })
    return () => {
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshConversations, refetchConversation, handleRemoteStreamEvent, getUser(), clearUnreadFor, setUnreadCountFor, markConversationRead])

  // ---- 派生导出（签名与旧版一致，视图只是当前分区 key 的投影） ----
  const activeKey = activeId ?? draftKey
  const messages = (activeKey != null ? messagesByConv[activeKey] : undefined) || []
  const loading = !!(activeKey != null && loadingByConv[activeKey])
  const pendingQuestion = (activeKey != null ? pendingByConv[activeKey] : undefined) ?? null

  return {
    conversations,
    activeId,
    messages,
    loading,
    draftType,
    startGroupDraft,
    sendMessage,
    selectConversation,
    createConversation,
    resetChat,
    renameConversation,
    deleteConversation,
    exportConversation,
    refreshConversations,
    cancel,
    revertMessage,
    forceComplianceRetry,
    pendingQuestion,
    sendAnswer,
    // 未读计数（侧边栏红点）
    unreadCounts,
  }
}
