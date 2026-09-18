import { useTranslation } from 'react-i18next'
import { Play, Pause, RotateCcw, Loader2 } from 'lucide-react'
import { useVoice } from '../../hooks/useVoice'

interface VoicePlayButtonProps {
  agentId: string
  messageId: number
  text: string
  enabled: boolean
}

export function VoicePlayButton({ agentId, messageId, text, enabled }: VoicePlayButtonProps) {
  const { t } = useTranslation()
  const {
    playState,
    allReady,
    currentTimeFormatted,
    totalDurationFormatted,
    play,
    pause,
    resume,
  } = useVoice({ agentId, messageId, text, enabled })

  if (!enabled) return null

  const handleClick = () => {
    switch (playState) {
      case 'idle':
      case 'ready':
      case 'done':
        play()
        break
      case 'playing':
        pause()
        break
      case 'paused':
        resume()
        break
      // loading/synthesizing: no action
    }
  }

  const isBusy = playState === 'loading' || playState === 'synthesizing'

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1 ml-1">
      <button
        onClick={handleClick}
        disabled={isBusy}
        className="inline-flex items-center gap-1 hover:text-foreground transition-colors disabled:opacity-50"
        title={
          playState === 'playing' ? t('voice.pause', 'Pause') :
          playState === 'paused' ? t('voice.resume', 'Resume') :
          t('voice.play', 'Play voice')
        }
      >
        {isBusy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : playState === 'playing' ? (
          <Pause className="h-3.5 w-3.5" />
        ) : playState === 'done' ? (
          <RotateCcw className="h-3.5 w-3.5" />
        ) : (
          <Play className="h-3.5 w-3.5" />
        )}
        <span>
          {isBusy
            ? t('voice.loading', 'Loading...')
            : playState === 'playing'
              ? `${currentTimeFormatted} / ${totalDurationFormatted}`
              : playState === 'done'
                ? t('voice.replay', 'Replay')
                : allReady
                  ? `${t('voice.play', 'Play')} ${totalDurationFormatted}`
                  : t('voice.play', 'Play voice')
          }
        </span>
      </button>
      {allReady && playState === 'idle' && (
        <span className="text-green-500/70">✓</span>
      )}
    </div>
  )
}