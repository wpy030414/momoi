import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import path from 'path'
import fs from 'fs'
import { db, conversations, messages, groupConversationAgents } from '../db/index.js'
import { eq, and, count, sql, desc } from 'drizzle-orm'
import { runPiAgentLoop } from '../ai/pi-adapter.js'
import { orchestrateGroupChat } from '../ai/group-orchestrator.js'
import { generateNeutralFollowUp, generateNeutralSuggestions } from '../ai/neutral-agent.js'
import type { ChatMessage, ContentPart } from '../ai/provider.js'
import type { ServerMessage, Attachment, TraceEntry } from '@momoi/shared/types'
import { randomUUID } from 'crypto'
import { getConfig, listAgents, getAgent } from '../lib/config.js'
import { NEUTRAL_AGENT_ID } from '@momoi/shared/constants'
import { resolveQuestion, getPendingQuestion } from '../tools/ask-user-tool.js'
import { parseAttachment } from '../files/parser.js'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { SandboxFS } from '../tools/workspace.js'
import { synthesizeAndSave, markVoiceComplete, createTtsProvider } from '../ai/tts.js'
import { broadcastStream, broadcastConversationSync, broadcastUnreadUpdate } from '../lib/realtime.js'
import { countUnread } from '../lib/unread.js'
import { trackUserActivity } from './user.js'

export const chatRoute = new Hono()

// 构建中立 Agent 上下文：最近 20 条消息，用户/Agent 名字标注（follow_up 与 suggestions 共用）
async function buildNeutralContext(convId: string): Promise<string> {
  // Fetch only the last 20 messages at the DB level — avoids loading thousands of
  // rows into memory only to discard all but 20 in JS.
  const recentMsgs = await db.select().from(messages)
    .where(eq(messages.conversation_id, convId))
    .orderBy(desc(messages.created_at))
    .limit(20)
    .all()
  const orderedMsgs = recentMsgs.reverse()
  const agents = await listAgents()
  const agentNameById = new Map(agents.map((a) => [a.id, a.name]))
  return orderedMsgs.map((m: typeof messages.$inferSelect) =>
    m.role === 'user' ? `用户: ${m.content}` : `[${m.agent_id ? (agentNameById.get(m.agent_id) || m.agent_id) : '助手'}]: ${m.content}`
  ).join('\n')
}

// Global in-memory state for infinite mode control per conversation
// Key: conversationId, Value: { enabled: boolean, messageCount: number }
const infiniteState = new Map<string, { enabled: boolean; messageCount: number }>()

/** Parse a workspace file URL: /api/workspace/{convId}/file/__uploads__/{filename} */
function parseWorkspaceUrl(url: string): { workspaceId: string; wsPath: string } | null {
  const parts = url.split('/')
  const fileIdx = parts.indexOf('file')
  if (fileIdx < 2) return null
  if (parts[fileIdx - 1] !== '__uploads__') return null
  const workspaceId = parts[fileIdx - 3]
  if (!workspaceId) return null
  const filename = parts.slice(fileIdx + 1).join('/')
  if (!filename) return null
  return { workspaceId, wsPath: `__uploads__/${filename}` }
}

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

  const body = await c.req.json<{ message: string; conversation_id?: string; agent_id?: string; _retry?: boolean; _force_compliance?: boolean; thinking_mode?: boolean; attachments?: Array<{ url: string; name: string; size: number; type: string }>; conversation_type?: 'direct' | 'group' | 'world'; agent_ids?: string[]; infinite_mode?: boolean; language?: string; device_id?: string }>()
  const { message, conversation_id, _retry, _force_compliance, thinking_mode, attachments, conversation_type, agent_ids, infinite_mode, language, device_id } = body
  const requestedAgentId = body.agent_id

  // 世界模拟的回合引擎尚未接入（Phase 2）。此处显式拒绝，而不是让它落进单聊路径 ——
  // 那会把消息气泡塞进世界会话，制造一个语义上自相矛盾的状态。
  if ((conversation_type as string | undefined) === 'world') {
    return c.json({ error: 'World simulation turns are not supported yet' }, 400)
  }
  // 本轮实际采用的 Agent：新建会话取请求 agent_id；已有单聊会话锚定到
  // conversations.agent_id（见下方归属校验分支）。
  let agentId: string | undefined = requestedAgentId

  if (!message?.trim()) {
    return c.json({ error: 'Empty message' }, 400)
  }

  return streamSSE(c, async (stream) => {
    let aborted = false
    // Hono 的 writeSSE 是异步的；串行化写入并跟踪 pending 写入，
    // 防止流关闭时尾部事件（agent_done / group_done）未 flush 被丢弃。
    let writeChain: Promise<void> = Promise.resolve()
    // 已确认的会话 ID：conversation_id 事件到达后，向同账号其他设备实时
    // 中继本轮流事件（源设备跳过，直接消费 fetch 流）。
    let streamConvId: string | null = null
    const send = (msg: ServerMessage) => {
      if (aborted) return
      // 实时中继：token/thinking 类高频事件走缓冲批量转发，终端事件立即转发。
      if (streamConvId && msg.type !== 'conversation_id' && msg.type !== 'user_message_id') {
        if (msg.type === 'token' || msg.type === 'thinking') {
          relayToken(msg)
        } else {
          // terminal / high-level events: broadcast immediately
          broadcastStream(userId, device_id || '', {
            conversation_id: streamConvId,
            event: msg,
          })
        }
      }
      // Pre-serialize outside the chain so the main loop isn't blocked waiting
      // for the previous SSE write to complete before it can start serializing.
      const data = JSON.stringify(msg)
      writeChain = writeChain
        .then(() => stream.writeSSE({ data, event: 'message' }))
        .catch((err) => {
          aborted = true
          const isTerminal = msg.type === 'done' || msg.type === 'error'
          if (isTerminal) {
            console.warn('Failed to send terminal event to client:', msg.type, '- stream already closed')
          }
        })
    }

    // Batched token relay: accumulate token/thinking events and flush periodically
    // to avoid per-token broadcast overhead (50-100/s → ~5/s with no user-visible
    // degradation on other devices).
    let tokenBuf = ''
    let relayTimer: ReturnType<typeof setTimeout> | null = null
    const flushRelay = () => {
      if (!tokenBuf || !streamConvId || aborted) { tokenBuf = ''; return }
      broadcastStream(userId, device_id || '', {
        conversation_id: streamConvId,
        event: { type: 'content_snapshot', content: tokenBuf },
      })
      tokenBuf = ''
    }
    const relayToken = (msg: ServerMessage) => {
      const chunk = msg.type === 'token' ? (msg as any).text : ((msg as any).text || '')
      tokenBuf += chunk
      if (tokenBuf.length >= 80) {
        if (relayTimer) clearTimeout(relayTimer)
        flushRelay()
      } else {
        if (relayTimer) clearTimeout(relayTimer)
        relayTimer = setTimeout(flushRelay, 200)
      }
    }

    // Keepalive — prevent proxies/browsers from closing idle SSE
    const keepalive = setInterval(() => {
      if (aborted) { clearInterval(keepalive); return }
      writeChain = writeChain
        .then(() => { if (!aborted) try { stream.write(':\n\n') } catch { aborted = true; clearInterval(keepalive) } })
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
          agent_id: agentId || '',
          type: isGroup ? 'group' : 'direct',
          created_at: now, updated_at: now,
        }).run()

        // 新会话由「首条消息」创建 —— 同账号其他设备侧边栏需实时出现该记录
        broadcastConversationSync(userId)

        // Insert group agent associations
        if (isGroup && groupAgentIds.length > 0) {
          // Batch insert instead of N individual queries
          const rows = groupAgentIds.map((aid, idx) => ({
            conversation_id: convId,
            agent_id: aid,
            sort_order: idx,
          }))
          await db.insert(groupConversationAgents).values(rows).run()
        }
      } else {
        // Verify conversation belongs to user
        const conv = await db.select().from(conversations).where(and(eq(conversations.id, convId), sql`${conversations.deleted_at} IS NULL`)).get()
        if (!conv || conv.user_id !== userId) {
          send({ type: 'error', message: 'Conversation not found or access denied' })
          return
        }
        // 单聊 Agent 锚定：已有会话的发言 Agent 以 conversations.agent_id 为准，
        // 不信任请求携带的 agent_id——客户端下拉状态与当前会话脱钩，后台增删
        // Agent 触发列表刷新后会被重置（如 agents[0]），导致"换人回答"的身份
        // 漂移。请求 agent_id 仅在会话尚无归属记录（legacy / 附件预创建会话）时
        // 采纳，并回写 conversations.agent_id 完成锚定。群聊成员由
        // group_conversation_agents 管理，不在此处理。
        if (!isGroup) {
          if (conv.agent_id) {
            agentId = conv.agent_id
          } else if (agentId) {
            await db.update(conversations).set({ agent_id: agentId }).where(eq(conversations.id, convId)).run()
          }
        }
      }

      // --- Save user message (skip on retry to avoid duplicates) ---
      const now = Math.floor(Date.now() / 1000)
      if (!_retry) {
        const result = await db.insert(messages).values({
          conversation_id: convId,
          role: 'user',
          content: message,
          attachments: attachments ? JSON.stringify(attachments) : null,
          created_at: now,
        }).returning({ id: messages.id })
        const userMsgId = Number(result[0]?.id ?? 0)
        if (userMsgId > 0) {
          send({ type: 'user_message_id', id: userMsgId })
        }
        // 实时中继：他设备需要用户消息内容来渲染用户气泡（源设备本地已有，跳过）
        streamConvId = convId
        broadcastStream(userId, device_id || '', {
          conversation_id: convId,
          event: { type: 'user_message', id: userMsgId, content: message, attachments },
        })
        trackUserActivity(userId).catch(() => {})
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
        .map((m: typeof messages.$inferSelect) => ({
          role: m.role as ChatMessage['role'],
          content: m.content,
          tool_calls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
          tool_call_id: m.tool_call_id || undefined,
          agent_id: m.agent_id || null,
          created_at: m.created_at,
        }))

      // 计算 Agent 上次发言时间（最近一条属于该 Agent 的 assistant 消息的 created_at）
      const lastAgentMsg = historyMsgs
        .slice(0, -1)
        .filter((m: typeof messages.$inferSelect) => m.role === 'assistant' && m.agent_id === agentId)
        .at(-1)
      const lastMessageAt = lastAgentMsg?.created_at

      // --- Tell client the conversation ID ---
      streamConvId = convId
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
          const wsUrl = (att as any).workspace_url || att.url
          const parsed = parseWorkspaceUrl(wsUrl)
          if (!parsed) continue
          const ext = path.extname(att.name).toLowerCase()

          if (DOC_EXTS.includes(ext)) {
            const sourceWs = new SandboxFS(parsed.workspaceId)
            try {
              if (await sourceWs.exists(parsed.wsPath)) {
                await workspace.copyIn(sourceWs.resolve(parsed.wsPath), att.name)
              }
            } catch (err) {
              console.warn(`Failed to copy ${att.name} to workspace:`, (err as Error).message)
            }
          }
        }

        for (const att of attachments) {
          // Prefer workspace_url (CDN mode) for AI image reading, fall back to url
          const wsUrl = (att as any).workspace_url || att.url
          const parsed = parseWorkspaceUrl(wsUrl)
          if (!parsed) {
            textParts.push(`[附件 ${att.name}: 文件未找到]`)
            continue
          }

          const sourceWs = new SandboxFS(parsed.workspaceId)
          const exists = await sourceWs.exists(parsed.wsPath)
          if (!exists) {
            textParts.push(`[附件 ${att.name}: 文件未找到]`)
            continue
          }

          try {
            const diskPath = sourceWs.resolve(parsed.wsPath)
            const parsedResult = await parseAttachment(diskPath, att.name, att.type)

            if (parsedResult.kind === 'image') {
              imageParts.push({ type: 'image_url', image_url: { url: parsedResult.base64! } })
              textParts.push(`[图片: ${att.name}]`)
            } else if (parsedResult.kind === 'text') {
              textParts.push(`\n--- 附件: ${att.name} ---\n${parsedResult.content}\n---`)
            } else {
              textParts.push(parsedResult.content)
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

      // --- Voice: check if agent has voice enabled ---
      const voiceAgent = agentId ? await getAgent(agentId) : null
      const voiceEnabled = voiceAgent?.voice_enabled === true
      const voiceSettingsRaw = voiceEnabled ? (() => {
        try { return JSON.parse(voiceAgent!.voice_settings) } catch { return {} }
      })() : null
      const voiceSpeakerId: string | undefined = voiceSettingsRaw?.speakerId

      // 跨会话记忆的加载已下沉进 runPiAgentLoop（所有渠道共用，且与工具执行时的 Agent 身份一致）

      // Sentence boundary detection for voice
      const SENTENCE_BOUNDARY_RE = /[。！？.!?\n]/

      /** Split a full reply text into sentences for TTS. */
      function splitSentences(text: string): string[] {
        const result: string[] = []
        let buf = ''
        for (const ch of text) {
          buf += ch
          if (SENTENCE_BOUNDARY_RE.test(ch) || buf.length >= 40) {
            result.push(buf.trim())
            buf = ''
          }
        }
        if (buf.trim()) result.push(buf.trim())
        return result.filter(s => s.length > 0)
      }

      /** Fire async TTS for each sentence of a reply, sending voice_segment events. */
      async function synthesizeReplyVoice(agentIdForVoice: string, messageId: number, replyText: string) {
        if (!voiceEnabled || !voiceSpeakerId) return
        const sentences = splitSentences(replyText)
        if (sentences.length === 0) return

        let ttsConfig: { endpoint: string; provider: string }
        try {
          const { getTtsConfig } = await import('../lib/config.js')
          ttsConfig = await getTtsConfig()
        } catch {
          ttsConfig = { endpoint: 'http://localhost:9880', provider: 'gpt-sovits' }
        }

        const settings = {
          speed: voiceSettingsRaw?.speed ?? 1.0,
          pitch: voiceSettingsRaw?.pitch ?? 0,
        }
        const provider = createTtsProvider({ endpoint: ttsConfig.endpoint, type: ttsConfig.provider })

        const pending: Promise<void>[] = []
        for (let i = 0; i < sentences.length; i++) {
          const idx = i
          const text = sentences[i]
          const p = synthesizeAndSave(agentIdForVoice, messageId, idx, text, settings, voiceSpeakerId, provider)
            .then(result => {
              send({ type: 'voice_segment', message_id: messageId, index: idx, audio_url: result.url, text, duration_seconds: result.duration })
            })
            .catch(err => {
              console.warn(`[voice] segment ${idx} failed:`, (err as Error).message)
            })
          pending.push(p)
        }

        await Promise.race([
          Promise.all(pending),
          new Promise<void>(r => setTimeout(r, 30_000)),
        ])
        markVoiceComplete(agentIdForVoice, messageId)
        send({ type: 'voice_done', message_id: messageId, total_segments: sentences.length })
      }

      // --- End voice setup ---

      // Initialize infinite state if enabled
      if (isInfinite) {
        const existing = await db.select({ value: count() }).from(messages)
          .where(eq(messages.conversation_id, convId)).get()
        infiniteState.set(convId, { enabled: true, messageCount: existing?.value ?? 0 })
      }

      // 本轮最后一条 assistant 消息定位（供 suggestions 补挂；群聊取最后发言的 Agent）
      let lastAssistantMsgId: number | undefined
      let lastAssistantAgentId: string | undefined
      let lastAssistantHadSuggestions = false

      // Helper: save assistant message to DB
      const saveAssistantMsg = async (content: string, thinking: string | null, suggestionsList: string[], artifactsLocal?: Array<{ filename: string; displayName: string; mimeType: string; downloadUrl: string }>, agentId?: string, trace?: TraceEntry[]) => {
        const replyNow = Math.floor(Date.now() / 1000)
        let msgAttachments: string | null = null
        if (artifactsLocal && artifactsLocal.length > 0) {
          msgAttachments = JSON.stringify(artifactsLocal.map((a) => ({
            url: a.downloadUrl, name: a.displayName, size: 0, type: a.mimeType,
          })))
        }
        const result = await db.insert(messages).values({
          conversation_id: convId,
          role: 'assistant',
          content,
          thinking: thinking || null,
          suggestions: suggestionsList.length > 0 ? JSON.stringify(suggestionsList) : null,
          attachments: msgAttachments,
          agent_id: agentId || null,
          trace: trace ? JSON.stringify(trace) : null,
          created_at: replyNow,
        }).returning({ id: messages.id })
        lastAssistantMsgId = Number(result[0]?.id ?? 0)
        lastAssistantAgentId = agentId || undefined
        lastAssistantHadSuggestions = suggestionsList.length > 0
        // Voice: fire async synthesis after each assistant reply
        if (voiceEnabled && voiceSpeakerId && lastAssistantMsgId > 0 && content) {
          synthesizeReplyVoice(voiceAgent!.id, lastAssistantMsgId, content)
        }
        // Unread broadcast: notify all devices this conversation has new messages
        void (async () => {
          try {
            broadcastUnreadUpdate(userId, convId, await countUnread(convId))
          } catch (err) {
            console.error('[unread] Failed to broadcast unread update:', (err as Error).message)
          }
        })()
      }

      // Helper: generate follow-up and save as user message
      const generateAndSaveFollowUp = async (): Promise<string> => {
        // Send follow_up_start first so client creates a placeholder bubble
        send({ type: 'follow_up_start' })

        const context = await buildNeutralContext(convId)
        const agents = await listAgents()

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

      // Helper: 中立 Agent 补发生成 suggestions —— done 已先行发出、前端 loading 已结束，
      // 此处后台生成，完成后先 UPDATE messages 再补发 suggestions SSE 事件。
      // 必须在 streamSSE handler 返回前 await（finally 里的 writeChain 只保证已入队事件 flush）。
      const SUGGESTIONS_TIMEOUT_MS = 30_000
      const generateAndSendSuggestions = async (): Promise<void> => {
        if (lastAssistantMsgId === undefined) return // 本轮空回复，无 assistant 消息可挂
        if (lastAssistantHadSuggestions) return // 兜底路径已带出 suggestions，跳过重复生成
        try {
          const [config, agents, context] = await Promise.all([
            getConfig(), listAgents(), buildNeutralContext(convId),
          ])
          const neutralAgent = agents.find((a) => a.id === NEUTRAL_AGENT_ID)
          const model = neutralAgent?.model || agents[0]?.model || 'gpt-4o'
          const extraPrompt = neutralAgent?.system_prompt?.trim() || undefined

          // 超时保护：provider 只对响应头有超时，流本身无界；
          // 不设上限的话一次挂起会把 SSE 连接（和客户端）无限拖住。超时即放弃，静默降级。
          let timer: ReturnType<typeof setTimeout> | undefined
          const timeout = new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), SUGGESTIONS_TIMEOUT_MS)
          })
          const suggestions = await Promise.race([
            generateNeutralSuggestions(config, model, context, extraPrompt),
            timeout,
          ])
          if (timer) clearTimeout(timer)
          if (!suggestions || suggestions.length === 0) return

          // 先落库再发事件：保证客户端任何时点的收尾 refetch 与事件状态一致
          await db.update(messages)
            .set({ suggestions: JSON.stringify(suggestions) })
            .where(eq(messages.id, lastAssistantMsgId))
            .run()
          send({ type: 'suggestions', suggestions, agent_id: lastAssistantAgentId ?? null })
        } catch (err) {
          // done 已是终止事件，之后绝不能再发 error（前端会把错误写进气泡）——只记日志
          console.error('Neutral agent suggestions failed:', (err as Error).message)
        }
      }

      // Helper: reload history from DB
      const reloadHistory = async (): Promise<ChatMessage[]> => {
        const allMsgs = await db.select().from(messages)
          .where(eq(messages.conversation_id, convId))
          .orderBy(messages.created_at).all()
        return allMsgs.slice(0, -1).map((m: typeof messages.$inferSelect) => ({
          role: m.role as ChatMessage['role'],
          content: m.content,
          tool_calls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
          tool_call_id: m.tool_call_id || undefined,
          agent_id: m.agent_id || null,
          created_at: m.created_at,
        }))
      }

      /** 从最新历史中计算 Agent 上次发出 assistant 消息的时间戳 */
      const computeLastMessageAt = (msgs: ChatMessage[], targetId?: string): number | undefined => {
        const assistantMsgs = msgs.filter((m) => m.role === 'assistant' && m.created_at)
        if (!targetId) return assistantMsgs.at(-1)?.created_at
        return assistantMsgs.filter((m) => m.agent_id === targetId).at(-1)?.created_at
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
          language,
          forceCompliance: _force_compliance === true,
          saveMessage: async (agentId, agentName, reply, thinking, suggestions, artifacts, trace) => {
            await saveAssistantMsg(reply, thinking, suggestions, artifacts, agentId, trace)
          },
        })
      } else {
        const { reply, suggestions, thinking, artifacts, agentId: resolvedAgentId, trace } = await runPiAgentLoop({
          userMessage: currentPrompt,
          history: currentHistory,
          send,
          thinkingMode: thinking_mode !== false,
          conversationId: convId,
          userId,
          agentId: agentId || undefined,
          infiniteMode: isInfinite,
          language,
          lastMessageAt,
          forceCompliance: _force_compliance === true,
        })
        if (reply) {
          await saveAssistantMsg(reply, thinking, suggestions, artifacts, resolvedAgentId, trace)
        }
      }

      // 非无限模式：本轮回复完成后，由中立 Agent 生成追问建议并补发
      // （无限模式不生成 suggestions，追问由中立 Agent 的 follow_up 负责）
      if (!isInfinite) {
        await generateAndSendSuggestions()
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
            language,
            forceCompliance: false,
            saveMessage: async (agentId, agentName, reply, thinking, suggestions, artifacts, trace) => {
              await saveAssistantMsg(reply, thinking, suggestions, artifacts, agentId, trace)
            },
          })
        } else {
          const { reply, suggestions, thinking, artifacts, agentId: resolvedAgentId, trace } = await runPiAgentLoop({
            userMessage: currentPrompt,
            history: currentHistory,
            send,
            thinkingMode: thinking_mode !== false,
            conversationId: convId,
            userId,
            agentId: agentId || undefined,
            infiniteMode: isInfinite,
            language,
            lastMessageAt: computeLastMessageAt(currentHistory, agentId || undefined),
            forceCompliance: false,
          })
          if (reply) {
            await saveAssistantMsg(reply, thinking, suggestions, artifacts, resolvedAgentId, trace)
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
      if (relayTimer) clearTimeout(relayTimer)
      flushRelay() // flush any remaining buffered tokens
      // 等待所有 SSE 事件真正 flush 到响应流，再让 Hono 关闭连接
      await writeChain
    }
  })
})

// ---- Answer Endpoint: 用户回答 ask_user 问题 ----
chatRoute.post('/:conversationId/answer', async (c) => {
  const userId = (c as any).get('userId') as string
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const conversationId = c.req.param('conversationId')
  const body = await c.req.json<{ question_id: string; answer: string; selected_options?: string[] }>()
  const { question_id, answer, selected_options } = body

  if (!question_id) {
    return c.json({ error: 'question_id is required' }, 400)
  }

  // 验证问题属于当前会话
  const pending = getPendingQuestion(question_id)
  if (!pending) {
    return c.json({ error: 'Question not found or has expired' }, 410)
  }
  if (pending.conversationId !== conversationId) {
    return c.json({ error: 'Question does not belong to this conversation' }, 403)
  }

  const resolved = resolveQuestion(question_id, answer || '', selected_options)
  if (!resolved) {
    return c.json({ error: 'Question already answered or expired' }, 410)
  }

  trackUserActivity(userId).catch(() => {})
  return c.json({ success: true })
})
