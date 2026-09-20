import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { ScrollArea } from '../ui/scroll-area'
import { MarqueeText } from '../ui/MarqueeText'
import type { UserAgentMemory } from '@momoi/shared/types'

interface MemorySidebarProps {
  agents: Array<{ id: string; name: string; avatar: string }>
  memories: UserAgentMemory[]
  activeAgentId: string | null
  onSelect: (agentId: string) => void
  onBack: () => void
}

/** Memory view sidebar — agent navigation with per-agent memory counts.
 *  Orphaned entries (agent deleted; no FK cascade) get their own tail group
 *  so users can still see and clean up the leftover rows. */
export function MemorySidebar({ agents, memories, activeAgentId, onSelect, onBack }: MemorySidebarProps) {
  const { t } = useTranslation()

  const { counts, orphanIds } = useMemo(() => {
    const counts = new Map<string, number>()
    const known = new Set(agents.map((a) => a.id))
    const orphanIds: string[] = []
    for (const m of memories) {
      counts.set(m.agent_id, (counts.get(m.agent_id) || 0) + 1)
      if (!known.has(m.agent_id) && !orphanIds.includes(m.agent_id)) orphanIds.push(m.agent_id)
    }
    return { counts, orphanIds }
  }, [agents, memories])

  const renderRow = (id: string, name: string, avatar: string) => {
    const count = counts.get(id) || 0
    return (
      <button
        key={id}
        className={`w-full flex items-center gap-2.5 h-9 px-3 rounded-sm text-sm font-normal transition-colors min-w-0 overflow-hidden text-left ${
          activeAgentId === id
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
        }`}
        onClick={() => onSelect(id)}
      >
        {avatar ? (
          <img src={avatar} alt="" className="w-5 h-5 rounded-full object-cover flex-shrink-0" />
        ) : (
          <div className="w-5 h-5 rounded-full bg-muted flex items-center justify-center text-xs font-medium flex-shrink-0">
            {name.charAt(0)}
          </div>
        )}
        <MarqueeText text={name} />
        {count > 0 && (
          <span className="ml-auto inline-flex items-center rounded-full bg-secondary text-secondary-foreground px-2 text-xs shrink-0">
            {count}
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="flex flex-col h-full w-72 bg-card border-r">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 border-b shrink-0" style={{ height: '60px' }}>
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="text-sm font-semibold truncate">{t('memory.title')}</h2>
      </div>

      {/* Agent list */}
      <ScrollArea className="flex-1 sidebar-scroll-area">
        <div className="p-2 space-y-3 w-full">
          <div className="space-y-0.5">
            {agents.map((a) => renderRow(a.id, a.name, a.avatar))}
          </div>

          {orphanIds.length > 0 && (
            <div>
              <h3 className="px-3 text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                {t('memory.unknownAgent')}
              </h3>
              <div className="space-y-0.5">
                {orphanIds.map((id) => renderRow(id, t('memory.unknownAgent'), ''))}
              </div>
            </div>
          )}

          {agents.length === 0 && orphanIds.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">{t('memory.empty')}</p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
