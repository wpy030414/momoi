// ============================================================
// Workspace Route — Serve files from conversation workspaces
// ============================================================

import { Hono } from 'hono'
import path from 'path'
import { db, conversations } from '../db.js'
import { eq, and, sql } from 'drizzle-orm'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { SandboxFS } from '../tools/workspace.js'

export const workspaceRoute = new Hono()

// Apply user auth to all routes
workspaceRoute.use('*', userAuthMiddleware)

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

// GET /api/workspace/:conversationId/file/*filepath
workspaceRoute.get('/:conversationId/file/*', async (c) => {
  const userId = (c as any).get('userId') as string
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const convId = c.req.param('conversationId')

  // Verify conversation ownership
  const conv = await db.select().from(conversations)
    .where(and(eq(conversations.id, convId), eq(conversations.user_id, userId), sql`${conversations.deleted_at} IS NULL`))
    .get()
  if (!conv) return c.json({ error: 'Not found' }, 404)

  // Extract filepath after /file/
  const fullPath = c.req.path
  const fileIdx = fullPath.indexOf('/file/')
  if (fileIdx === -1) return c.json({ error: 'Invalid path' }, 400)
  const filePath = decodeURIComponent(fullPath.slice(fileIdx + 6))

  const workspace = new SandboxFS(convId)
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
    return c.json({ error: 'File not found' }, 404)
  }
})
