import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { api, getUser, getToken } from '../lib/api'
import type { Conversation, Attachment } from '@/shared/types'
import type { ThinkingSegment } from '@/shared/thinking'
import { decodeThinkingToSegments, thinkingSegmentHeader } from '@/shared/thinking'

interface ChatMessage {
  id?: number
  role: 'user' | 'assistant'
  content: string
  /** 兼容字段：DB 里存的是含分隔符的纯文本；历史消息用它。 */
  thinking?: string
  /** 结构化分块：按工具轮 round 分组。优先于 thinking 渲染。 */
  thinkingSegments?: ThinkingSegment[]
  toolCalls?: Array<{ id?: string; name: string; input: Record<string, unknown>; status?: 'running' | 'done' | 'error'; result?: string; artifacts?: Array<{ filename: string; displayName: string; mimeType: string; downloadUrl: string }> }>
  suggestions?: string[]
  attachments?: Attachment[]
  streaming?: boolean
  created_at?: string
  /** Group chat: which agent sent this message */
  agent_id?: string | null
  /** Group chat: agent display name */
  agent_name?: string | null
}

const MAX_RETRIES = 3
const RETRY_BASE_MS = 2000

export function useChat() {
  const { t } = useTranslation()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const infiniteModeRef = useRef(false)

  // Load conversations on mount
  useEffect(() => {
    api.listConversations()
      .then((res) => setConversations(res.conversations))
      .catch(console.error)
  }, [])

  // Restore conversation from URL hash on mount (#/c/{id})
  useEffect(() => {
    const match = window.location.hash.match(/^#\/c\/(.+)$/)
    if (!match) return
    const id = decodeURIComponent(match[1])
    api.getConversation(id)
      .then((res) => {
        setActiveId(id)
        setMessages(
          res.messages.map((m) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: m.content,
            thinking: m.thinking || undefined,
            thinkingSegments: decodeThinkingToSegments(m.thinking),
            toolCalls: m.tool_calls as any || undefined,
            suggestions: m.suggestions as any || undefined,
            attachments: m.attachments as any || undefined,
            agent_id: m.agent_id ?? null,
          }))
        )
      })
      .catch((err) => {
        // Access denied or not found — clear hash, stay on initial page
        console.error('Failed to restore conversation from URL:', err)
        history.replaceState(null, '', window.location.pathname + window.location.search)
      })
  }, [])

  // Sync active conversation when URL hash changes (browser back/forward)
  useEffect(() => {
    const onHashChange = () => {
      const match = window.location.hash.match(/^#\/c\/(.+)$/)
      const id = match ? decodeURIComponent(match[1]) : null
      if (!id) {
        setActiveId(null)
        setMessages([])
        return
      }
      api.getConversation(id)
        .then((res) => {
          setActiveId(id)
          setMessages(
            res.messages.map((m) => ({
              id: m.id,
              role: m.role as 'user' | 'assistant',
              content: m.content,
              thinking: m.thinking || undefined,
              thinkingSegments: decodeThinkingToSegments(m.thinking),
              toolCalls: m.tool_calls as any || undefined,
              suggestions: m.suggestions as any || undefined,
              attachments: m.attachments as any || undefined,
              agent_id: m.agent_id ?? null,
            }))
          )
        })
        .catch(() => {
          history.replaceState(null, '', window.location.pathname + window.location.search)
        })
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const refreshConversations = useCallback(() => {
    api.listConversations()
      .then((res) => setConversations(res.conversations))
      .catch(console.error)
  }, [])

  const updateLastMessage = useCallback((patch: Partial<ChatMessage>) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant') return prev
      return [...prev.slice(0, -1), { ...last, ...patch }]
    })
  }, [])

  const sendMessage = useCallback(async (text: string, thinkingMode = true, attachments?: Array<{ url: string; name: string; size: number; type: string }>, agentId?: string | null, groupMode?: boolean, groupAgentIds?: string[], infiniteMode?: boolean) => {
    if (!text.trim() || loading) return

    const userMsg: ChatMessage = { role: 'user', content: text, attachments }
    const assistantMsg: ChatMessage = { role: 'assistant', content: '', streaming: true, thinkingSegments: [] }
    setMessages((prev) => [...prev, userMsg, ...(groupMode ? [] : [assistantMsg])])
    setLoading(true)
    infiniteModeRef.current = infiniteMode || false

    const abort = new AbortController()
    abortRef.current = abort

    let convId = activeId
    let attempt = 0
    let done = false

    while (attempt <= MAX_RETRIES && !done) {
      const isRetry = attempt > 0

      if (isRetry) {
        updateLastMessage({ content: '', streaming: true })
        const delay = Math.min(RETRY_BASE_MS * Math.pow(2, attempt - 1), 10_000)
        await new Promise((r) => setTimeout(r, delay))
        if (abort.signal.aborted) break
      }

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User': encodeURIComponent(getUser() || ''),
            'Authorization': `Bearer ${getToken() || ''}`
          },
          body: JSON.stringify({
            message: text,
            conversation_id: convId || undefined,
            agent_id: agentId || undefined,
            _retry: isRetry,
            thinking_mode: thinkingMode,
            attachments: attachments || undefined,
            conversation_type: groupMode ? 'group' : undefined,
            agent_ids: groupMode && groupAgentIds ? groupAgentIds : undefined,
            infinite_mode: infiniteMode || undefined,
          }),
          signal: abort.signal,
        })

        if (!res.ok) {
          if (res.status === 401) {
            localStorage.removeItem('user')
            localStorage.removeItem('token')
            window.dispatchEvent(new CustomEvent('auth:expired'))
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
          idleTimer = setTimeout(() => abort.abort(), IDLE_TIMEOUT)
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
                if (msg.type === 'conversation_id') convId = msg.id
                if (msg.type === 'token') receivedTokens = true
                if (msg.type === 'done' || msg.type === 'error') receivedDone = true
                handleSSEEvent(msg)
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
              updateLastMessage({ streaming: false })
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
        const isUserCancel = isAbort && attempt === 0 && abortRef.current !== abort

        if (isUserCancel) {
          // User explicitly cancelled
          updateLastMessage({ streaming: false })
          done = true
        } else if (isAbort) {
          // Idle timeout or connection drop — retry
          if (attempt >= MAX_RETRIES) {
            updateLastMessage({ content: t('chat.errorMessage', { message: t('chat.connectionTimeout') }), streaming: false })
            done = true
          }
          // else: loop continues
        } else if (attempt >= MAX_RETRIES) {
          console.error('Chat error:', err)
          updateLastMessage({ content: t('chat.errorMessage', { message: (err as Error).message }), streaming: false })
          done = true
        }
        // Non-fatal network error — retry
      }

      attempt++
    }

    setLoading(false)
    abortRef.current = null
    refreshConversations()

    // Re-fetch messages from server to get real IDs for locally-created messages.
    // 竞态守卫：done 已提前结束 loading，用户可能在流关闭前抢发了新消息（本地流式
    // 气泡已存在）——此时 abortRef 已被新一轮覆盖，跳过全量 refetch，避免抹掉新气泡。
    if (convId && abortRef.current === abort) {
      try {
        const res = await api.getConversation(convId)
        setMessages(
          res.messages.map((m) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: m.content,
            thinking: m.thinking || undefined,
            thinkingSegments: decodeThinkingToSegments(m.thinking),
            toolCalls: m.tool_calls as any || undefined,
            suggestions: m.suggestions as any || undefined,
            attachments: m.attachments as any || undefined,
            agent_id: m.agent_id ?? null,
          }))
        )
      } catch {
        // Non-fatal — messages stay without IDs, revert buttons won't show on them
      }
    }

    // Safety net: ensure streaming is cleared
    setMessages((prev) => {
      const last = prev[prev.length - 1]
      if (!last || last.role !== 'assistant' || !last.streaming) return prev
      return [...prev.slice(0, -1), { ...last, streaming: false }]
    })
  }, [activeId, loading, updateLastMessage, refreshConversations, t])

  function handleSSEEvent(msg: any) {
    switch (msg.type) {
      case 'conversation_id':
        setActiveId(msg.id)
        // First message creates a new conversation — push its id to hash
        if (msg.id) {
          const newHash = `#/c/${encodeURIComponent(msg.id)}`
          if (window.location.hash !== newHash) {
            history.replaceState(null, '', newHash)
          }
        }
        break

      case 'token':
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          return [...prev.slice(0, -1), { ...last, content: last.content + msg.text }]
        })
        break

      case 'thinking': {
        // 「唯一事实源」：thinking 纯文本（即服务端下发序列，含分隔符）作为真源，
        // thinkingSegments 每次都从它派生（同一套 decode 也用于历史加载）。
        const segRound = typeof msg.round === 'number' ? msg.round : undefined
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          const newThinking = (last.thinking || '') + msg.text
          // 是否为本轮第一条 thinking（服务端会在每轮首个 thinking 前先下发分隔符事件）
          const isSegmentHeader = typeof segRound === 'number' && msg.text === thinkingSegmentHeader(segRound)
          let segments = last.thinkingSegments || []
          if (isSegmentHeader) {
            segments = [...segments, { round: segRound, text: '' }]
          } else if (segments.length === 0) {
            segments = [{ round: 0, text: msg.text }]
          } else {
            const updated = [...segments]
            updated[updated.length - 1] = { ...updated[updated.length - 1], text: updated[updated.length - 1].text + msg.text }
            segments = updated
          }
          return [...prev.slice(0, -1), { ...last, thinking: newThinking, thinkingSegments: segments }]
        })
        break
      }

      case 'tool_call':
      case 'tool_execution_start':
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          return [...prev.slice(0, -1), {
            ...last,
            toolCalls: [...(last.toolCalls || []), { id: msg.id, name: msg.name, input: msg.input, status: 'running' }],
          }]
        })
        break

      case 'tool_result':
        setMessages((prev) => {
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
          calls[idx] = {
            ...calls[idx],
            status: msg.summary?.startsWith('Tool error') || msg.summary?.startsWith('BLOCKED') ? 'error' : 'done',
            result: msg.summary,
            artifacts: msg.artifacts || calls[idx].artifacts,
          }
          return [...prev.slice(0, -1), { ...last, toolCalls: calls }]
        })
        break

      case 'done':
        // 单聊对齐 group_done：收到 done 即结束 loading
        // （连接可能还要保持打开，等待中立 Agent 补发 suggestions）
        if (!infiniteModeRef.current) {
          setLoading(false)
        }
        setMessages((prev) => {
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
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          return [...prev.slice(0, -1), { ...last, content: t('chat.errorMessage', { message: msg.message }), streaming: false }]
        })
        break

      // --- Group Chat Events ---
      case 'agent_start':
        // Start a new agent message bubble in group chat
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: '',
            streaming: true,
            agent_id: msg.agent_id,
            agent_name: msg.agent_name,
            thinkingSegments: [],
          },
        ])
        break

      case 'agent_done':
        // Mark this agent's message as complete
        setMessages((prev) => {
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
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (!last || last.role !== 'assistant') return prev
          if (msg.agent_id && last.agent_id && last.agent_id !== msg.agent_id) return prev
          return [...prev.slice(0, -1), { ...last, suggestions: msg.suggestions }]
        })
        break

      case 'group_done':
        if (!infiniteModeRef.current) {
          setLoading(false)
        }
        break

      case 'infinite_mode_off':
        // Server-side infinite mode ended (user turned off or hit 500 limit)
        setLoading(false)
        break

      case 'follow_up_start':
        // Infinite mode: neutral agent is about to generate a follow-up
        // Create a placeholder user message bubble with loading animation
        setMessages((prev) => [
          ...prev,
          { role: 'user' as const, content: '', streaming: true },
        ])
        break

      case 'follow_up':
        // Infinite mode: neutral agent generated a follow-up question
        // Replace the placeholder user message with actual content
        setMessages((prev) => {
          const isGroupChat = prev.some((m) => m.agent_id)
          // Find the last user message (the placeholder) and replace its content
          const updated = [...prev]
          for (let i = updated.length - 1; i >= 0; i--) {
            if (updated[i].role === 'user') {
              updated[i] = { ...updated[i], content: msg.text, streaming: false }
              break
            }
          }
          // For direct chat: also create the streaming assistant bubble
          if (!isGroupChat) {
            updated.push({ role: 'assistant' as const, content: '', streaming: true, thinkingSegments: [] })
          }
          return updated
        })
        break
    }
  }

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setLoading(false)
  }, [])

  const selectConversation = useCallback(async (id: string) => {
    try {
      const res = await api.getConversation(id)
      setActiveId(id)
      // Sync URL hash
      const newHash = `#/c/${encodeURIComponent(id)}`
      if (window.location.hash !== newHash) {
        history.pushState(null, '', newHash)
      }
      setMessages(
        res.messages.map((m) => ({
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content: m.content,
          thinking: m.thinking || undefined,
          toolCalls: m.tool_calls as any || undefined,
          suggestions: m.suggestions as any || undefined,
          attachments: m.attachments as any || undefined,
          agent_id: m.agent_id ?? null,
        }))
      )
    } catch (err) {
      console.error('Failed to load conversation:', err)
      // Access denied — clear hash, return to initial page
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [])

  const createConversation = useCallback(() => {
    setActiveId(null)
    setMessages([])
    // Clear hash
    if (window.location.hash) {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [])

  const deleteConversation = useCallback(async (id: string) => {
    try {
      await api.deleteConversation(id)
      setConversations((prev) => prev.filter((c) => c.id !== id))
      if (activeId === id) {
        setActiveId(null)
        setMessages([])
        // Clear hash since we deleted the active conversation
        if (window.location.hash) {
          history.replaceState(null, '', window.location.pathname + window.location.search)
        }
      }
    } catch (err) {
      console.error('Failed to delete conversation:', err)
    }
  }, [activeId])

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
      const agentMap = new Map<string, string>()
      if (res.agents) {
        res.agents.forEach((a) => agentMap.set(a.id, a.name))
      }
      const lines = res.messages.map((m) => {
        const time = m.created_at ? new Date(m.created_at * 1000).toLocaleString() : ''
        const header = time ? `### ${m.role === 'user' ? 'User' : m.role === 'system' ? 'System' : m.role === 'tool' ? 'Tool' : (m.agent_id && agentMap.get(m.agent_id)) || 'Assistant'} — ${time}` : `### ${m.role === 'user' ? 'User' : m.role === 'system' ? 'System' : m.role === 'tool' ? 'Tool' : (m.agent_id && agentMap.get(m.agent_id)) || 'Assistant'}`
        return `${header}\n${m.content}`
      })
      const title = res.conversation.title || 'conversation'
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
  }, [])

  const revertMessage = useCallback(async (index: number) => {
    if (!activeId) return null

    const message = messages[index]
    if (!message || !message.id) return null

    try {
      // Delete messages from server (this message and all subsequent)
      await api.revertMessages(activeId, message.id)

      // Update local state - remove this message and all after it
      setMessages((prev) => prev.slice(0, index))

      return message.content
    } catch (err) {
      console.error('Failed to revert message:', err)
      return null
    }
  }, [activeId, messages])

  return {
    conversations,
    activeId,
    messages,
    loading,
    sendMessage,
    selectConversation,
    createConversation,
    renameConversation,
    deleteConversation,
    exportConversation,
    refreshConversations,
    cancel,
    revertMessage,
  }
}
