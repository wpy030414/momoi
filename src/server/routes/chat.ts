import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import path from 'path'
import fs from 'fs'
import { db } from '../db.js'
import { conversations, messages } from '../schema.js'
import { eq } from 'drizzle-orm'
import { runPiAgentLoop } from '../ai/pi-adapter.js'
import type { ChatMessage, ContentPart } from '../ai/provider.js'
import type { ServerMessage, Attachment } from '../../shared/types.js'
import { randomUUID } from 'crypto'
import { parseAttachment } from '../files/parser.js'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { SandboxFS } from '../tools/workspace.js'

export const chatRoute = new Hono()

// Apply user auth to all routes
chatRoute.use('*', userAuthMiddleware)

chatRoute.get('/health', (c) => {
  return c.json({ status: 'ok', time: new Date().toISOString() })
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

  const body = await c.req.json<{ message: string; conversation_id?: string; _retry?: boolean; thinking_mode?: boolean; attachments?: Array<{ url: string; name: string; size: number; type: string }> }>()
  const { message, conversation_id, _retry, thinking_mode, attachments } = body

  if (!message?.trim()) {
    return c.json({ error: 'Empty message' }, 400)
  }

  return streamSSE(c, async (stream) => {
    let aborted = false
    const send = (msg: ServerMessage) => {
      if (aborted) return
      try {
        stream.writeSSE({ data: JSON.stringify(msg), event: 'message' })
      } catch {
        aborted = true
        const isTerminal = msg.type === 'done' || msg.type === 'error'
        if (isTerminal) {
          console.warn('Failed to send terminal event to client:', msg.type, '- stream already closed')
        }
      }
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
      if (!convId) {
        convId = randomUUID()
        const now = Math.floor(Date.now() / 1000)
        const title = message.slice(0, 40) || 'New Chat'
        await db.insert(conversations).values({ id: convId, user_id: userId, title, created_at: now, updated_at: now }).run()
      } else {
        // Verify conversation belongs to user
        const conv = await db.select().from(conversations).where(eq(conversations.id, convId)).get()
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

      // --- Run AI loop ---
      const { reply, suggestions, thinking, artifacts } = await runPiAgentLoop(
        userMessage, history, send, undefined,
        thinking_mode !== false, convId, userId,
      )

      // --- Save assistant message ---
      if (reply) {
        const replyNow = Math.floor(Date.now() / 1000)

        // Convert artifacts to Attachment format for persistence
        let msgAttachments: string | null = null
        if (artifacts && artifacts.length > 0) {
          const attList: Attachment[] = artifacts.map((a) => ({
            url: a.downloadUrl,
            name: a.displayName,
            size: 0,
            type: a.mimeType,
          }))
          msgAttachments = JSON.stringify(attList)
        }

        await db.insert(messages).values({
          conversation_id: convId,
          role: 'assistant',
          content: reply,
          thinking: thinking || null,
          suggestions: suggestions.length > 0 ? JSON.stringify(suggestions) : null,
          attachments: msgAttachments,
          created_at: replyNow,
        }).run()
      }
    } catch (err) {
      // Catch-all: guarantee the client always receives a terminal event
      const errMsg = err instanceof Error ? err.message : 'Internal server error'
      console.error('Chat handler error:', errMsg)
      send({ type: 'error', message: errMsg })
    } finally {
      clearInterval(keepalive)
    }
  })
})
