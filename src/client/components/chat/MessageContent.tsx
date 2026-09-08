import { useState, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MessageContentProps {
  content: string
  streaming?: boolean
}

const STREAM_THROTTLE_MS = 120

/** Regex to match @AgentName mentions (word chars + CJK chars after @) */
const MENTION_RE = /(@[\w一-鿿぀-ゟ゠-ヿ]+)/g

/** Custom markdown components — shadcn-style table rendering */
const markdownComponents: Components = {
  hr: ({ ...props }) => (
    <hr className="my-4 border-border" {...props} />
  ),
  table: ({ children, ...props }) => (
    <div className="my-4 overflow-x-auto rounded-lg border">
      <table className="w-full text-sm" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }) => (
    <thead className="bg-muted/50" {...props}>{children}</thead>
  ),
  tbody: ({ children, ...props }) => (
    <tbody className="divide-y" {...props}>{children}</tbody>
  ),
  tr: ({ children, ...props }) => (
    <tr className="border-b last:border-b-0" {...props}>{children}</tr>
  ),
  th: ({ children, ...props }) => (
    <th className="px-3 py-2 text-left font-medium text-muted-foreground" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="px-3 py-2" {...props}>
      {children}
    </td>
  ),
}

/**
 * Split content by @mention patterns and render mentions as highlighted tags.
 * Non-mention parts are rendered as regular Markdown.
 */
function renderContentWithMentions(content: string, streaming?: boolean): React.ReactNode[] {
  const parts = content.split(MENTION_RE)
  return parts.map((part, idx) => {
    if (part.startsWith('@')) {
      return (
        <span
          key={idx}
          className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded-md bg-primary/10 text-primary font-medium text-sm border border-primary/20 align-baseline"
        >
          {part}
        </span>
      )
    }
    if (!part) return null
    return <Markdown key={idx} remarkPlugins={[remarkGfm]} components={markdownComponents}>{part}</Markdown>
  })
}

export function MessageContent({ content, streaming }: MessageContentProps) {
  // Throttle content updates during streaming to avoid re-parsing markdown
  // on every single token (which causes garbled rendering)
  const [renderedContent, setRenderedContent] = useState(content)

  useEffect(() => {
    if (!streaming) {
      // Not streaming — show final content immediately
      setRenderedContent(content)
      return
    }

    // During streaming: throttle updates
    const timer = setTimeout(() => {
      setRenderedContent(content)
    }, STREAM_THROTTLE_MS)

    return () => clearTimeout(timer)
  }, [content, streaming])

  // Stabilize the markdown output to avoid unnecessary re-renders
  const safeContent = useMemo(
    () => sanitizeIncompleteMarkdown(renderedContent),
    [renderedContent],
  )

  // Split content by mermaid code blocks
  const parts = safeContent.split(/(```mermaid[\s\S]*?```)/g)

  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      {parts.map((part, idx) => {
        if (part.startsWith('```mermaid')) {
          // Don't render mermaid while streaming (incomplete chart syntax)
          if (streaming) {
            return <pre key={idx} className="text-xs bg-muted p-2 rounded">{part}</pre>
          }
          const chart = part.replace(/```mermaid\n?/, '').replace(/\n?```$/, '')
          return <MermaidBlock key={idx} chart={chart} />
        }
        // Render with @mention highlighting
        return <span key={idx}>{renderContentWithMentions(part, streaming)}</span>
      })}
    </div>
  )
}

/**
 * Fix incomplete markdown that would render as garbled text during streaming.
 * - Close unclosed code fences
 * - Balance inline formatting markers
 * - Remove trailing partial markdown constructs
 */
function sanitizeIncompleteMarkdown(text: string): string {
  if (!text) return text

  let result = text

  // Fix unclosed code fences: if odd number of ``` lines, add closing fence
  const fenceCount = (result.match(/^```/gm) || []).length
  if (fenceCount % 2 !== 0) {
    result += '\n```'
  }

  // Fix unclosed inline code (single backtick)
  const backtickCount = (result.match(/(?<!`)`(?!`)/g) || []).length
  if (backtickCount % 2 !== 0) {
    result += '`'
  }

  // Balance bold markers (**) — if odd count, close with **
  const boldCount = (result.match(/\*\*/g) || []).length
  if (boldCount % 2 !== 0) {
    result += '**'
  }

  // Balance italic markers (single *) — count non-bold asterisks
  // Simple heuristic: if total standalone * is odd, add closing *
  const italicCount = (result.match(/(?<!\*)\*(?!\*)/g) || []).length
  if (italicCount % 2 !== 0) {
    result += '*'
  }

  // Remove trailing partial link/image syntax: [... or ![...
  result = result.replace(/\!?\[[^\]]*$/, '')

  // Remove trailing table row without closing
  // (incomplete | table | rows | can crash the parser)

  return result
}

function MermaidBlock({ chart }: { chart: string }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string>('')

  useEffect(() => {
    let cancelled = false

    import('mermaid').then(async (m) => {
      if (cancelled) return
      try {
        m.default.initialize({ startOnLoad: false, theme: 'default' })
        const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`
        const { svg: rendered } = await m.default.render(id, chart)
        if (!cancelled) setSvg(rendered)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t('chat.renderFailed'))
      }
    })

    return () => { cancelled = true }
  }, [chart])

  if (error) {
    return (
      <pre className="text-xs text-destructive bg-muted p-2 rounded overflow-x-auto">
        {chart}
      </pre>
    )
  }

  return (
    <div
      className="mermaid-container"
      ref={ref}
      dangerouslySetInnerHTML={{ __html: svg || t('common.loading') }}
    />
  )
}
