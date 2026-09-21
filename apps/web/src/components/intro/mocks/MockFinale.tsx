import { Send, MessagesSquare, Users, BookOpen, Brain, Smartphone, Mic, Wrench, Infinity as InfinityIcon } from 'lucide-react'

/**
 * Introduction page 5 mock — the finale: a glowing send button ready to start
 * the first conversation, surrounded by feature bubbles recapping the whole
 * app (chat, group, docs, memory, voice, infinite mode, IM, admin panel)
 * plus a few pulsing specks. Purely decorative, semantic tokens only.
 */
export function MockFinale() {
  const bubble =
    'absolute flex items-center justify-center rounded-full bg-card border border-border shadow-sm text-primary'
  const speck = 'absolute h-1 w-1 rounded-full bg-primary/50 animate-pulse'
  return (
    <div className="relative w-[290px] h-[180px]">
      {/* Feature bubbles — sizes alternate slightly to avoid a mechanical ring */}
      <span className={`${bubble} top-0 left-[16%] h-7 w-7`}>
        <MessagesSquare className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <span className={`${bubble} top-1 right-[14%] h-6 w-6`}>
        <BookOpen className="h-3 w-3" aria-hidden="true" />
      </span>
      <span className={`${bubble} top-[30%] left-0 h-6 w-6`}>
        <Users className="h-3 w-3" aria-hidden="true" />
      </span>
      <span className={`${bubble} top-[32%] right-0 h-7 w-7`}>
        <Brain className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <span className={`${bubble} bottom-[30%] left-[5%] h-6 w-6`}>
        <Mic className="h-3 w-3" aria-hidden="true" />
      </span>
      <span className={`${bubble} bottom-[28%] right-[7%] h-7 w-7`}>
        <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <span className={`${bubble} bottom-0 left-[24%] h-6 w-6`}>
        <InfinityIcon className="h-3 w-3" aria-hidden="true" />
      </span>
      <span className={`${bubble} bottom-1 right-[26%] h-6 w-6`}>
        <Wrench className="h-3 w-3" aria-hidden="true" />
      </span>

      {/* Pulsing specks tucked between the bubbles and the center button */}
      <span className={`${speck} top-[18%] left-[32%]`} aria-hidden="true" />
      <span className={`${speck} top-[15%] right-[34%] [animation-delay:200ms]`} aria-hidden="true" />
      <span className={`${speck} top-1/2 left-[20%] [animation-delay:400ms]`} aria-hidden="true" />
      <span className={`${speck} top-1/2 right-[20%] [animation-delay:600ms]`} aria-hidden="true" />
      <span className={`${speck} bottom-[20%] left-[38%] [animation-delay:300ms]`} aria-hidden="true" />
      <span className={`${speck} bottom-[22%] right-[40%] [animation-delay:500ms]`} aria-hidden="true" />

      {/* Center: glowing send button — "start your first conversation" */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex items-center justify-center h-16 w-16 rounded-full bg-primary/10">
          <div className="flex items-center justify-center h-11 w-11 rounded-full bg-primary text-primary-foreground shadow-sm">
            <Send className="h-5 w-5" aria-hidden="true" />
          </div>
        </div>
      </div>
    </div>
  )
}
