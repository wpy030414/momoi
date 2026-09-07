// ============================================================
// GroupAgentBar — Agent avatar bubbles for group chat
// ============================================================

import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'

interface AgentBrief {
  id: string
  name: string
  avatar: string
}

interface GroupAgentBarProps {
  agents: AgentBrief[]
  availableAgents: AgentBrief[]
  onAddAgent: (agentId: string) => void
  onRemoveAgent: (agentId: string) => void
  disabled?: boolean
}

export function GroupAgentBar({ agents, availableAgents, onAddAgent, onRemoveAgent, disabled }: GroupAgentBarProps) {
  const { t } = useTranslation()
  const [popoverOpen, setPopoverOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Close popover on outside click
  useEffect(() => {
    if (!popoverOpen) return
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [popoverOpen])

  const availableToAdd = availableAgents.filter(
    (a) => !agents.some((ga) => ga.id === a.id),
  )

  return (
    <div className="max-w-3xl mx-auto w-full px-4 pt-3 pb-1">
      <div className="flex items-center gap-3 flex-wrap">
        {agents.map((agent) => (
          <div key={agent.id} className="relative group flex flex-col items-center gap-1">
            <div className="relative">
              {agent.avatar ? (
                <img
                  src={agent.avatar}
                  alt={agent.name}
                  className="w-10 h-10 rounded-full object-cover border-2 border-border shadow-sm"
                />
              ) : (
                <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-sm font-medium border-2 border-border shadow-sm">
                  {agent.name.charAt(0)}
                </div>
              )}
              {!disabled && (
                <button
                  onClick={() => onRemoveAgent(agent.id)}
                  className="absolute -top-1 -right-1 w-4 h-4 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </div>
            <span className="text-[10px] text-muted-foreground leading-tight max-w-[60px] truncate text-center">
              {agent.name}
            </span>
          </div>
        ))}

        {/* Add agent button */}
        {!disabled && availableToAdd.length > 0 && (
          <div className="relative flex flex-col items-center gap-1">
            <button
              ref={buttonRef}
              onClick={() => setPopoverOpen(!popoverOpen)}
              className="w-10 h-10 rounded-full border-2 border-dashed border-muted-foreground/30 flex items-center justify-center hover:border-muted-foreground/60 hover:bg-muted/50 transition-colors"
              title={t('chat.addAgent')}
            >
              <Plus className="h-4 w-4 text-muted-foreground" />
            </button>
            <span className="text-[10px] text-muted-foreground leading-tight">{t('chat.addAgent')}</span>

            {/* Popover */}
            {popoverOpen && (
              <div
                ref={popoverRef}
                className="absolute top-12 left-0 z-50 w-48 rounded-lg border bg-popover shadow-md p-1.5"
              >
                <div className="text-xs text-muted-foreground px-2 py-1 mb-1">{t('chat.selectAgents')}</div>
                {availableToAdd.map((agent) => (
                  <button
                    key={agent.id}
                    onClick={() => {
                      onAddAgent(agent.id)
                      setPopoverOpen(false)
                    }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm hover:bg-accent transition-colors"
                  >
                    {agent.avatar ? (
                      <img src={agent.avatar} alt={agent.name} className="w-5 h-5 rounded-full object-cover" />
                    ) : (
                      <div className="w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-medium">
                        {agent.name.charAt(0)}
                      </div>
                    )}
                    <span className="truncate">{agent.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}