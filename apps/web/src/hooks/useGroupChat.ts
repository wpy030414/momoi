// ============================================================
// useGroupChat — Group chat state management
// Composes useChat with group-specific state and methods
// ============================================================

import { useState, useCallback, useEffect, useRef } from 'react'
import { useChat } from './useChat'
import { api } from '../lib/api'
import type { Conversation } from '@momoi/shared/types'
interface AgentBrief {
  id: string
  name: string
  avatar: string
}

export function useGroupChat() {
  const chat = useChat()
  // v7 exhaustive-deps：闭包内经 chat.fn() 成员链「调用」时要求把根对象列入
  // deps——而 chat 每渲染都是新对象，useCallback 会形同虚设。useChat 的函数
  // 成员均逐个 useCallback（引用稳定），解构为裸标识符后规则与 memo 两全。
  // 内层 selectConversation 改名以区别于本 hook 的同名包装层。
  const {
    conversations,
    activeId,
    draftType,
    selectConversation: selectInnerConversation,
    startGroupDraft,
    startWorldDraft,
    setWorldLaws,
    refreshConversations,
    sendMessage,
    revertMessage,
  } = chat
  const [groupAgents, setGroupAgents] = useState<AgentBrief[]>([])
  const [isGroupMode, setIsGroupMode] = useState(false)
  /** 世界模拟模式：世界会话复用群聊管线（isGroupMode 同为 true），差异只在
   *  用户消息的语义框架（来自世界的变动）与展示样式（世界变动气泡） */
  const [isWorldMode, setIsWorldMode] = useState(false)
  /** 当前世界法则：isWorldMode 时由 GET /api/worlds/:id 读出 */
  const [worldInfo, setWorldInfo] = useState<{ laws: string } | null>(null)
  const [isQqGroup, setIsQqGroup] = useState(false)
  const [allAgents, setAllAgents] = useState<AgentBrief[]>([])
  // 群模式同步守卫：包装层刚同步过的会话不再重复请求；世代计数丢弃乱序响应
  const lastGroupSyncRef = useRef<string | null>(null)
  const groupModeGenRef = useRef(0)

  // Load all available agents on mount
  useEffect(() => {
    api.getAppName().then((r) => {
      setAllAgents(r.agents || [])
    }).catch(console.error)
  }, [])

  // When switching conversations, detect group mode and load agents.
  // 覆盖未经包装层的路径（hash 恢复 / 实时事件设置 activeId）；乱序响应按世代丢弃。
  useEffect(() => {
    // 任何视图变化都作废在途响应：否则慢响应会在用户已切走（新建草稿等）后
    // 回来，把过期群状态盖到当前视图上（direct 草稿被误标群 → 首条消息误建群会话）
    const gen = ++groupModeGenRef.current
    if (activeId) {
      if (lastGroupSyncRef.current === activeId) return // 包装层刚同步过，无需重复请求
      // 侧边栏列表已能判定单聊：无需再拉会话详情（内层 loadConversation 刚拉过同一会话）
      const knownType = conversations.find((c) => c.id === activeId)?.type
      if (knownType === 'direct') {
        setIsGroupMode(false)
        setIsWorldMode(false)
        setGroupAgents([])
        setIsQqGroup(false)
        setWorldInfo(null)
        lastGroupSyncRef.current = activeId
        return
      }
      api.getConversation(activeId).then((res) => {
        if (groupModeGenRef.current !== gen) return // 过期响应，丢弃
        const conv = res.conversation as Conversation
        if (conv.type === 'group') {
          setIsGroupMode(true)
          setIsWorldMode(false)
          setWorldInfo(null)
          if (res.agents) {
            setGroupAgents(res.agents)
          }
          setIsQqGroup(res.is_qq_group === true)
        } else if (conv.type === 'world') {
          // 世界会话复用群聊管线（isGroupMode 同为 true），差异只在用户消息的
          // 语义框架（来自世界的变动）与展示样式（世界变动气泡）。世界法则
          // 由 GET /api/worlds/:id 读出，法则编辑用。
          setIsGroupMode(true)
          setIsWorldMode(true)
          if (res.agents) {
            setGroupAgents(res.agents)
          }
          setIsQqGroup(false)
          api.getWorld(activeId).then((w) => {
            if (groupModeGenRef.current !== gen) return
            setWorldInfo({ laws: w.world.laws })
          }).catch(console.error)
        } else {
          setIsGroupMode(false)
          setIsWorldMode(false)
          setGroupAgents([])
          setIsQqGroup(false)
          setWorldInfo(null)
        }
        lastGroupSyncRef.current = activeId
      }).catch(console.error)
    } else if (draftType === 'world') {
      // 世界草稿态（activeId 为 null）：保持世界模式与已选成员+法则，等待首条消息。
      // worldInfo 已由 createWorldDraft 设置，此处不覆盖。
      lastGroupSyncRef.current = null
      setIsGroupMode(true)
      setIsWorldMode(true)
    } else if (draftType === 'group') {
      // 群聊草稿态（activeId 为 null）：保持群聊模式与已选成员，等待首条消息
      lastGroupSyncRef.current = null
      setIsGroupMode(true)
      setIsWorldMode(false)
      setWorldInfo(null)
    } else {
      lastGroupSyncRef.current = null
      setIsGroupMode(false)
      setIsWorldMode(false)
      setGroupAgents([])
      setWorldInfo(null)
    }
  }, [activeId, draftType, conversations])

  // Override selectConversation: 复用 useChat 内层加载结果同步群模式，
  // 不再预取（旧实现对同一会话发两次 getConversation，且两次响应乱序时互相覆盖）。
  const selectConversation = useCallback(async (id: string) => {
    // 从侧边栏列表同步判断群模式——与内层 loadConversation 同步返回，
    // 避免 await 后 setState 被 React 分批 flush 导致过渡帧 isGroup=false
    // 时 ChatPanel 把发送路由到 onSend（单聊）而非 onSendGroup
    const knownType = conversations.find((c) => c.id === id)?.type
    if (knownType === 'group') {
      setIsGroupMode(true)
      setIsWorldMode(false)
    } else if (knownType === 'world') {
      // 世界会话：群聊管线（isGroupMode 同 true）+ 世界模式。成员与世界信息
      // 就地读出 —— 本函数结尾会把 lastGroupSyncRef 置位，效果层（站点 1）将
      // 因此早退，不在这里拉就永远读不到。
      setIsGroupMode(true)
      setIsWorldMode(true)
      api.getWorld(id).then((w) => {
        setGroupAgents(w.agents)
        setWorldInfo({ laws: w.world.laws })
      }).catch(console.error)
    } else if (knownType === 'direct') {
      setIsGroupMode(false)
      setIsWorldMode(false)
      setGroupAgents([])
      setWorldInfo(null)
    }
    const res = await selectInnerConversation(id)
    if (!res) return // 内层世代守卫已拦截（乱序 / 加载失败）
    const convType = (res.conversation as Conversation).type
    if (convType === 'group') {
      setIsGroupMode(true)
      setIsWorldMode(false)
      setGroupAgents(res.agents || [])
      setIsQqGroup((res as any).is_qq_group === true)
    } else if (convType === 'world') {
      // 内层 loadConversation 已拉过成员（服务端对 world 同样返回 agents），
      // 不重复请求；世界信息若上面还没回来，这里兜底再拉一次。
      setIsGroupMode(true)
      setIsWorldMode(true)
      setIsQqGroup(false)
      if (knownType !== 'world') {
        api.getWorld(id).then((w) => {
          setGroupAgents(w.agents)
          setWorldInfo({ laws: w.world.laws })
        }).catch(console.error)
      }
    } else {
      setIsGroupMode(false)
      setIsWorldMode(false)
      setGroupAgents([])
      setWorldInfo(null)
      setIsQqGroup(false)
    }
    lastGroupSyncRef.current = id
  }, [conversations, selectInnerConversation])

  // Create a new group conversation (draft — record created on first message)
  // 工作区不再从 NewWorkflowDialog 选择，创建后再从聊天框下拉调整
  const createGroupConversation = useCallback(async (agentIds: string[]) => {
    try {
      // Load the agents we just added
      const agentBriefs = agentIds
        .map((id) => allAgents.find((a) => a.id === id))
        .filter((a): a is AgentBrief => !!a)
      setGroupAgents(agentBriefs)
      // 进入群聊草稿态：不落库，选好 Agent 后即就位，首条消息发出时由服务端建会
      startGroupDraft(null)
      return null
    } catch (err) {
      console.error('Failed to create group conversation:', err)
      return null
    }
  }, [allAgents, startGroupDraft])

  // Create a new world simulation draft (laws + agents — record created on first message)
  const createWorldDraft = useCallback(async (laws: string, agentIds: string[]) => {
    try {
      const agentBriefs = agentIds
        .map((id) => allAgents.find((a) => a.id === id))
        .filter((a): a is AgentBrief => !!a)
      setGroupAgents(agentBriefs)
      setIsWorldMode(true)
      setWorldInfo({ laws })
      // 法则写入 ref，供 sendMessage 首条消息建会时携带 world_laws 字段
      setWorldLaws(laws)
      // 进入世界草稿态：不落库，选好 Agent + 法则后即就位，首条消息发出时由服务端建会
      startWorldDraft(null)
      return null
    } catch (err) {
      console.error('Failed to create world draft:', err)
      return null
    }
  }, [allAgents, startWorldDraft, setWorldLaws])

  // Add an agent to the current group conversation
  const addAgentToGroup = useCallback(async (agentId: string) => {
    if (!activeId) return
    try {
      await api.addGroupAgent(activeId, agentId)
      const agent = allAgents.find((a) => a.id === agentId)
      if (agent) {
        setGroupAgents((prev) => [...prev, agent])
      }
      // 群成员数变化需同步到侧边栏会话列表（agent_count）
      refreshConversations()
    } catch (err) {
      console.error('Failed to add agent to group:', err)
    }
  }, [activeId, allAgents, refreshConversations])

  // Remove an agent from the current group conversation
  const removeAgentFromGroup = useCallback(async (agentId: string) => {
    if (!activeId) return
    try {
      await api.removeGroupAgent(activeId, agentId)
      setGroupAgents((prev) => prev.filter((a) => a.id !== agentId))
      // 群成员数变化需同步到侧边栏会话列表（agent_count）
      refreshConversations()
    } catch (err) {
      console.error('Failed to remove agent from group:', err)
    }
  }, [activeId, refreshConversations])

  // Send a group message
  const sendGroupMessage = useCallback(async (
    text: string,
    thinkingMode: boolean,
    attachments?: Array<{ url: string; name: string; size: number; type: string }>,
    infiniteMode?: boolean,
  ) => {
    const agentIds = groupAgents.map((a) => a.id)
    await sendMessage(text, thinkingMode, attachments, null, true, agentIds, infiniteMode)
  }, [sendMessage, groupAgents])

  // 强制合规重试（群聊版）：回退 → 以 force_compliance 重发群聊消息。
  // 命名带 Group 后缀：此处返回值经 {...chat, ...} 合并后直接被 App 使用，
  // 若与 useChat 的单聊版同名会无条件覆盖 —— 单聊界面点「强制合规重试」
  // 会误走群聊参数（groupMode=true 不预建流式气泡），token 全部丢弃，
  // 收尾 refetch 一次性回填，表现为「不流式、一口气全吐出来」。
  const forceComplianceRetryGroup = useCallback(async (index: number) => {
    const text = await revertMessage(index)
    if (!text) return
    const agentIds = groupAgents.map((a) => a.id)
    await sendMessage(text, true, undefined, null, true, agentIds, false, true)
  }, [sendMessage, revertMessage, groupAgents])

  // Refresh group agents from server
  const refreshGroupAgents = useCallback(async () => {
    if (!activeId) return
    try {
      const res = await api.getConversation(activeId)
      const conv = res.conversation as Conversation
      if (conv.type === 'group' && res.agents) {
        setGroupAgents(res.agents)
      }
    } catch (err) {
      console.error('Failed to refresh group agents:', err)
    }
  }, [activeId])

  // Realtime: 其他设备改动了群成员 —— 若正在查看该群，刷新成员列表
  useEffect(() => {
    const onGroupMembers = (e: Event) => {
      const convId = (e as CustomEvent).detail?.conversation_id as string | undefined
      if (convId && activeId === convId) {
        refreshGroupAgents()
      }
    }
    window.addEventListener('realtime:group_members', onGroupMembers)
    return () => window.removeEventListener('realtime:group_members', onGroupMembers)
  }, [activeId, refreshGroupAgents])

  // 世界法则保存：PATCH /api/worlds/:id —— 世界唯一的可变项。
  // 抛错由调用方（LawsEditor）展示；成功后就地更新 worldInfo，避免整轮重拉。
  const saveWorldLaws = useCallback(async (laws: string) => {
    if (!activeId) return
    const res = await api.updateWorldLaws(activeId, laws)
    if (res.world) {
      setWorldInfo((prev) => (prev ? { ...prev, laws: res.world.laws } : prev))
    }
  }, [activeId])

  return {
    ...chat,
    groupAgents,
    isGroupMode,
    isWorldMode,
    worldInfo,
    isQqGroup,
    createGroupConversation,
    createWorldDraft,
    addAgentToGroup,
    removeAgentFromGroup,
    sendGroupMessage,
    forceComplianceRetryGroup,
    refreshGroupAgents,
    saveWorldLaws,
  }
}