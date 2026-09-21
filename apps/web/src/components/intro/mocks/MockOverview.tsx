import { useState, useRef, useCallback } from 'react'
import { Sparkles } from 'lucide-react'

/**
 * Introduction page 1 mock — a miniature silhouette of the app itself:
 * sidebar strip with fake conversations + a two-bubble chat area + input bar,
 * with a sparkles badge in the middle. Semantic tokens only, so it follows
 * the light/dark/momo themes automatically.

 * Easter egg: 5 rapid clicks (within 1.5 s) on the center sparkles icon
 * reveals the latest commit hash in the simulated input bar.
 */
const CLICK_WINDOW_MS = 1500
const CLICK_COUNT_TARGET = 5

export function MockOverview() {
  const [hashRevealed, setHashRevealed] = useState(false)
  const clickTimesRef = useRef<number[]>([])

  const onSparkleClick = useCallback(() => {
    const now = Date.now()
    // Keep only clicks within the window
    clickTimesRef.current = clickTimesRef.current.filter((t) => now - t < CLICK_WINDOW_MS)
    clickTimesRef.current.push(now)
    if (clickTimesRef.current.length >= CLICK_COUNT_TARGET) {
      setHashRevealed(true)
      clickTimesRef.current = []
    }
  }, [])

  const commitHash = import.meta.env.VITE_GIT_HASH ?? 'unknown'

  return (
    <div className="relative w-[260px] rounded-lg border border-border bg-card overflow-hidden shadow-sm">
      <div className="flex h-[170px]">
        {/* Sidebar strip */}
        <div className="w-16 shrink-0 bg-accent/40 border-r border-border p-2 space-y-2">
          <div className="h-2 rounded bg-primary/60" />
          <div className="h-1.5 rounded bg-muted-foreground/30" />
          <div className="h-1.5 rounded bg-muted-foreground/30" />
          <div className="h-1.5 w-2/3 rounded bg-muted-foreground/20" />
        </div>
        {/* Chat area */}
        <div className="flex-1 bg-background flex flex-col p-2.5 gap-2 min-w-0">
          <div className="flex-1 flex flex-col justify-center gap-2">
            {/* AI bubble */}
            <div className="self-start max-w-[80%] h-2.5 w-3/5 rounded-lg rounded-bl-sm bg-muted" />
            {/* User bubble */}
            <div className="self-end max-w-[80%] h-2.5 w-2/5 rounded-lg rounded-br-sm bg-primary" />
          </div>
          {/* Input bar */}
          <div
            className={`h-5 rounded-md border border-border bg-card flex items-center px-2 overflow-hidden transition-colors ${
              hashRevealed ? 'border-primary/50 bg-primary/5' : ''
            }`}
          >
            {hashRevealed ? (
              <span className="text-[9px] text-muted-foreground font-mono leading-none truncate">
                {commitHash}
              </span>
            ) : null}
          </div>
        </div>
      </div>
      {/* Center badge */}
      <div className="absolute inset-0 flex items-center justify-center">
        <button
          type="button"
          onClick={onSparkleClick}
          className="flex items-center justify-center h-9 w-9 rounded-full bg-card border border-border shadow-sm hover:bg-accent transition-colors cursor-default"
          aria-label="Sparkle"
        >
          <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}