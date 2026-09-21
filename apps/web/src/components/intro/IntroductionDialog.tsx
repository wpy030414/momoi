import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Sparkles } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { MockOverview } from './mocks/MockOverview'
import { MockChat } from './mocks/MockChat'
import { MockMemory } from './mocks/MockMemory'
import { MockIm } from './mocks/MockIm'
import { MockFinale } from './mocks/MockFinale'

const PAGE_COUNT = 5
// Horizontal swipe threshold: horizontal travel must exceed this many px AND
// exceed the vertical travel, so diagonal scrolls don't flip pages.
const SWIPE_THRESHOLD_PX = 48

interface IntroductionPage {
  titleKey: string
  bodyKey: string
  mock: ReactNode
}

// Page mocks are stateless presentational nodes — safe to build once at
// module level (statically imported, per the Rolldown lazy() constraint
// documented in chat/MessageContent.tsx).

const PAGES: IntroductionPage[] = [
  { titleKey: 'intro.pages.welcome.title', bodyKey: 'intro.pages.welcome.body', mock: <MockOverview /> },
  { titleKey: 'intro.pages.chat.title', bodyKey: 'intro.pages.chat.body', mock: <MockChat /> },
  { titleKey: 'intro.pages.memory.title', bodyKey: 'intro.pages.memory.body', mock: <MockMemory /> },
  { titleKey: 'intro.pages.im.title', bodyKey: 'intro.pages.im.body', mock: <MockIm /> },
  { titleKey: 'intro.pages.finale.title', bodyKey: 'intro.pages.finale.body', mock: <MockFinale /> },
]

interface IntroductionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Server-configured app name, used for {{app}} interpolation in copy. */
  appName: string
}

/**
 * First-use introduction — a 5-page horizontally paged tour (welcome →
 * personal/group conversations → AI memory → continue on IM → finale).
 * Purely controlled: the "seen" flag (localStorage) is written by the parent
 * in onOpenChange, mirroring ChangePinDialog's contract.
 *
 * Animation constraint: this project has no tailwindcss-animate — the
 * animate-in/fade-in utilities are dead classes. The only animation
 * dependencies here are transition-transform (page track) and animate-pulse
 * (typing dots inside mocks).
 */
export function IntroductionDialog({ open, onOpenChange, appName }: IntroductionDialogProps) {
  const { t } = useTranslation()
  const [index, setIndex] = useState(0)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)

  const goTo = useCallback((i: number) => {
    setIndex(Math.max(0, Math.min(PAGE_COUNT - 1, i)))
  }, [])
  const next = useCallback(() => setIndex((i) => Math.min(PAGE_COUNT - 1, i + 1)), [])
  const prev = useCallback(() => setIndex((i) => Math.max(0, i - 1)), [])

  // Reopening (e.g. from the sidebar title) always starts from page 1 —
  // same reset-on-close convention as ImBindDialog's channel state.
  useEffect(() => {
    if (!open) setIndex(0)
  }, [open])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); next() }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); prev() }
  }

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0]
    touchStartRef.current = { x: t.clientX, y: t.clientY }
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touchStartRef.current
    touchStartRef.current = null
    if (!s) return
    const t = e.changedTouches[0]
    const dx = t.clientX - s.x
    const dy = t.clientY - s.y
    if (Math.abs(dx) > SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) next()
      else prev()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-xl p-0 gap-0 overflow-hidden flex flex-col"
        onKeyDown={onKeyDown}
      >
        {/* Radix a11y requires a title; the visible titles live inside each page */}
        <DialogHeader className="sr-only">
          <DialogTitle>{t('intro.a11yTitle')}</DialogTitle>
          <DialogDescription>
            {t('intro.a11yDescription', { app: appName, total: PAGE_COUNT })}
          </DialogDescription>
        </DialogHeader>

        {/* Page track — transform-based paging (no scroll-snap: programmatic
            jumps stay measurement-free and old WebView kernels behave) */}
        <div className="overflow-hidden" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
          <div
            className="flex transition-transform duration-300 ease-out"
            style={{ transform: `translateX(-${index * 100}%)` }}
          >
            {PAGES.map((page, i) => (
              <section
                key={i}
                aria-hidden={i !== index}
                className="w-full shrink-0 h-[380px] sm:h-[430px] flex flex-col"
              >
                {/* Mock area — pt-8 keeps clear of the built-in close X */}
                <div className="flex-1 min-h-0 flex items-center justify-center p-4 pt-8">
                  {page.mock}
                </div>
                {/* Copy area — scroll fallback for unusually long translations */}
                <div className="px-6 pb-6 text-center max-h-40 overflow-y-auto">
                  <h2 className="text-base sm:text-lg font-semibold" aria-live="polite">
                    {t(page.titleKey, { app: appName })}
                  </h2>
                  <p className="mt-1.5 text-xs sm:text-sm text-muted-foreground leading-relaxed">
                    {t(page.bodyKey, { app: appName })}
                  </p>
                </div>
              </section>
            ))}
          </div>
        </div>

        {/* Footer: dot indicators + navigation */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border">
          <div className="flex items-center gap-1.5">
            {PAGES.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => goTo(i)}
                aria-label={t('intro.goToPage', { n: i + 1 })}
                className={cn(
                  'h-1.5 rounded-full transition-all duration-300',
                  i === index
                    ? 'w-5 bg-primary'
                    : 'w-1.5 bg-muted-foreground/40 hover:bg-muted-foreground/70',
                )}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {index > 0 && (
              <Button variant="ghost" onClick={prev}>
                {t('intro.prev')}
              </Button>
            )}
            {index < PAGE_COUNT - 1 ? (
              <Button className="gap-2" onClick={next}>
                {t('intro.next')}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            ) : (
              <Button className="gap-2" onClick={() => onOpenChange(false)}>
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                {t('intro.start')}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
