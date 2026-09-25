// Agent 选择列表 —— 自 App.tsx 的内联 JSX 抽出。
// 原本「新建群聊」与「群成员管理」两个对话框各写了一遍同样的 27 行，这里收成一份。

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
