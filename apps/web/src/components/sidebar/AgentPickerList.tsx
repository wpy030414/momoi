// AgentPickerList —— Agent 多选列表：新建群组会话与新建世界共用（原本是 App.tsx
// 里两处各写一遍的 27 行内联 JSX，这里收成一份。选择跨模式共享：选完 3 个 Agent
// 再切模式仍保留，只是阈值变了 —— 便宜且符合直觉）。

import { Check } from 'lucide-react'

export interface AgentBrief {
  id: string
  name: string
  avatar: string
}

interface AgentPickerListProps {
  agents: AgentBrief[]
  selected: string[]
  onToggle: (id: string) => void
  disabled?: boolean
}

export function AgentPickerList({ agents, selected, onToggle, disabled }: AgentPickerListProps) {
  return (
    <div className="space-y-2 max-h-[45vh] overflow-y-auto">
      {agents.map((agent) => {
        const isSelected = selected.includes(agent.id)
        return (
          <button
            key={agent.id}
            type="button"
            disabled={disabled}
            onClick={() => onToggle(agent.id)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors disabled:opacity-50 ${
              isSelected ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
            }`}
          >
            {agent.avatar ? (
              <img src={agent.avatar} alt={agent.name} className="w-8 h-8 rounded-full object-cover" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-sm font-medium">
                {agent.name.charAt(0)}
              </div>
            )}
            <span className="flex-1 text-left text-sm font-medium">{agent.name}</span>
            {isSelected && <Check className="h-4 w-4 text-primary" />}
          </button>
        )
      })}
    </div>
  )
}
