import { useMemo } from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownViewProps {
  content: string
  isUser?: boolean
}

/**
 * Full markdown rendering for message content.
 *
 * This module is the lazy-loading boundary: it statically imports
 * react-markdown + remark-gfm so the whole dependency tree is code-split as
 * ONE component-level chunk — the same pattern DocsViewer uses. Do not
 * dynamic-import these libraries directly; React.lazy must resolve to a
 * component module, not a bare library namespace.
 */
export function MarkdownView({ content, isUser }: MarkdownViewProps) {
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

  return (
    <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents} urlTransform={(url: string) => url}>
      {content}
    </Markdown>
  )
}
