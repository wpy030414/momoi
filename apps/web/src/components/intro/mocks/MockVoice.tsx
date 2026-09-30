import { Play, Volume2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** Waveform bar heights (px) — module-level constant, keeps the component stateless. */
const WAVE = [4, 9, 6, 12, 7, 10, 5, 11, 6, 8, 4, 7]
/** Bars before this index are "played" (primary-tinted), the rest are muted. */
const PLAYED_UPTO = 5

/**
 * Introduction page 6 mock — an agent reply with its synthesized voice: a play
 * button, a waveform with a played/unplayed split, and an "auto voice" pill.
 * Semantic tokens only.
 */
export function MockVoice() {
  const { t } = useTranslation()
  return (
    <div className="w-[250px] flex flex-col gap-2.5">
      {/* Agent bubble */}
      <div className="self-start flex items-start gap-1.5 w-full">
        <span className="h-4 w-4 rounded-full bg-primary shrink-0 mt-0.5" />
        <div className="flex-1 rounded-lg rounded-bl-sm bg-muted px-2 py-1.5">
          <span className="block text-[8px] leading-none text-muted-foreground mb-1">{t('intro.mock.agentA')}</span>
          <span className="block h-1.5 w-full rounded bg-muted-foreground/40" />
          <span className="block h-1.5 w-2/3 rounded bg-muted-foreground/30 mt-1" />
        </div>
      </div>

      {/* Voice player: play button + waveform + duration */}
      <div className="flex items-center gap-2 pl-5">
        <span className="flex items-center justify-center h-6 w-6 rounded-full bg-primary text-primary-foreground shrink-0">
          <Play className="h-3 w-3" aria-hidden="true" />
        </span>
        <span className="flex items-end gap-[2px] h-4" aria-hidden="true">
          {WAVE.map((h, i) => (
            <span
              key={i}
              className={`w-[2px] rounded-full ${i < PLAYED_UPTO ? 'bg-primary/70' : 'bg-muted-foreground/40'}`}
              style={{ height: `${h}px` }}
            />
          ))}
        </span>
        <span className="text-[8px] text-muted-foreground tabular-nums">0:07</span>
      </div>

      {/* Auto-synthesis pill */}
      <div className="self-end flex items-center gap-1 rounded-full border border-border bg-card px-1.5 py-0.5 text-[8px] text-muted-foreground">
        <Volume2 className="h-2.5 w-2.5 shrink-0 text-primary" aria-hidden="true" />
        <span>{t('intro.mock.voiceLabel')}</span>
      </div>
    </div>
  )
}
