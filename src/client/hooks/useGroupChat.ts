// ============================================================
// useGroupChat — Group chat state management
// Composes useChat with group-specific state and methods
// ============================================================

import { useState, useCallback, useEffect } from 'react'
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

  // Load all available agents on mount
  useEffect(() => {
    api.getAppName().then((r) => {
      setAllAgents(r.agents || [])
    }).catch(console.error)
  }, [])

  // When switching conversations, detect group mode and load agents
  useEffect(() => {
    if (chat.activeId) {
      api.getConversation(chat.activeId).then((res) => {
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
      }).catch(console.error)
    } else if (chat.draftType === 'group') {
      // 群聊草稿态（activeId 为 null）：保持群聊模式与已选成员，等待首条消息
      setIsGroupMode(true)
    } else {
      setIsGroupMode(false)
      setGroupAgents([])
    }
  }, [chat.activeId, chat.draftType])

  // Override selectConversation to set group mode BEFORE messages are rendered
  const selectConversation = useCallback(async (id: string) => {
    // Pre-fetch to determine group mode before loading messages
    try {
      const res = await api.getConversation(id)
      const conv = res.conversation as Conversation
      if (conv.type === 'group') {
        setIsGroupMode(true)
        if (res.agents) setGroupAgents(res.agents)
      } else {
        setIsGroupMode(false)
        setGroupAgents([])
      }
    } catch {
      setIsGroupMode(false)
      setGroupAgents([])
    }
    // Load messages (this will trigger a second API call, but ensures correct state)
    await chat.selectConversation(id)
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