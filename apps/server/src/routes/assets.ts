import { Hono } from 'hono'
import path from 'path'
import fs from 'fs'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { repoRoot } from '../lib/paths.js'

export const assetsRoute = new Hono()

// Audio files — require user JWT
assetsRoute.get('/voice/:agent_id/:message_id/:filename', userAuthMiddleware, async (c) => {
  const { agent_id, message_id, filename } = c.req.param()

  // Path traversal protection
  if (path.basename(filename) !== filename) {
    return c.text('Forbidden', 403)
  }

  const filePath = path.resolve(repoRoot(), 'data', 'voice', agent_id, message_id, filename)

  // Ensure resolved path stays within data/voice/
  if (!filePath.startsWith(path.resolve(repoRoot(), 'data', 'voice'))) {
    return c.text('Forbidden', 403)
  }

  if (!fs.existsSync(filePath)) {
    return c.text('Not Found', 404)
  }

  const buffer = fs.readFileSync(filePath)
  const ext = path.extname(filename).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.flac': 'audio/flac',
  }

  return new Response(buffer, {
    headers: {
      'Content-Type': mimeTypes[ext] || 'audio/wav',
      'Cache-Control': 'private, max-age=86400',
    },
  })
})