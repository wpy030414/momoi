// ============================================================
// /api/memories — User-Agent cross-session memory management
// ============================================================
// Entry point for the user-facing "Memory" management view: the currently
// logged-in user manages their OWN memory entries per agent (CRUD + clear).
// Mounted as an independent prefix so it is unaffected by the stand-alone
// /api/user route fork (userAuthMiddleware passes through userId='admin').

import { Hono } from 'hono'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { NEUTRAL_AGENT_ID } from '@momoi/shared/constants'
import {
  getAgent,
  listUserMemories,
  saveUserAgentMemory,
  updateUserAgentMemory,
  deleteUserAgentMemory,
  deleteUserAgentMemories,
} from '../lib/config.js'

// Keep in sync with MAX_MEMORY_LENGTH in tools/memory-tool.ts
const MAX_CONTENT_LENGTH = 4000

function getUserId(c: any): string {
  return c.get('userId') || ''
}

export const memoriesRoute = new Hono()

memoriesRoute.use('*', userAuthMiddleware)

// GET / — all memories of the current user across agents, newest first.
// Includes orphaned entries (agent deleted; no FK cascade) so they stay visible and cleanable.
memoriesRoute.get('/', async (c) => {
  const memories = await listUserMemories(getUserId(c))
  return c.json({ memories })
})

// POST / — create a memory manually. { agent_id, content } → source='user'
memoriesRoute.post('/', async (c) => {
  const userId = getUserId(c)
  const body = await c.req.json<{ agent_id?: string; content?: string }>()
  const agentId = body.agent_id?.trim() || ''
  const content = body.content?.trim() || ''
  if (!agentId) return c.json({ error: 'agent_id is required' }, 400)
  if (!content) return c.json({ error: 'Content cannot be empty' }, 400)
  if (content.length > MAX_CONTENT_LENGTH) {
    return c.json({ error: `Content too long (max ${MAX_CONTENT_LENGTH} characters)` }, 400)
  }
  // The neutral agent never gets memories injected — reject to avoid dead rows.
  if (agentId === NEUTRAL_AGENT_ID) return c.json({ error: 'Neutral agent cannot have memories' }, 403)
  const agent = await getAgent(agentId)
  if (!agent) return c.json({ error: 'Agent not found' }, 404)
  const memory = await saveUserAgentMemory(userId, agentId, content, 'user')
  return c.json({ memory })
})

// PUT /:id — update one memory's content (scoped to owner).
memoriesRoute.put('/:id', async (c) => {
  const body = await c.req.json<{ content?: string }>()
  const content = body.content?.trim() || ''
  if (!content) return c.json({ error: 'Content cannot be empty' }, 400)
  if (content.length > MAX_CONTENT_LENGTH) {
    return c.json({ error: `Content too long (max ${MAX_CONTENT_LENGTH} characters)` }, 400)
  }
  const memory = await updateUserAgentMemory(getUserId(c), c.req.param('id'), content)
  if (!memory) return c.json({ error: 'Memory not found' }, 404)
  return c.json({ memory })
})

// DELETE /agent/:agentId — clear ALL memories of one agent (scoped to owner).
memoriesRoute.delete('/agent/:agentId', async (c) => {
  const deleted = await deleteUserAgentMemories(getUserId(c), c.req.param('agentId'))
  return c.json({ success: true, deleted })
})

// DELETE /:id — delete one memory (scoped to owner).
memoriesRoute.delete('/:id', async (c) => {
  const ok = await deleteUserAgentMemory(getUserId(c), c.req.param('id'))
  if (!ok) return c.json({ error: 'Memory not found' }, 404)
  return c.json({ success: true })
})
