import { Hono } from 'hono'
import path from 'path'
import fs from 'fs'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { getAgent } from '../config.js'

export const voiceRoute = new Hono()

voiceRoute.use('*', userAuthMiddleware)

/**
 * POST /api/voice/segments — get voice segments for a message (REST fallback)
 */
voiceRoute.post('/segments', async (c) => {
  const body = await c.req.json<{ agent_id: string; message_id: number }>()
  const { agent_id, message_id } = body

  if (!agent_id || message_id == null) {
    return c.json({ error: 'agent_id and message_id are required' }, 400)
  }

  const dir = path.resolve('data', 'voice', agent_id, String(message_id))
  const manifestPath = path.join(dir, 'manifest.json')

  if (!fs.existsSync(manifestPath)) {
    return c.json({ segments: [], complete: false })
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  const segments = []
  for (let i = 0; i < manifest.total_segments; i++) {
    const filename = `seg_${i}.wav`
    const filepath = path.join(dir, filename)
    const text = manifest.texts?.[i] || ''
    if (fs.existsSync(filepath)) {
      const stat = fs.statSync(filepath)
      const duration = stat.size / 64000 // 32kHz mono 16bit estimate
      segments.push({
        index: i,
        text,
        audio_url: `/api/assets/voice/${agent_id}/${message_id}/${filename}`,
        duration_seconds: Math.round(duration * 10) / 10,
      })
    }
  }

  return c.json({ segments, complete: manifest.complete ?? false })
})