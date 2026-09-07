// ============================================================
// @mention Tool — Group Chat Agent-to-Agent Mention
// ============================================================

import type { ToolModule, ToolContext, ToolResult } from './types.js'

export interface MentionSignal {
  triggered: boolean
  agentName: string | null
  message: string | null
}

export function createMentionTool(mentionSignal: MentionSignal): ToolModule {
  return {
    definition: {
      name: 'at_mention',
      description:
        'Call a specific agent by name to respond to your question or pass the conversation to them. ' +
        'Use this when you need another agent\'s expertise or want them to reply next — ' +
        'the mentioned agent will respond immediately, and other agents will be skipped for this round. ' +
        'Always provide a clear, self-contained message or question for the target agent.',
      input_schema: {
        type: 'object',
        properties: {
          agent_name: {
            type: 'string',
            description: 'The exact name of the agent to mention (e.g. "Vanilla", "Coconut")',
          },
          message: {
            type: 'string',
            description: 'The message or question you want to send to the mentioned agent',
          },
        },
        required: ['agent_name', 'message'],
      },
    },
    execute: async (input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> => {
      const agentName = (input.agent_name as string).trim()
      const message = (input.message as string).trim()

      if (!agentName || !message) {
        return {
          summary: 'Error: both agent_name and message are required.',
          error: true,
        }
      }

      mentionSignal.triggered = true
      mentionSignal.agentName = agentName
      mentionSignal.message = message

      return {
        summary: `@${agentName} has been mentioned. They will respond next with your message: "${message}"`,
        terminate: true,
      }
    },
  }
}