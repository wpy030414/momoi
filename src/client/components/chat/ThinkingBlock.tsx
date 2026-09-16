import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import type { ThinkingSegment } from '@/shared/thinking'
import { decodeThinkingToSegments, isThinkingTruncated } from '@/shared/thinking'
import { THINKING_TRUNCATED_MARK } from '@/shared/constants'

interface ThinkingBlockProps {
  /** 完整思考文本（含分隔符）。无 segments 时按单块展示。 */
  content: string
  /** 按工具轮分组的分段；有则按段展示，无则回退 content 单块。 */
  segments?: ThinkingSegment[]
  /** true = thinking already finished (label "thought"), false = still streaming */
  done?: boolean
  /** 由外部 verbose 开关控制；false 时整块不渲染 */
  verbose?: boolean
}

export function ThinkingBlock({ content, segments, done, verbose }: ThinkingBlockProps) {
  const { t } = useTranslation()

  // verbose=false → 隐藏思考内容
  if (!verbose) {
    return null
  }

  // 若未显式提供分段，则从含分隔符的完整文本解析（历史消息/流式兼容）
  const resolved = segments && segments.length > 0 ? segments : decodeThinkingToSegments(content)
  const multiSegment = resolved.length > 1
  const truncatedAny = resolved.some((s) => isThinkingTruncated(s.text))

  return (
    <div className="mb-2">
      {truncatedAny && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground mb-1">
          {multiSegment && (
            <span className="text-muted-foreground/70">（{resolved.length}）</span>
          )}
          <span className="inline-flex items-center gap-0.5 text-amber-500">
            <AlertTriangle className="h-3 w-3" />
            {t('chat.thinkingTruncated')}
          </span>
        </div>
      )}
      {multiSegment ? (
        <div className="space-y-2">
          {resolved.map((seg, idx) => (
            <div
              key={idx}
              className="text-xs text-muted-foreground bg-muted/50 p-2 rounded max-h-60 overflow-y-auto whitespace-pre-wrap break-words"
            >
              <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                <span>{t('chat.thinkingSegment', { n: idx + 1 })}</span>
                {isThinkingTruncated(seg.text) && (
                  <span className="inline-flex items-center gap-0.5 text-amber-500">
                    <AlertTriangle className="h-3 w-3" />
                    {t('chat.thinkingTruncated')}
                  </span>
                )}
              </div>
              <pre className="whitespace-pre-wrap break-words">
                {seg.text.replace(THINKING_TRUNCATED_MARK, '')}
              </pre>
            </div>
          ))}
        </div>
      ) : (
        <pre className="text-xs text-muted-foreground bg-muted/50 p-2 rounded max-h-60 overflow-y-auto whitespace-pre-wrap break-words">
          {resolved[0]?.text.replace(THINKING_TRUNCATED_MARK, '') ?? content.replace(THINKING_TRUNCATED_MARK, '')}
        </pre>
      )}
    </div>
  )
}
