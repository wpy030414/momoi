// ============================================================
// /api/memories — User-Agent cross-session memory management
// ============================================================
// Entry point for the user-facing "Memory" management view: the currently
// logged-in user manages their OWN memory entries per agent (CRUD + clear).
// Mounted as an independent prefix so it is unaffected by the stand-alone
// /api/user route fork (userAuthMiddleware passes through userId='admin').

import { Hono } from 'hono'
import { ErrCode } from '@momoi/shared/errors'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { NEUTRAL_AGENT_ID } from '@momoi/shared/constants'
import { ApiError } from '../lib/apiError.js'
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
  if (!agentId) throw new ApiError(ErrCode.MEMORY_AGENT_ID_REQUIRED)
  if (!content) throw new ApiError(ErrCode.MEMORY_CONTENT_EMPTY)
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new ApiError(ErrCode.MEMORY_CONTENT_TOO_LONG, { limit: MAX_CONTENT_LENGTH })
  }
  // The neutral agent never gets memories injected — reject to avoid dead rows.
  if (agentId === NEUTRAL_AGENT_ID) throw new ApiError(ErrCode.MEMORY_NEUTRAL_AGENT_FORBIDDEN)
  const agent = await getAgent(agentId)
  if (!agent) throw new ApiError(ErrCode.ADMIN_AGENT_NOT_FOUND)
  const memory = await saveUserAgentMemory(userId, agentId, content, 'user')
  return c.json({ memory })
})

// PUT /:id — update one memory's content (scoped to owner).
memoriesRoute.put('/:id', async (c) => {
  const body = await c.req.json<{ content?: string }>()
  const content = body.content?.trim() || ''
  if (!content) throw new ApiError(ErrCode.MEMORY_CONTENT_EMPTY)
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new ApiError(ErrCode.MEMORY_CONTENT_TOO_LONG, { limit: MAX_CONTENT_LENGTH })
  }
  const memory = await updateUserAgentMemory(getUserId(c), c.req.param('id'), content)
  if (!memory) throw new ApiError(ErrCode.MEMORY_NOT_FOUND)
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
  if (!ok) throw new ApiError(ErrCode.MEMORY_NOT_FOUND)
  return c.json({ success: true })
})
