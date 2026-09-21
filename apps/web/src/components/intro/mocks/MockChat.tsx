import { FileText, Send } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * Introduction page 2 mock — a miniature conversation view covering the
 * talking points of the page: group conversation (two AI agents answering),
 * document handling (file chip inside the user bubble) and Infinite Mode
 * (the mini toggle next to the input bar). Semantic tokens only.
 */
export function MockChat() {
  const { t } = useTranslation()
  return (
    <div className="w-[260px] rounded-lg border border-border bg-card overflow-hidden shadow-sm">
      <div className="flex flex-col h-[190px]">
        {/* Agent strip (group members) */}
        <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-border">
          <span className="h-4 w-4 rounded-full bg-primary ring-1 ring-primary ring-offset-1 ring-offset-card" />
          <span className="h-4 w-4 rounded-full bg-secondary" />
          <span className="h-4 w-4 rounded-full bg-muted border border-border" />
        </div>

        {/* Messages */}
        <div className="flex-1 flex flex-col justify-center gap-2 px-2.5 min-h-0">
          {/* User bubble with a document chip */}
          <div className="self-end max-w-[85%] rounded-lg rounded-br-sm bg-primary text-primary-foreground px-2 py-1.5 space-y-1">
            <span className="flex items-center gap-1 rounded-md bg-primary-foreground/20 px-1.5 py-0.5 text-[8px] leading-none">
              <FileText className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{t('intro.mock.docName')}</span>
            </span>
            <span className="block h-1.5 w-4/5 rounded bg-primary-foreground/40" />
          </div>

          {/* Agent A answer */}
          <div className="self-start flex items-end gap-1 max-w-[85%]">
            <span className="h-3.5 w-3.5 rounded-full bg-primary shrink-0" />
            <div className="rounded-lg rounded-bl-sm bg-muted px-2 py-1.5">
              <span className="block text-[8px] leading-none text-muted-foreground mb-1">{t('intro.mock.agentA')}</span>
              <span className="block h-1.5 w-full rounded bg-muted-foreground/40" />
              <span className="block h-1.5 w-3/5 rounded bg-muted-foreground/30 mt-1" />
            </div>
          </div>

          {/* Agent B typing */}
          <div className="self-start flex items-end gap-1">
            <span className="h-3.5 w-3.5 rounded-full bg-secondary shrink-0" />
            <div className="rounded-lg rounded-bl-sm bg-muted px-2 py-1.5">
              <span className="block text-[8px] leading-none text-muted-foreground mb-1">{t('intro.mock.agentB')}</span>
              <span className="flex items-center gap-0.5" aria-label={t('intro.mock.typing')}>
                <span className="h-1 w-1 rounded-full bg-muted-foreground animate-pulse" />
                <span className="h-1 w-1 rounded-full bg-muted-foreground animate-pulse [animation-delay:150ms]" />
                <span className="h-1 w-1 rounded-full bg-muted-foreground animate-pulse [animation-delay:300ms]" />
              </span>
            </div>
          </div>
        </div>

        {/* Input bar + Infinite Mode toggle */}
        <div className="flex items-center gap-2 px-2.5 pb-2.5">
          <div className="flex-1 flex items-center justify-between h-6 rounded-md border border-border bg-background px-1.5">
            <span className="text-[9px] text-muted-foreground truncate">{t('intro.mock.inputPlaceholder')}</span>
            <Send className="h-3 w-3 text-primary shrink-0" aria-hidden="true" />
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-[8px] text-muted-foreground">{t('chat.infiniteMode')}</span>
            <span className="relative inline-block w-6 h-3.5 rounded-full bg-primary">
              <span className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full bg-primary-foreground" />
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
