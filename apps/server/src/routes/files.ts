// ============================================================
// Files Route — Serve files from conversation workspaces
// （前身为 /api/workspace；旧前缀作为永久别名挂载，
//   兼容持久化在 messages.attachments / trace 里的历史 URL）
// ============================================================

import { Hono } from 'hono'
import { ErrCode } from '@momoi/shared/errors'
import path from 'path'
import { db, conversations } from '../db/index.js'
import { eq, and, sql } from 'drizzle-orm'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { ApiError } from '../lib/apiError.js'
import { SandboxFS } from '../tools/workspace.js'

export const filesRoute = new Hono()

// Apply user auth to all routes
filesRoute.use('*', userAuthMiddleware)

function guessMime(ext: string): string {
  const map: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.xml': 'application/xml',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.ts': 'application/typescript',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
    '.doc': 'application/msword',
  }
  return map[ext] || 'application/octet-stream'
}

// GET /api/files/:conversationId/file/*filepath
filesRoute.get('/:conversationId/file/*', async (c) => {
  const userId = (c as any).get('userId') as string
  if (!userId) throw new ApiError(ErrCode.UNAUTHORIZED)

  const convId = c.req.param('conversationId')

  // Verify conversation ownership
  const conv = await db.select().from(conversations)
    .where(and(eq(conversations.id, convId), eq(conversations.user_id, userId), sql`${conversations.deleted_at} IS NULL`))
    .get()
  if (!conv) throw new ApiError(ErrCode.WORKSPACE_NOT_FOUND)

  // Extract filepath after /file/
  const fullPath = c.req.path
  const fileIdx = fullPath.indexOf('/file/')
  if (fileIdx === -1) throw new ApiError(ErrCode.WORKSPACE_INVALID_PATH)
  const filePath = decodeURIComponent(fullPath.slice(fileIdx + 6))

  const workspace = await SandboxFS.forConversation(convId)
  try {
    const buffer = await workspace.readFileRaw(filePath)
    const ext = path.extname(filePath).toLowerCase()
    const mime = guessMime(ext)
    const queryName = c.req.query('name')
    const downloadName = queryName ? decodeURIComponent(queryName) : path.basename(filePath)
    const encodedName = encodeURIComponent(downloadName)

    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(buffer.length),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch {
    throw new ApiError(ErrCode.WORKSPACE_FILE_NOT_FOUND)
  }
})
