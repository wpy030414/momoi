// ============================================================
// @mention Tool — Group Chat Agent-to-Agent Mention
// ============================================================

import type { ToolModule, ToolContext, ToolResult } from './types.js'

export interface MentionSignal {
  triggered: boolean
  agentNames: string[]
  message: string | null
}

export function createMentionTool(mentionSignal: MentionSignal): ToolModule {
  return {
    definition: {
      name: 'at_mention',
      description:
        'Mention one or more agents in the group chat to interact with them — greet them, invite their opinions, ' +
        'joke with them, or ask for their expertise. This is a natural social tool, like @someone in a real group chat. ' +
        'ALWAYS include the "@AgentName" mention naturally in your reply text alongside this tool call. ' +
        'The mentioned agents will reply in this round, but other agents will still speak too.',
      input_schema: {
        type: 'object',
        properties: {
          agent_names: {
            type: 'array',
            items: { type: 'string' },
            description: 'The exact names of the agents to mention (e.g. ["Vanilla", "Coconut"]). Can be a single agent or multiple.',
          },
          message: {
            type: 'string',
            description: 'The message or question you want to send to the mentioned agents',
          },
        },
        required: ['agent_names', 'message'],
      },
    },
    execute: async (input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> => {
      const agentNamesRaw = input.agent_names as string[]
      const message = (input.message as string).trim()

      if (!agentNamesRaw || agentNamesRaw.length === 0 || !message) {
        return {
          summary: 'Error: both agent_names (non-empty array) and message are required.',
          error: true,
        }
      }

      mentionSignal.triggered = true
      mentionSignal.agentNames = agentNamesRaw.map(n => n.trim())
      mentionSignal.message = message

      const names = mentionSignal.agentNames.map(n => `@${n}`).join(' ')
      return {
        summary: `${names} have been mentioned. They will respond in this round with your message: "${message}"`,
        terminate: false,
      }
    },
  }
}