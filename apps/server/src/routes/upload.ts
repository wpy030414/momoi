import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import { ErrCode } from '@momoi/shared/errors'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { db, conversations } from '../db/index.js'
import { eq, and, sql } from 'drizzle-orm'
import { ApiError } from '../lib/apiError.js'
import { SandboxFS } from '../tools/workspace.js'
import { uploadToCdn } from '../lib/cdn.js'
import { isExternalImageHostingEnabled } from '../lib/config.js'

export const uploadRoute = new Hono()

// Apply user auth to upload endpoint
uploadRoute.use('/*', userAuthMiddleware)

const MAX_SIZE = 20 * 1024 * 1024 // 20MB

// Upload file — saves into the conversation's workspace under __uploads__/
uploadRoute.post('/', async (c) => {
  try {
    const userId = (c as any).get('userId') as string
    if (!userId) throw new ApiError(ErrCode.UNAUTHORIZED)

    const body = await c.req.parseBody()
    const file = body['file']
    const conversationId = body['conversation_id'] as string | undefined

    if (!file || typeof file === 'string') {
      throw new ApiError(ErrCode.UPLOAD_NO_FILE)
    }

    if (!conversationId) {
      throw new ApiError(ErrCode.UPLOAD_CONVERSATION_ID_REQUIRED)
    }

    // Verify conversation ownership
    const conv = await db.select().from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.user_id, userId), sql`${conversations.deleted_at} IS NULL`))
      .get()
    if (!conv) throw new ApiError(ErrCode.CONV_NOT_FOUND)

    if (file.size > MAX_SIZE) {
      throw new ApiError(ErrCode.UPLOAD_FILE_TOO_LARGE, { limit: '20MB' })
    }

    const ext = (file.name || '').split('.').pop()
    const safeExt = ext ? `.${ext.toLowerCase().slice(0, 16)}` : ''
    const id = randomUUID()
    const filename = `${id}${safeExt}`

    const buffer = Buffer.from(await file.arrayBuffer())
    const ws = await SandboxFS.forConversation(conversationId)
    await ws.writeFile(`__uploads__/${filename}`, buffer)

    const workspaceUrl = `/api/files/${conversationId}/file/__uploads__/${filename}`

    // If external image hosting is enabled, upload to CDN for user-facing URL
    let cdnUrl: string | null = null
    if (await isExternalImageHostingEnabled()) {
      try {
        cdnUrl = await uploadToCdn(buffer, file.name || filename, file.type || 'application/octet-stream')
      } catch (err) {
        console.warn('CDN upload failed, falling back to workspace URL:', (err as Error).message)
      }
    }

    return c.json({
      url: cdnUrl || workspaceUrl,
      ...(cdnUrl ? { workspace_url: workspaceUrl } : {}),
      name: file.name,
      size: file.size,
      type: file.type,
    })
  } catch (err: any) {
    if (err instanceof ApiError) throw err
    throw new ApiError(
      ErrCode.UPLOAD_FAILED,
      { detail: (err.message || 'Upload failed').slice(0, 300) },
      { log: 'upload failed', cause: err },
    )
  }
})