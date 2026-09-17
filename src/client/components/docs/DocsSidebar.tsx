import { useTranslation } from 'react-i18next'
import { ArrowLeft, FileText } from 'lucide-react'
import { ScrollArea } from '../ui/scroll-area'
import { MarqueeText } from '../ui/MarqueeText'

export interface DocEntry {
  title: string
  path: string
  group: string
}

interface DocsSidebarProps {
  docs: DocEntry[]
  activeDoc: string | null
  onSelect: (path: string) => void
  onBack: () => void
}

/** Group docs: root files (group '') → one group, each subfolder → its own group. */
function groupDocs(docs: DocEntry[]): { label: string; items: DocEntry[] }[] {
  const map = new Map<string, DocEntry[]>()
  for (const d of docs) {
    const key = d.group || ''
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(d)
  }
  const groups: { label: string; items: DocEntry[] }[] = []
  if (map.has('')) {
    groups.push({ label: 'Overview', items: map.get('')! })
    map.delete('')
  }
  for (const [key, items] of map) {
    groups.push({ label: key, items })
  }
  return groups
}

export function DocsSidebar({ docs, activeDoc, onSelect, onBack }: DocsSidebarProps) {
  const { t } = useTranslation()
  const groups = groupDocs(docs)

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
        <h2 className="text-sm font-semibold truncate">{t('docs.title')}</h2>
      </div>

      {/* Doc tree */}
      <ScrollArea className="flex-1 sidebar-scroll-area">
        <div className="p-2 space-y-3 w-full">
          {groups.map((group) => (
            <div key={group.label}>
              <h3 className="px-3 text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">
                {group.label}
              </h3>
              <div className="space-y-0.5">
                {group.items.map((doc) => (
                  <button
                    key={doc.path}
                    className={`w-full flex items-center gap-2.5 h-9 px-3 rounded-sm text-sm font-normal transition-colors min-w-0 overflow-hidden text-left ${
                      activeDoc === doc.path
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                    }`}
                    onClick={() => onSelect(doc.path)}
                  >
                  <FileText className="h-4 w-4 shrink-0" />
                    <MarqueeText text={doc.title} />
                  </button>
                ))}
              </div>
            </div>
          ))}
          {docs.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-8">{t('docs.empty')}</p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}