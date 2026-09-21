import { ArrowRight, Smartphone } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * Introduction page 4 mock — a mini conversation flowing into a phone
 * outline with IM-style bubbles: "take the conversation to your IM".
 * Semantic tokens only.
 */
export function MockIm() {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3">
      {/* Mini web conversation */}
      <div className="w-[110px] rounded-lg border border-border bg-card p-2 space-y-1.5 shadow-sm">
        <div className="h-2.5 w-3/5 ml-auto rounded-lg rounded-br-sm bg-primary" />
        <div className="h-2.5 w-4/5 rounded-lg rounded-bl-sm bg-muted" />
        <div className="h-1.5 w-2/3 rounded bg-muted-foreground/25" />
        <div className="h-1.5 w-1/2 rounded bg-muted-foreground/20" />
      </div>

      {/* Flow arrow */}
      <div className="flex flex-col items-center gap-0.5 text-primary shrink-0">
        <Smartphone className="h-4 w-4" aria-hidden="true" />
        <ArrowRight className="h-5 w-5" aria-hidden="true" />
      </div>

      {/* Phone outline with IM bubbles */}
      <div className="w-[92px] h-[150px] rounded-xl border-2 border-border bg-card p-1.5 shadow-sm shrink-0 flex flex-col">
        <div className="h-2 mx-auto mb-1.5 w-1/3 rounded-full bg-accent" />
        <div className="space-y-1.5">
          <div className="ml-auto w-4/5 rounded-lg rounded-br-sm bg-primary px-1.5 py-1">
            <span className="block h-1.5 w-full rounded bg-primary-foreground/40" />
          </div>
          <div className="w-4/5 rounded-lg rounded-bl-sm bg-muted px-1.5 py-1">
            <span className="block text-[8px] leading-snug text-foreground truncate">{t('intro.mock.imMessage')}</span>
          </div>
          <div className="w-3/5 rounded-lg rounded-bl-sm bg-muted px-1.5 py-1">
            <span className="block h-1.5 w-full rounded bg-muted-foreground/40" />
          </div>
        </div>
        <div className="mt-auto h-4 rounded-md border border-border bg-background" />
      </div>
    </div>
  )
}
