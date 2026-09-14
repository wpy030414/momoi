// ============================================================
// useGroupChat — Group chat state management
// Composes useChat with group-specific state and methods
// ============================================================

import { useState, useCallback, useEffect, useRef } from 'react'
import { useChat } from './useChat'
import { api } from '../lib/api'
import type { Conversation } from '@/shared/types'
interface AgentBrief {
  id: string
  name: string
  avatar: string
}

export function useGroupChat() {
  const chat = useChat()
  const [groupAgents, setGroupAgents] = useState<AgentBrief[]>([])
  const [isGroupMode, setIsGroupMode] = useState(false)
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
    if (chat.activeId) {
      if (lastGroupSyncRef.current === chat.activeId) return // 包装层刚同步过，无需重复请求
      // 侧边栏列表已能判定单聊：无需再拉会话详情（内层 loadConversation 刚拉过同一会话）
      const knownType = chat.conversations.find((c) => c.id === chat.activeId)?.type
      if (knownType === 'direct') {
        setIsGroupMode(false)
        setGroupAgents([])
        lastGroupSyncRef.current = chat.activeId
        return
      }
      api.getConversation(chat.activeId).then((res) => {
        if (groupModeGenRef.current !== gen) return // 过期响应，丢弃
        const conv = res.conversation as Conversation
        if (conv.type === 'group') {
          setIsGroupMode(true)
          if (res.agents) {
            setGroupAgents(res.agents)
          }
        } else {
          setIsGroupMode(false)
          setGroupAgents([])
        }
        lastGroupSyncRef.current = chat.activeId
      }).catch(console.error)
    } else if (chat.draftType === 'group') {
      // 群聊草稿态（activeId 为 null）：保持群聊模式与已选成员，等待首条消息
      lastGroupSyncRef.current = null
      setIsGroupMode(true)
    } else {
      lastGroupSyncRef.current = null
      setIsGroupMode(false)
      setGroupAgents([])
    }
  }, [chat.activeId, chat.draftType, chat.conversations])

  // Override selectConversation: 复用 useChat 内层加载结果同步群模式，
  // 不再预取（旧实现对同一会话发两次 getConversation，且两次响应乱序时互相覆盖）。
  const selectConversation = useCallback(async (id: string) => {
    // 从侧边栏列表同步判断群模式——与内层 loadConversation 同步返回，
    // 避免 await 后 setState 被 React 分批 flush 导致过渡帧 isGroup=false
    // 时 ChatPanel 把发送路由到 onSend（单聊）而非 onSendGroup
    const knownType = chat.conversations.find((c) => c.id === id)?.type
    if (knownType === 'group') {
      setIsGroupMode(true)
    } else if (knownType === 'direct') {
      setIsGroupMode(false)
      setGroupAgents([])
    }
    const res = await chat.selectConversation(id)
    if (!res) return // 内层世代守卫已拦截（乱序 / 加载失败）
    if ((res.conversation as Conversation).type === 'group') {
      setIsGroupMode(true)
      setGroupAgents(res.agents || [])
    } else {
      setIsGroupMode(false)
      setGroupAgents([])
    }
    lastGroupSyncRef.current = id
  }, [chat])

  // Create a new group conversation (draft — record created on first message)
  const createGroupConversation = useCallback(async (agentIds: string[]) => {
    try {
      // Load the agents we just added
      const agentBriefs = agentIds
        .map((id) => allAgents.find((a) => a.id === id))
        .filter((a): a is AgentBrief => !!a)
      setGroupAgents(agentBriefs)
      // 进入群聊草稿态：不落库，选好 Agent 后即就位，首条消息发出时由服务端建会
      chat.startGroupDraft()
      return null
    } catch (err) {
      console.error('Failed to create group conversation:', err)
      return null
    }
  }, [allAgents, chat.startGroupDraft])

  // Add an agent to the current group conversation
  const addAgentToGroup = useCallback(async (agentId: string) => {
    if (!chat.activeId) return
    try {
      await api.addGroupAgent(chat.activeId, agentId)
      const agent = allAgents.find((a) => a.id === agentId)
      if (agent) {
        setGroupAgents((prev) => [...prev, agent])
      }
      // 群成员数变化需同步到侧边栏会话列表（agent_count）
      chat.refreshConversations()
    } catch (err) {
      console.error('Failed to add agent to group:', err)
    }
  }, [chat.activeId, allAgents, chat.refreshConversations])

  // Remove an agent from the current group conversation
  const removeAgentFromGroup = useCallback(async (agentId: string) => {
    if (!chat.activeId) return
    try {
      await api.removeGroupAgent(chat.activeId, agentId)
      setGroupAgents((prev) => prev.filter((a) => a.id !== agentId))
      // 群成员数变化需同步到侧边栏会话列表（agent_count）
      chat.refreshConversations()
    } catch (err) {
      console.error('Failed to remove agent from group:', err)
    }
  }, [chat.activeId, chat.refreshConversations])

  // Send a group message
  const sendGroupMessage = useCallback(async (
    text: string,
    thinkingMode: boolean,
    attachments?: Array<{ url: string; name: string; size: number; type: string }>,
    infiniteMode?: boolean,
  ) => {
    const agentIds = groupAgents.map((a) => a.id)
    await chat.sendMessage(text, thinkingMode, attachments, null, true, agentIds, infiniteMode)
  }, [chat.sendMessage, groupAgents])

  // Refresh group agents from server
  const refreshGroupAgents = useCallback(async () => {
    if (!chat.activeId) return
    try {
      const res = await api.getConversation(chat.activeId)
      const conv = res.conversation as Conversation
      if (conv.type === 'group' && res.agents) {
        setGroupAgents(res.agents)
      }
    } catch (err) {
      console.error('Failed to refresh group agents:', err)
    }
  }, [chat.activeId])

  // Realtime: 其他设备改动了群成员 —— 若正在查看该群，刷新成员列表
  useEffect(() => {
    const onGroupMembers = (e: Event) => {
      const convId = (e as CustomEvent).detail?.conversation_id as string | undefined
      if (convId && chat.activeId === convId) {
        refreshGroupAgents()
      }
    }
    window.addEventListener('realtime:group_members', onGroupMembers)
    return () => window.removeEventListener('realtime:group_members', onGroupMembers)
  }, [chat.activeId, refreshGroupAgents])

  return {
    ...chat,
    groupAgents,
    isGroupMode,
    createGroupConversation,
    addAgentToGroup,
    removeAgentFromGroup,
    sendGroupMessage,
    refreshGroupAgents,
  }
}