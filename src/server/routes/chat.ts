import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import path from 'path'
import fs from 'fs'
import { db } from '../db.js'
import { conversations, messages, groupConversationAgents } from '../schema.js'
import { eq, and, count, sql } from 'drizzle-orm'
import { runPiAgentLoop } from '../ai/pi-adapter.js'
import { orchestrateGroupChat } from '../ai/group-orchestrator.js'
import { generateNeutralFollowUp } from '../ai/neutral-agent.js'
import type { ChatMessage, ContentPart } from '../ai/provider.js'
import type { ServerMessage, Attachment } from '../../shared/types.js'
import { randomUUID } from 'crypto'
import { getConfig, listAgents } from '../config.js'
import { NEUTRAL_AGENT_ID } from '../../shared/constants.js'
import { parseAttachment } from '../files/parser.js'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { SandboxFS } from '../tools/workspace.js'

export const chatRoute = new Hono()

// Global in-memory state for infinite mode control per conversation
// Key: conversationId, Value: { enabled: boolean, messageCount: number }
const infiniteState = new Map<string, { enabled: boolean; messageCount: number }>()

// Apply user auth to all routes
chatRoute.use('*', userAuthMiddleware)

/**
 * POST /api/chat/infinite-mode — Toggle infinite mode on/off for a conversation
 */
chatRoute.post('/infinite-mode', async (c) => {
  const userId = (c as any).get('userId') as string
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<{ conversation_id: string; enabled: boolean }>()
  const { conversation_id, enabled } = body

  if (!conversation_id) return c.json({ error: 'conversation_id required' }, 400)

  // Verify conversation ownership
  const conv = await db.select().from(conversations).where(and(eq(conversations.id, conversation_id), sql`${conversations.deleted_at} IS NULL`)).get()
  if (!conv || conv.user_id !== userId) {
    return c.json({ error: 'Conversation not found or access denied' }, 404)
  }

  if (enabled) {
    // Count existing messages for this conversation
    const result = await db.select({ value: count() }).from(messages)
      .where(eq(messages.conversation_id, conversation_id)).get()
    infiniteState.set(conversation_id, { enabled: true, messageCount: result?.value ?? 0 })
  } else {
    infiniteState.delete(conversation_id)
  }

  return c.json({ success: true, enabled })
})

/**
 * POST /api/chat — SSE streaming chat endpoint.
 * Standard HTTP, no WebSocket needed. Works through any proxy.
 */
chatRoute.post('/', async (c) => {
  const userId = (c as any).get('userId') as string
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const body = await c.req.json<{ message: string; conversation_id?: string; agent_id?: string; _retry?: boolean; thinking_mode?: boolean; attachments?: Array<{ url: string; name: string; size: number; type: string }>; conversation_type?: 'direct' | 'group'; agent_ids?: string[]; infinite_mode?: boolean }>()
  const { message, conversation_id, agent_id, _retry, thinking_mode, attachments, conversation_type, agent_ids, infinite_mode } = body

  if (!message?.trim()) {
    return c.json({ error: 'Empty message' }, 400)
  }

  return streamSSE(c, async (stream) => {
    let aborted = false
    // Hono 的 writeSSE 是异步的；串行化写入并跟踪 pending 写入，
    // 防止流关闭时尾部事件（agent_done / group_done）未 flush 被丢弃。
    let writeChain: Promise<void> = Promise.resolve()
    const send = (msg: ServerMessage) => {
      if (aborted) return
      writeChain = writeChain
        .then(() => stream.writeSSE({ data: JSON.stringify(msg), event: 'message' }))
        .catch((err) => {
          aborted = true
          const isTerminal = msg.type === 'done' || msg.type === 'error'
          if (isTerminal) {
            console.warn('Failed to send terminal event to client:', msg.type, '- stream already closed')
          }
        })
    }

    // Keepalive — prevent proxies/browsers from closing idle SSE
    const keepalive = setInterval(() => {
      if (aborted) { clearInterval(keepalive); return }
      try {
        stream.write(':\n\n')
      } catch {
        aborted = true
        clearInterval(keepalive)
      }
    }, 15_000)

    try {
      // --- Create or get conversation ---
      let convId = conversation_id
      const isGroup = conversation_type === 'group'
      const groupAgentIds = (isGroup && agent_ids && agent_ids.length > 0) ? agent_ids : []

      if (!convId) {
        convId = randomUUID()
        const now = Math.floor(Date.now() / 1000)
        const title = message.slice(0, 40) || 'New Chat'
        await db.insert(conversations).values({
          id: convId, user_id: userId, title,
          agent_id: agent_id || '',
          type: isGroup ? 'group' : 'direct',
          created_at: now, updated_at: now,
        }).run()

        // Insert group agent associations
        if (isGroup && groupAgentIds.length > 0) {
          for (let i = 0; i < groupAgentIds.length; i++) {
            await db.insert(groupConversationAgents).values({
              conversation_id: convId,
              agent_id: groupAgentIds[i],
              sort_order: i,
            }).run()
          }
        }
      } else {
        // Verify conversation belongs to user
        const conv = await db.select().from(conversations).where(and(eq(conversations.id, convId), sql`${conversations.deleted_at} IS NULL`)).get()
        if (!conv || conv.user_id !== userId) {
          send({ type: 'error', message: 'Conversation not found or access denied' })
          return
        }
      }

      // --- Save user message (skip on retry to avoid duplicates) ---
      const now = Math.floor(Date.now() / 1000)
      if (!_retry) {
        await db.insert(messages).values({
          conversation_id: convId,
          role: 'user',
          content: message,
          attachments: attachments ? JSON.stringify(attachments) : null,
          created_at: now,
        }).run()
      }
      await db.update(conversations).set({ updated_at: now }).where(eq(conversations.id, convId)).run()

      // --- Load history (excluding current message) ---
      const historyMsgs = await db
        .select()
        .from(messages)
        .where(eq(messages.conversation_id, convId))
        .orderBy(messages.created_at)
        .all()

      const history: ChatMessage[] = historyMsgs
        .slice(0, -1) // remove current user message
        .map((m) => ({
          role: m.role as ChatMessage['role'],
          content: m.content,
          tool_calls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
          tool_call_id: m.tool_call_id || undefined,
          agent_id: m.agent_id || null,
        }))

      // --- Tell client the conversation ID ---
      send({ type: 'conversation_id', id: convId })

      // --- Parse attachments and build user message ---
      let userMessage: string | ContentPart[] = message
      const DOC_EXTS = ['.docx', '.pptx', '.xlsx', '.xls', '.pdf']

      if (attachments && attachments.length > 0) {
        const textParts: string[] = []
        const imageParts: ContentPart[] = []

        // Copy document attachments to workspace for tool access
        const workspace = new SandboxFS(convId)
        for (const att of attachments) {
          const filename = att.url.split('/').pop() || ''
          const srcPath = path.join('uploads', filename)
          const ext = path.extname(att.name).toLowerCase()

          if (DOC_EXTS.includes(ext) && fs.existsSync(srcPath)) {
            try {
              await workspace.copyIn(srcPath, att.name)
            } catch (err) {
              console.warn(`Failed to copy ${att.name} to workspace:`, (err as Error).message)
            }
          }
        }

        for (const att of attachments) {
          // Map URL to disk path: extract filename from URL
          // Supports both /uploads/xxx and /api/upload/file/xxx
          const filename = att.url.split('/').pop() || ''
          const diskPath = path.join('uploads', filename)
          if (!fs.existsSync(diskPath)) {
            textParts.push(`[附件 ${att.name}: 文件未找到]`)
            continue
          }

          try {
            const parsed = await parseAttachment(diskPath, att.name, att.type)

            if (parsed.kind === 'image') {
              imageParts.push({ type: 'image_url', image_url: { url: parsed.base64! } })
              textParts.push(`[图片: ${att.name}]`)
            } else if (parsed.kind === 'text') {
              textParts.push(`\n--- 附件: ${att.name} ---\n${parsed.content}\n---`)
            } else {
              textParts.push(parsed.content)
            }
          } catch (err) {
            textParts.push(`[附件 ${att.name}: 解析失败 - ${(err as Error).message}]`)
          }
        }

        // Build the message to send to the model
        if (imageParts.length > 0) {
          // Multimodal: text + images
          const content: ContentPart[] = [{ type: 'text', text: message + textParts.join('\n') }, ...imageParts]
          userMessage = content
        } else {
          // Text-only
          userMessage = message + textParts.join('\n')
        }
      }

      // --- Run AI loop (with infinite mode support) ---
      const isInfinite = infinite_mode === true
      const MAX_INFINITE_MESSAGES = 500

      // Initialize infinite state if enabled
      if (isInfinite) {
        const existing = await db.select({ value: count() }).from(messages)
          .where(eq(messages.conversation_id, convId)).get()
        infiniteState.set(convId, { enabled: true, messageCount: existing?.value ?? 0 })
      }

      // Helper: save assistant message to DB
      const saveAssistantMsg = async (content: string, thinking: string | null, suggestionsList: string[], artifactsLocal?: Array<{ filename: string; displayName: string; mimeType: string; downloadUrl: string }>, agentId?: string) => {
        const replyNow = Math.floor(Date.now() / 1000)
        let msgAttachments: string | null = null
        if (artifactsLocal && artifactsLocal.length > 0) {
          msgAttachments = JSON.stringify(artifactsLocal.map((a) => ({
            url: a.downloadUrl, name: a.displayName, size: 0, type: a.mimeType,
          })))
        }
        await db.insert(messages).values({
          conversation_id: convId,
          role: 'assistant',
          content,
          thinking: thinking || null,
          suggestions: suggestionsList.length > 0 ? JSON.stringify(suggestionsList) : null,
          attachments: msgAttachments,
          agent_id: agentId || null,
          created_at: replyNow,
        }).run()
      }

      // Helper: generate follow-up and save as user message
      const generateAndSaveFollowUp = async (): Promise<string> => {
        // Send follow_up_start first so client creates a placeholder bubble
        send({ type: 'follow_up_start' })

        const allMsgs = await db.select().from(messages)
          .where(eq(messages.conversation_id, convId))
          .orderBy(messages.created_at).all()
        const agents = await listAgents()
        const agentNameById = new Map(agents.map((a) => [a.id, a.name]))
        const context = allMsgs.slice(-20).map((m) =>
          m.role === 'user' ? `用户: ${m.content}` : `[${m.agent_id ? (agentNameById.get(m.agent_id) || m.agent_id) : '助手'}]: ${m.content}`
        ).join('\n')

        const config = await getConfig()
        const neutralAgent = agents.find((a) => a.id === NEUTRAL_AGENT_ID)
        const model = neutralAgent?.model || agents[0]?.model || 'gpt-4o'
        const extraPrompt = neutralAgent?.system_prompt?.trim() || undefined
        const followUp = await generateNeutralFollowUp(config, model, context, extraPrompt)
        const text = followUp || '（继续）'
        send({ type: 'follow_up', text })
        const nowF = Math.floor(Date.now() / 1000)
        await db.insert(messages).values({
          conversation_id: convId, role: 'user', content: text, created_at: nowF,
        }).run()
        return text
      }

      // Helper: reload history from DB
      const reloadHistory = async (): Promise<ChatMessage[]> => {
        const allMsgs = await db.select().from(messages)
          .where(eq(messages.conversation_id, convId))
          .orderBy(messages.created_at).all()
        return allMsgs.slice(0, -1).map((m) => ({
          role: m.role as ChatMessage['role'],
          content: m.content,
          tool_calls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
          tool_call_id: m.tool_call_id || undefined,
          agent_id: m.agent_id || null,
        }))
      }

      // Helper: check if infinite mode should continue
      const checkInfinite = (): boolean => {
        const state = infiniteState.get(convId)
        if (!state || !state.enabled) return false
        if (state.messageCount >= MAX_INFINITE_MESSAGES) {
          infiniteState.delete(convId)
          return false
        }
        return true
      }

      let currentHistory = history
      let currentPrompt: string | ContentPart[] = userMessage

      // First iteration always runs (even without infinite mode)
      if (isGroup && groupAgentIds.length > 0) {
        await orchestrateGroupChat({
          userMessage: currentPrompt,
          history: currentHistory,
          send,
          signal: undefined,
          thinkingMode: thinking_mode !== false,
          conversationId: convId,
          userId,
          agentIds: groupAgentIds,
          saveMessage: async (agentId, agentName, reply, thinking, suggestions, artifacts) => {
            await saveAssistantMsg(reply, thinking, suggestions, artifacts, agentId)
          },
        })
      } else {
        const { reply, suggestions, thinking, artifacts } = await runPiAgentLoop(
          currentPrompt, currentHistory, send, undefined,
          thinking_mode !== false, convId, userId,
          agent_id || undefined,
          undefined, false, isInfinite,
        )
        if (reply) {
          await saveAssistantMsg(reply, thinking, suggestions, artifacts)
        }
      }

      // Infinite loop: continue while state says so
      while (isInfinite && checkInfinite()) {
        if (aborted) break

        // Increment message count
        const state = infiniteState.get(convId)
        if (state) state.messageCount++

        const followUp = await generateAndSaveFollowUp()

        currentHistory = await reloadHistory()
        currentPrompt = followUp

        if (isGroup && groupAgentIds.length > 0) {
          await orchestrateGroupChat({
            userMessage: currentPrompt,
            history: currentHistory,
            send,
            signal: undefined,
            thinkingMode: thinking_mode !== false,
            conversationId: convId,
            userId,
            agentIds: groupAgentIds,
            saveMessage: async (agentId, agentName, reply, thinking, suggestions, artifacts) => {
              await saveAssistantMsg(reply, thinking, suggestions, artifacts, agentId)
            },
          })
        } else {
          const { reply, suggestions, thinking, artifacts } = await runPiAgentLoop(
            currentPrompt, currentHistory, send, undefined,
            thinking_mode !== false, convId, userId,
            agent_id || undefined,
            undefined, false, isInfinite,
          )
          if (reply) {
            await saveAssistantMsg(reply, thinking, suggestions, artifacts)
          } else {
            // Agent returned empty reply — stop
            infiniteState.delete(convId)
            break
          }
        }
      }

      // Clean up infinite state
      if (infiniteState.get(convId)) {
        send({ type: 'infinite_mode_off' })
      }
      infiniteState.delete(convId)
    } catch (err) {
      // Catch-all: guarantee the client always receives a terminal event
      const errMsg = err instanceof Error ? err.message : 'Internal server error'
      console.error('Chat handler error:', errMsg)
      send({ type: 'error', message: errMsg })
    } finally {
      clearInterval(keepalive)
      // 等待所有 SSE 事件真正 flush 到响应流，再让 Hono 关闭连接
      await writeChain
    }
  })
})
