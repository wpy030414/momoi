import { Brain, Pencil, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * Introduction page 3 mock — a miniature memory panel: one agent header and
 * three memory cards illustrating view / edit / delete. Semantic tokens only.
 */
export function MockMemory() {
  const { t } = useTranslation()
  const items = [
    { text: t('intro.mock.memoryItem1'), action: null },
    { text: t('intro.mock.memoryItem2'), action: 'edit' as const },
    { text: t('intro.mock.memoryItem3'), action: 'delete' as const },
  ]
  return (
    <div className="w-[240px] rounded-lg border border-border bg-card overflow-hidden shadow-sm">
      <div className="flex flex-col h-[180px]">
        {/* Agent header */}
        <div className="flex items-center gap-2 px-2.5 py-2 border-b border-border">
          <span className="h-5 w-5 rounded-full bg-primary shrink-0" />
          <span className="text-[10px] font-medium leading-none">{t('intro.mock.agentA')}</span>
          <Brain className="ml-auto h-3.5 w-3.5 text-primary shrink-0" aria-hidden="true" />
        </div>

        {/* Memory cards */}
        <div className="flex-1 flex flex-col justify-center gap-1.5 px-2.5 py-2 min-h-0">
          {items.map((item, i) => (
            <div
              key={i}
              className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5"
            >
              <span className="h-1 w-1 rounded-full bg-primary/70 shrink-0" aria-hidden="true" />
              <span className="flex-1 text-[9px] leading-snug truncate">{item.text}</span>
              {item.action === 'edit' && <Pencil className="h-3 w-3 text-muted-foreground shrink-0" aria-hidden="true" />}
              {item.action === 'delete' && <Trash2 className="h-3 w-3 text-muted-foreground shrink-0" aria-hidden="true" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
