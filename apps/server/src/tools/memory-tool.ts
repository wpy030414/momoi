// ============================================================
// save_memory — Cross-session persistent memory for agents
// ============================================================

import type { ToolModule, ToolResult } from './types.js'
import { saveUserAgentMemory } from '../lib/config.js'

const MAX_MEMORY_LENGTH = 4000

export const memoryTool: ToolModule = {
  definition: {
    name: 'save_memory',
    description: 'Save an important piece of information about the current user into cross-session persistent memory. Use this when the user shares something significant — preferences, personal facts, context, goals — that would be valuable to remember in future conversations. The memory will be injected into your system prompt automatically in subsequent sessions. Do NOT use this for trivial or temporary information; reserve it for lasting facts that change how you should interact with this user.',
    input_schema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The memory content to save. Write it as a clear, concise statement of fact about the user. Prefer third-person or attribute format, e.g. "The user prefers concise answers without fluff." or "User is a graduate student working on a thesis about volcanic activity."',
        },
      },
      required: ['content'],
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const content = String(input.content || '').trim()
    if (!content) {
      return { summary: 'Memory content cannot be empty.', error: true }
    }
    if (content.length > MAX_MEMORY_LENGTH) {
      return { summary: `Memory content too long (${content.length} characters, max ${MAX_MEMORY_LENGTH}).`, error: true }
    }
    if (!ctx.agentId) {
      return { summary: 'Cannot save memory: agent identity unknown.', error: true }
    }

    await saveUserAgentMemory(ctx.userId, ctx.agentId, content, 'agent')
    const preview = content.length > 200 ? content.slice(0, 200) + '...' : content
    return { summary: `Memory saved: "${preview}"` }
  },
}