import { Hono } from 'hono'
import { getConfig, listAgents } from '../config.js'
import { NEUTRAL_AGENT_ID } from '../../shared/constants.js'

export const appRoute = new Hono()

// Public: get app name, favicon, and agent list for white-label branding
appRoute.get('/', async (c) => {
  const config = await getConfig()
  const agents = await listAgents()
  return c.json({
    app_name: config.app_name,
    app_favicon: config.app_favicon,
    app_background: config.app_background,
    support_attachments: config.support_attachments,
    support_infinite_mode: config.support_infinite_mode,
    show_github: config.show_github,
    use_external_image_hosting: config.use_external_image_hosting,
    recommended_questions: config.recommended_questions,
    agents: agents.filter((a) => a.id !== NEUTRAL_AGENT_ID).map((a) => ({ id: a.id, name: a.name, avatar: a.avatar })),
  })
})
