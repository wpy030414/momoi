import { useState, useEffect, useRef, useMemo, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import type { Components } from 'react-markdown'

// Lazy-load react-markdown (~39 KB gzip) — most users see at least one assistant
// message, so we preload on first render rather than waiting for a user interaction.
// The first message renders as plain text; once the module loads, all messages
// switch to full Markdown rendering.
const LazyMarkdown = lazy(() => import('react-markdown'))
let _remarkGfm: any = null
function getRemarkGfm() {
  if (!_remarkGfm) {
    _remarkGfm = import('remark-gfm').then(m => m.default ?? m)
  }
  return _remarkGfm
}

interface MessageContentProps {
  content: string
  streaming?: boolean
  isUser?: boolean
}

const STREAM_THROTTLE_MS = 120

/** Regex to match @AgentName mentions (word chars + CJK chars after @) */
const MENTION_RE = /(@[\w一-鿿぀-ゟ゠-ヿ]+)/g

/**
 * Convert @Name mentions to markdown links so they render inline
 * inside the same paragraph. We use a custom x-mention: protocol
 * that won't be stripped by react-markdown's default URL sanitizer.
 */
function processMentions(content: string): string {
  return content.replace(MENTION_RE, (match) => {
    const name = match.slice(1)
    return `[@${name}](x-mention:${encodeURIComponent(name)})`
  })
}

export function MessageContent({ content, streaming, isUser }: MessageContentProps) {
  const [renderedContent, setRenderedContent] = useState(content)
  // Track whether react-markdown + remark-gfm have finished loading
  const [gfmReady, setGfmReady] = useState(false)
  const [remarkGfm, setRemarkGfm] = useState<any>(null)

  // Preload remark-gfm on first mount
  useEffect(() => {
    getRemarkGfm().then((m: any) => {
      setRemarkGfm(m)
      setGfmReady(true)
    })
  }, [])

  useEffect(() => {
    if (!streaming) {
      setRenderedContent(content)
      return
    }
    const timer = setTimeout(() => {
      setRenderedContent(content)
    }, STREAM_THROTTLE_MS)
    return () => clearTimeout(timer)
  }, [content, streaming])

  const safeContent = useMemo(
    () => sanitizeIncompleteMarkdown(renderedContent),
    [renderedContent],
  )

  const markdownComponents = useMemo<Components>(() => ({
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
    a: ({ href, children, node, ...rest }: any) => {
      const hrefStr = typeof href === 'string' ? href : ''
      if (hrefStr.startsWith('x-mention:')) {
        const name = decodeURIComponent(hrefStr.slice('x-mention:'.length))
        return (
          <span
            className={`inline-flex items-center gap-0.5 px-1 py-0.5 rounded-md font-medium text-sm border align-baseline select-none ${
              isUser
                ? 'bg-muted text-muted-foreground border-border'
                : 'bg-primary/10 text-primary border-primary/20'
            }`}
          >
            @{name}
          </span>
        )
      }
      return <a href={hrefStr} className="text-primary underline" target="_blank" rel="noopener noreferrer" {...rest}>{children}</a>
    },
  }), [isUser])

  const parts = safeContent.split(/(```mermaid[\s\S]*?```)/g)

  // Fallback rendering while react-markdown is still loading
  if (!gfmReady) {
    return (
      <div className={`prose prose-sm max-w-none [&_p]:my-1.5 [&>:first-child]:mt-0 [&>:last-child]:mb-0 ${isUser ? '[color:inherit] [--tw-prose-body:currentColor] [--tw-prose-headings:currentColor] [--tw-prose-bold:currentColor] [--tw-prose-links:currentColor] [--tw-prose-code:currentColor] [--tw-prose-counters:currentColor] [--tw-prose-bullets:currentColor] [--tw-prose-quotes:currentColor]' : 'dark:prose-invert'}`}>
        {parts.map((part, idx) => {
          if (part.startsWith('```mermaid')) {
            return <pre key={idx} className="text-xs bg-muted p-2 rounded overflow-x-auto">{part}</pre>
          }
          if (!part) return null
          return <p key={idx} className="whitespace-pre-wrap">{part}</p>
        })}
      </div>
    )
  }

  return (
    <div className={`prose prose-sm max-w-none [&_p]:my-1.5 [&>:first-child]:mt-0 [&>:last-child]:mb-0 ${isUser ? '[color:inherit] [--tw-prose-body:currentColor] [--tw-prose-headings:currentColor] [--tw-prose-bold:currentColor] [--tw-prose-links:currentColor] [--tw-prose-code:currentColor] [--tw-prose-counters:currentColor] [--tw-prose-bullets:currentColor] [--tw-prose-quotes:currentColor]' : 'dark:prose-invert'}`}>
      {parts.map((part, idx) => {
        if (part.startsWith('```mermaid')) {
          if (streaming) {
            return <pre key={idx} className="text-xs bg-muted p-2 rounded overflow-x-auto">{part}</pre>
          }
          const chart = part.replace(/```mermaid\n?/, '').replace(/\n?```$/, '')
          return <MermaidBlock key={idx} chart={chart} />
        }
        if (!part) return null
        const processed = processMentions(part)
        return (
          <Suspense key={idx} fallback={<p className="whitespace-pre-wrap">{processed}</p>}>
            <LazyMarkdown remarkPlugins={remarkGfm ? [remarkGfm] : []} components={markdownComponents} urlTransform={(url: string) => url}>
              {processed}
            </LazyMarkdown>
          </Suspense>
        )
      })}
    </div>
  )
}

/**
 * Fix incomplete markdown that would render as garbled text during streaming.
 */
function sanitizeIncompleteMarkdown(text: string): string {
  if (!text) return text

  let result = text

  const fenceCount = (result.match(/^```/gm) || []).length
  if (fenceCount % 2 !== 0) {
    result += '\n```'
  }

  const backtickCount = (result.match(/(?<!`)`(?!`)/g) || []).length
  if (backtickCount % 2 !== 0) {
    result += '`'
  }

  const boldCount = (result.match(/\*\*/g) || []).length
  if (boldCount % 2 !== 0) {
    result += '**'
  }

  const italicCount = (result.match(/(?<!\*)\*(?!\*)/g) || []).length
  if (italicCount % 2 !== 0) {
    result += '*'
  }

  result = result.replace(/\!?\[[^\]]*$/, '')

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