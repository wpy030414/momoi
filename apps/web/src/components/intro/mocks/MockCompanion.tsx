import { Bell, RefreshCw, Search, Smartphone } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** Unread badge count — a bare numeral, same convention as the real sidebar. */
const UNREAD = 3

/**
 * Introduction page 8 mock — the same account across devices: a sidebar card on
 * the left (with search + an unread badge), a phone outline on the right, a
 * pulsing sync hub between them, and two ambient chips below — the offline
 * nudge and the on-return greeting. Semantic tokens only.
 */
export function MockCompanion() {
  const { t } = useTranslation()
  return (
    <div className="relative w-[290px] h-[185px]">
      {/* Desktop sidebar card */}
      <div className="absolute top-0 left-0 w-[112px] rounded-lg border border-border bg-card p-1.5 shadow-sm">
        {/* Search */}
        <div className="flex items-center gap-1 rounded border border-border bg-background px-1 py-1 mb-1.5">
          <Search className="h-2.5 w-2.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="text-[8px] leading-none text-muted-foreground truncate">{t('intro.mock.searchHint')}</span>
        </div>
        {/* Conversation rows — first one carries the unread badge */}
        {[0, 1].map((i) => (
          <div
            key={i}
            className={`flex items-center gap-1 rounded px-1 py-1 ${i === 0 ? 'bg-accent' : ''}`}
          >
            <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${i === 0 ? 'bg-primary' : 'bg-muted border border-border'}`} />
            <span className={`h-1.5 rounded bg-muted-foreground/40 ${i === 0 ? 'w-3/5' : 'w-4/5'}`} />
            {i === 0 && (
              <span className="ml-auto inline-flex items-center justify-center min-w-[12px] h-[12px] px-0.5 rounded-full bg-primary text-primary-foreground text-[8px] font-bold leading-none shrink-0">
                {UNREAD}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Phone outline */}
      <div className="absolute top-0 right-0 w-[84px] h-[112px] rounded-xl border-2 border-border bg-card p-1.5 shadow-sm flex flex-col">
        <span className="flex items-center justify-center gap-1 mb-1.5 text-muted-foreground">
          <Smartphone className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
          <span className="h-1.5 w-8 rounded-full bg-accent" />
        </span>
        <div className="space-y-1.5">
          <div className="ml-auto w-4/5 rounded-lg rounded-br-sm bg-primary px-1.5 py-1">
            <span className="block h-1.5 w-full rounded bg-primary-foreground/40" />
          </div>
          <div className="w-4/5 rounded-lg rounded-bl-sm bg-muted px-1.5 py-1">
            <span className="block h-1.5 w-full rounded bg-muted-foreground/40" />
          </div>
        </div>
      </div>

      {/* Sync hub — same concentric-ring idiom as the finale's center button */}
      <div className="absolute top-[30px] left-1/2 -translate-x-1/2 flex items-center justify-center h-9 w-9 rounded-full bg-primary/10 animate-pulse">
        <div className="flex items-center justify-center h-6 w-6 rounded-full bg-primary text-primary-foreground">
          <RefreshCw className="h-3 w-3" aria-hidden="true" />
        </div>
      </div>

      {/* Ambient chips: offline nudge (left) + on-return greeting (right) */}
      <div className="absolute bottom-0 left-0 flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 shadow-sm text-[8px] leading-none">
        <Bell className="h-2.5 w-2.5 shrink-0 text-primary" aria-hidden="true" />
        <span className="truncate max-w-[104px]">{t('intro.mock.pushNudge')}</span>
      </div>
      <div className="absolute bottom-0 right-0 flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 shadow-sm text-[8px] leading-none">
        <span className="h-2.5 w-2.5 rounded-full bg-primary shrink-0" />
        <span className="truncate max-w-[96px]">{t('intro.mock.greetingText')}</span>
      </div>
    </div>
  )
}
