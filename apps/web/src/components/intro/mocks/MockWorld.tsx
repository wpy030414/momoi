import { Globe, Scale, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * Introduction page 3 mock — a miniature "world simulation": a world header
 * with its member AIs, the laws card that constrains every being in it, and a
 * timeline of agents reasoning turn by turn (the pulsing dots reuse the typing
 * indicator idiom from MockChat). Semantic tokens only.
 */
export function MockWorld() {
  const { t } = useTranslation()
  // Member avatars — four semantic fills so the row reads as "several AIs".
  const members = ['bg-primary', 'bg-secondary', 'bg-muted border border-border', 'bg-accent']
  return (
    <div className="w-[260px] rounded-lg border border-border bg-card overflow-hidden shadow-sm">
      <div className="flex flex-col h-[185px]">
        {/* World header: name + member avatars */}
        <div className="flex items-center gap-2 px-2.5 py-2 border-b border-border">
          <Globe className="h-3.5 w-3.5 text-primary shrink-0" aria-hidden="true" />
          <span className="text-[10px] font-medium leading-none truncate">{t('intro.mock.worldName')}</span>
          <span className="ml-auto flex items-center gap-1 shrink-0">
            {members.map((c, i) => (
              <span key={i} className={`h-3.5 w-3.5 rounded-full ${c}`} />
            ))}
          </span>
        </div>

        {/* World laws card */}
        <div className="mx-2.5 mt-2 rounded-md border border-border bg-background px-2 py-1.5">
          <div className="flex items-center gap-1 mb-1 text-[8px] text-muted-foreground">
            <Scale className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
            <span>{t('workflow.worldLaws')}</span>
          </div>
          <span className="block h-1.5 w-5/6 rounded bg-muted-foreground/30" />
          <span className="block h-1.5 w-2/3 rounded bg-muted-foreground/20 mt-1" />
        </div>

        {/* Turn-by-turn reasoning timeline */}
        <div className="flex-1 flex flex-col justify-center gap-1.5 px-2.5 py-2 min-h-0">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-start gap-1.5">
              <span className={`h-3.5 w-3.5 rounded-full shrink-0 ${i === 0 ? 'bg-primary' : 'bg-secondary'}`} />
              <div className="flex-1 rounded-md bg-muted px-2 py-1">
                <span className="block h-1.5 w-full rounded bg-muted-foreground/40" />
                <span className="block h-1.5 w-3/5 rounded bg-muted-foreground/25 mt-1" />
              </div>
            </div>
          ))}
          {/* "Still reasoning" — same three-dot pulse as a typing agent */}
          <div className="flex items-center gap-1 pl-5 text-[8px] text-muted-foreground">
            <Users className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
            <span className="h-1 w-1 rounded-full bg-muted-foreground animate-pulse" />
            <span className="h-1 w-1 rounded-full bg-muted-foreground animate-pulse [animation-delay:150ms]" />
            <span className="h-1 w-1 rounded-full bg-muted-foreground animate-pulse [animation-delay:300ms]" />
            <span className="ml-1 truncate">{t('intro.mock.worldTurn')}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
