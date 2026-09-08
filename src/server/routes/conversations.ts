import { Hono } from 'hono'
import { db } from '../db.js'
import { conversations, messages, groupConversationAgents, agents } from '../schema.js'
import { eq, and, desc, gte, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { userAuthMiddleware } from '../middleware/userAuth.js'
import { NEUTRAL_AGENT_ID } from '../../shared/constants.js'

function getUserId(c: any): string {
  return c.get('userId') || ''
}

export const conversationsRoute = new Hono()

// Apply user auth to all routes
conversationsRoute.use('*', userAuthMiddleware)

// List user's conversations
conversationsRoute.get('/', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const list = await db.select().from(conversations).where(and(eq(conversations.user_id, userId), sql`${conversations.deleted_at} IS NULL`)).orderBy(desc(conversations.updated_at)).all()
  return c.json({ conversations: list })
})

// Get one conversation with messages
conversationsRoute.get('/:id', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const id = c.req.param('id')
  const conv = await db.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.user_id, userId), sql`${conversations.deleted_at} IS NULL`)).get()
  if (!conv) return c.json({ error: 'Not found' }, 404)

  const msgs = await db.select().from(messages).where(eq(messages.conversation_id, id)).orderBy(messages.created_at).all()

  // For group conversations, also return the agent list
  let groupAgents: Array<{ id: string; name: string; avatar: string }> | undefined
  if ((conv as any).type === 'group') {
    const rows = await db.select({
      agent_id: groupConversationAgents.agent_id,
      name: agents.name,
      avatar: agents.avatar,
    })
      .from(groupConversationAgents)
      .innerJoin(agents, eq(groupConversationAgents.agent_id, agents.id))
      .where(eq(groupConversationAgents.conversation_id, id))
      .orderBy(groupConversationAgents.sort_order)
      .all()
    groupAgents = rows.map((r) => ({ id: r.agent_id, name: r.name, avatar: r.avatar }))
  }

  return c.json({
    conversation: conv,
    messages: msgs.map((m) => ({
      ...m,
      tool_calls: m.tool_calls ? JSON.parse(m.tool_calls) : null,
      suggestions: m.suggestions ? JSON.parse(m.suggestions) : null,
      attachments: m.attachments ? JSON.parse(m.attachments) : null,
    })),
    agents: groupAgents,
  })
})

// Create a new conversation
conversationsRoute.post('/', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json<{ title?: string; agent_id?: string; type?: 'direct' | 'group'; agent_ids?: string[] }>()
  const id = randomUUID()
  const now = Math.floor(Date.now() / 1000)

  await db.insert(conversations).values({
    id, user_id: userId,
    title: body.title || (body.type === 'group' ? '群组对话' : 'New Chat'),
    agent_id: body.agent_id || '',
    type: body.type || 'direct',
    created_at: now, updated_at: now,
  }).run()

  // Insert group agent associations
  if (body.type === 'group' && body.agent_ids && body.agent_ids.length > 0) {
    for (let i = 0; i < body.agent_ids.length; i++) {
      if (body.agent_ids[i] === NEUTRAL_AGENT_ID) continue // skip neutral agent
      await db.insert(groupConversationAgents).values({
        conversation_id: id,
        agent_id: body.agent_ids[i],
        sort_order: i,
      }).run()
    }
  }

  const conv = await db.select().from(conversations).where(eq(conversations.id, id)).get()
  return c.json({ conversation: conv }, 201)
})

// Delete a conversation (soft delete — mark deleted_at, preserve workspace)
conversationsRoute.delete('/:id', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const id = c.req.param('id')
  const now = Math.floor(Date.now() / 1000)
  await db.update(conversations)
    .set({ deleted_at: now, updated_at: now })
    .where(and(eq(conversations.id, id), eq(conversations.user_id, userId)))
    .run()

  return c.json({ success: true })
})

// Rename a conversation
conversationsRoute.patch('/:id', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const id = c.req.param('id')
  const body = await c.req.json<{ title: string }>()
  const now = Math.floor(Date.now() / 1000)

  await db.update(conversations).set({ title: body.title, updated_at: now }).where(and(eq(conversations.id, id), eq(conversations.user_id, userId), sql`${conversations.deleted_at} IS NULL`)).run()

  // Scope the read-back by user_id too — otherwise a caller who renames someone
  // else's conversation (the UPDATE above no-ops) still gets that conversation echoed.
  const conv = await db.select().from(conversations).where(and(eq(conversations.id, id), eq(conversations.user_id, userId), sql`${conversations.deleted_at} IS NULL`)).get()
  if (!conv) return c.json({ error: 'Not found' }, 404)
  return c.json({ conversation: conv })
})

// Revert from a specific message — delete this message and all subsequent ones
conversationsRoute.delete('/:id/messages/:messageId', async (c) => {
  const userId = getUserId(c)
  if (!userId) return c.json({ error: 'Unauthorized' }, 401)

  const convId = c.req.param('id')
  const messageId = Number(c.req.param('messageId'))

  // Verify conversation ownership
  const conv = await db.select().from(conversations).where(and(eq(conversations.id, convId), eq(conversations.user_id, userId), sql`${conversations.deleted_at} IS NULL`)).get()
  if (!conv) return c.json({ error: 'Not found' }, 404)

  // Verify message belongs to this conversation
  const msg = await db.select().from(messages).where(and(eq(messages.id, messageId), eq(messages.conversation_id, convId))).get()
  if (!msg) return c.json({ error: 'Message not found' }, 404)

  // Delete this message and all messages created after it (same or later timestamp)
  await db.delete(messages)
    .where(and(
      eq(messages.conversation_id, convId),
      gte(messages.id, messageId),
    ))
    .run()

  // Update conversation timestamp
  const now = Math.floor(Date.now() / 1000)
  await db.update(conversations).set({ updated_at: now }).where(eq(conversations.id, convId)).run()

  return c.json({ success: true })
})
