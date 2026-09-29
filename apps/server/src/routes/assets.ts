import { Hono } from 'hono'
import { ErrCode } from '@momoi/shared/errors'
import path from 'path'
import fs from 'fs'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { ApiError } from '../lib/apiError.js'
import { repoRoot } from '../lib/paths.js'

export const assetsRoute = new Hono()

// Audio files — require user JWT
assetsRoute.get('/voice/:agent_id/:message_id/:filename', userAuthMiddleware, async (c) => {
  const { agent_id, message_id, filename } = c.req.param()

  // Path traversal protection
  if (path.basename(filename) !== filename) {
    throw new ApiError(ErrCode.ASSET_FORBIDDEN)
  }

  const filePath = path.resolve(repoRoot(), 'data', 'voice', agent_id, message_id, filename)

  // Ensure resolved path stays within data/voice/
  if (!filePath.startsWith(path.resolve(repoRoot(), 'data', 'voice'))) {
    throw new ApiError(ErrCode.ASSET_FORBIDDEN)
  }

  if (!fs.existsSync(filePath)) {
    throw new ApiError(ErrCode.ASSET_NOT_FOUND)
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