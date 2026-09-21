import { Send, MessagesSquare, Users, BookOpen, Brain, Smartphone, Paperclip, Wrench, Infinity as InfinityIcon, Globe, Image, FileText, Shield, Code } from 'lucide-react'

/**
 * Introduction page 5 mock — the finale: a glowing send button ready to start
 * the first conversation, surrounded by feature bubbles recapping the whole
 * app (chat, group, docs, memory, attachments, infinite mode, IM, admin panel,
 * web, images, files, security, code) plus a few pulsing specks.
 * Purely decorative, semantic tokens only.
 */
export function MockFinale() {
  const bubble =
    'absolute flex items-center justify-center rounded-full bg-card border border-border shadow-sm text-primary'
  const speck = 'absolute h-1 w-1 rounded-full bg-primary/50 animate-pulse'
  return (
    <div className="relative w-[290px] h-[180px]">
      {/* Floating keyframes — gentle orbital drift, one shared @keyframes
          with per-bubble duration/delay variance so they never lockstep. */}
      <style>{`
        @keyframes float-drift {
          0%, 100% { transform: translate(0, 0) scale(1); }
          25%  { transform: translate(3px, -4px) scale(1.04); }
          50%  { transform: translate(-2px, -5px) scale(0.97); }
          75%  { transform: translate(-4px, 2px) scale(1.02); }
        }
      `}</style>

      {/* ── Perimeter bubbles ───────────────────────────────────
          Arranged around the 290×180 canvas avoiding the center
          button zone (x: 113–177 / 39%–61%, y: 58–122 / 32%–68%).
          Each has its own float-drift timing.                          */}

      {/* Top edge: left · mid-left (just before center zone) · right */}
      <span className={`${bubble} top-0.5 left-[6%] h-7 w-7 animate-[float-drift_5.8s_ease-in-out_infinite]`}>
        <MessagesSquare className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <span className={`${bubble} top-0 left-[34%] h-5 w-5 animate-[float-drift_4.4s_ease-in-out_infinite_0.6s]`}>
        <Globe className="h-2.5 w-2.5" aria-hidden="true" />
      </span>
      <span className={`${bubble} top-1 right-[7%] h-6 w-6 animate-[float-drift_6.2s_ease-in-out_infinite_1.2s]`}>
        <BookOpen className="h-3 w-3" aria-hidden="true" />
      </span>

      {/* Right edge: upper · mid · lower · inset corner */}
      <span className={`${bubble} right-0 top-[12%] h-7 w-7 animate-[float-drift_4.7s_ease-in-out_infinite_1.8s]`}>
        <Brain className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
      <span className={`${bubble} right-0 top-[38%] h-6 w-6 animate-[float-drift_5.4s_ease-in-out_infinite_0.9s]`}>
        <Shield className="h-3 w-3" aria-hidden="true" />
      </span>
      <span className={`${bubble} right-0 bottom-[28%] h-5 w-5 animate-[float-drift_4.2s_ease-in-out_infinite_2.4s]`}>
        <Image className="h-2.5 w-2.5" aria-hidden="true" />
      </span>
      <span className={`${bubble} right-[16%] bottom-[16%] h-5 w-5 animate-[float-drift_6.5s_ease-in-out_infinite_2.1s]`}>
        <Code className="h-2.5 w-2.5" aria-hidden="true" />
      </span>

      {/* Bottom edge: right · mid · left */}
      <span className={`${bubble} bottom-0 right-[5%] h-6 w-6 animate-[float-drift_4.6s_ease-in-out_infinite_1.9s]`}>
        <Wrench className="h-3 w-3" aria-hidden="true" />
      </span>
      <span className={`${bubble} bottom-0 left-[38%] h-5 w-5 animate-[float-drift_5.3s_ease-in-out_infinite_1.1s]`}>
        <FileText className="h-2.5 w-2.5" aria-hidden="true" />
      </span>
      <span className={`${bubble} bottom-1 left-[6%] h-6 w-6 animate-[float-drift_6.0s_ease-in-out_infinite_0.7s]`}>
        <InfinityIcon className="h-3 w-3" aria-hidden="true" />
      </span>

      {/* Left edge: upper · mid · lower */}
      <span className={`${bubble} left-0 top-[12%] h-6 w-6 animate-[float-drift_5.1s_ease-in-out_infinite_0.3s]`}>
        <Users className="h-3 w-3" aria-hidden="true" />
      </span>
      <span className={`${bubble} left-0 top-[38%] h-6 w-6 animate-[float-drift_5.6s_ease-in-out_infinite_0.2s]`}>
        <Paperclip className="h-3 w-3" aria-hidden="true" />
      </span>
      <span className={`${bubble} left-0 bottom-[24%] h-7 w-7 animate-[float-drift_4.9s_ease-in-out_infinite_1.5s]`}>
        <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
      </span>

      {/* Pulsing specks — tucked in gaps between perimeter bubbles */}
      <span className={`${speck} top-[8%] left-[20%]`} aria-hidden="true" />
      <span className={`${speck} top-[8%] right-[20%] [animation-delay:200ms]`} aria-hidden="true" />
      <span className={`${speck} top-[26%] left-[18%] [animation-delay:400ms]`} aria-hidden="true" />
      <span className={`${speck} top-[26%] right-[22%] [animation-delay:600ms]`} aria-hidden="true" />
      <span className={`${speck} bottom-[20%] left-[22%] [animation-delay:300ms]`} aria-hidden="true" />
      <span className={`${speck} bottom-[20%] right-[28%] [animation-delay:500ms]`} aria-hidden="true" />

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