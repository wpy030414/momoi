import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { db, conversations } from '../db.js'
import { eq, and, sql } from 'drizzle-orm'
import { SandboxFS } from '../tools/workspace.js'

export const uploadRoute = new Hono()

// Apply user auth to upload endpoint
uploadRoute.use('/*', userAuthMiddleware)

const MAX_SIZE = 20 * 1024 * 1024 // 20MB

// Upload file — saves into the conversation's workspace under __uploads__/
uploadRoute.post('/', async (c) => {
  try {
    const userId = (c as any).get('userId') as string
    if (!userId) return c.json({ error: 'Unauthorized' }, 401)

    const body = await c.req.parseBody()
    const file = body['file']
    const conversationId = body['conversation_id'] as string | undefined

    if (!file || typeof file === 'string') {
      return c.json({ error: 'No file provided' }, 400)
    }

    if (!conversationId) {
      return c.json({ error: 'conversation_id is required' }, 400)
    }

    // Verify conversation ownership
    const conv = await db.select().from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.user_id, userId), sql`${conversations.deleted_at} IS NULL`))
      .get()
    if (!conv) return c.json({ error: 'Conversation not found' }, 403)

    if (file.size > MAX_SIZE) {
      return c.json({ error: 'File too large (max 20MB)' }, 400)
    }

    const ext = (file.name || '').split('.').pop()
    const safeExt = ext ? `.${ext.toLowerCase().slice(0, 16)}` : ''
    const id = randomUUID()
    const filename = `${id}${safeExt}`

    const buffer = Buffer.from(await file.arrayBuffer())
    const ws = new SandboxFS(conversationId)
    await ws.writeFile(`__uploads__/${filename}`, buffer)

    const url = `/api/workspace/${conversationId}/file/__uploads__/${filename}`
    return c.json({
      url,
      name: file.name,
      size: file.size,
      type: file.type,
    })
  } catch (err: any) {
    console.error('Upload failed:', err)
    return c.json({ error: err.message || 'Upload failed' }, 500)
  }
})