// ============================================================
// Group Chat Routes — Agent management for group conversations
// ============================================================

import { Hono } from 'hono'
import { db } from '../db.js'
import { conversations, groupConversationAgents, agents } from '../schema.js'
import { eq, and } from 'drizzle-orm'
import { userAuthMiddleware } from '../middleware/userAuth.js'

function getUserId(c: any): string {
  return c.get('userId') || ''
}

export const groupRoute = new Hono()

// Apply user auth to all routes
groupRoute.use('*', userAuthMiddleware)

// Get agents for a group conversation
groupRoute.get('/:id/agents', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const convId = c.req.param('id')

  // Verify conversation ownership
  const conv = await db.select()
    .from(conversations)
    .where(and(eq(conversations.id, convId), eq(conversations.user_id, userId)))
    .get()
  if (!conv) return c.json({ error: 'Not found' }, 404)

  // Get agent associations
  const rows = await db.select({
    agent_id: groupConversationAgents.agent_id,
    sort_order: groupConversationAgents.sort_order,
    name: agents.name,
    avatar: agents.avatar,
  })
    .from(groupConversationAgents)
    .innerJoin(agents, eq(groupConversationAgents.agent_id, agents.id))
    .where(eq(groupConversationAgents.conversation_id, convId))
    .orderBy(groupConversationAgents.sort_order)
    .all()

  return c.json({
    agents: rows.map((r) => ({
      id: r.agent_id,
      name: r.name,
      avatar: r.avatar,
    })),
  })
})

// Add an agent to a group conversation
groupRoute.post('/:id/agents', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const convId = c.req.param('id')
  const body = await c.req.json<{ agent_id: string }>()

  if (!body.agent_id) return c.json({ error: 'agent_id required' }, 400)

  // Verify conversation ownership
  const conv = await db.select()
    .from(conversations)
    .where(and(eq(conversations.id, convId), eq(conversations.user_id, userId)))
    .get()
  if (!conv) return c.json({ error: 'Not found' }, 404)

  // Get current max sort_order
  const existing = await db.select()
    .from(groupConversationAgents)
    .where(eq(groupConversationAgents.conversation_id, convId))
    .all()
  const maxOrder = existing.reduce((max, r) => Math.max(max, r.sort_order), -1)

  await db.insert(groupConversationAgents).values({
    conversation_id: convId,
    agent_id: body.agent_id,
    sort_order: maxOrder + 1,
  }).run()

  return c.json({ success: true })
})

// Remove an agent from a group conversation
groupRoute.delete('/:id/agents/:agentId', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const convId = c.req.param('id')
  const agentId = c.req.param('agentId')

  // Verify conversation ownership
  const conv = await db.select()
    .from(conversations)
    .where(and(eq(conversations.id, convId), eq(conversations.user_id, userId)))
    .get()
  if (!conv) return c.json({ error: 'Not found' }, 404)

  await db.delete(groupConversationAgents)
    .where(and(
      eq(groupConversationAgents.conversation_id, convId),
      eq(groupConversationAgents.agent_id, agentId),
    ))
    .run()

  return c.json({ success: true })
})