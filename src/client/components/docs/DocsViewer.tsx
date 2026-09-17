import { useState, useEffect } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Loader2 } from 'lucide-react'
import { api } from '../../lib/api'

interface DocContent {
  content: string
  path: string
}

const cache = new Map<string, string>()

export function useDocContent(path: string | null) {
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!path) { setContent(null); return }
    if (cache.has(path)) { setContent(cache.get(path)!); return }

    let cancelled = false
    setLoading(true)
    setContent(null)

    api
      .get<DocContent>(`/api/docs/${encodeURIComponent(path)}`)
      .then((res) => {
        if (cancelled) return
        cache.set(path, res.content)
        setContent(res.content)
      })
      .catch(() => {
        if (!cancelled) setContent(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [path])

  return { content, loading }
}

interface DocsViewerProps {
  docPath: string | null
}

export function DocsViewer({ docPath }: DocsViewerProps) {
  const { content, loading } = useDocContent(docPath)

  if (!docPath) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background">
        <div className="text-center text-muted-foreground">
          <p className="text-lg mb-2">📖</p>
          <p className="text-sm">从侧边栏选择一篇文档查看</p>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!content) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">文档加载失败</p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto bg-background">
      <div className="max-w-3xl mx-auto px-6 py-8">
        {/* Markdown content */}
        <article className="prose prose-sm dark:prose-invert max-w-none
          prose-headings:scroll-mt-20
          prose-h1:text-2xl prose-h1:font-bold prose-h1:mt-8 prose-h1:mb-4
          prose-h2:text-xl prose-h2:font-semibold prose-h2:mt-6 prose-h2:mb-3 prose-h2:pb-1 prose-h2:border-b
          prose-h3:text-lg prose-h3:font-semibold prose-h3:mt-5 prose-h3:mb-2
          prose-h4:text-base prose-h4:font-semibold prose-h4:mt-4 prose-h4:mb-2
          prose-p:leading-7 prose-p:mb-4
          prose-li:my-1
          prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-normal
          prose-code:before:content-none prose-code:after:content-none
          prose-pre:bg-zinc-100 prose-pre:dark:bg-zinc-800 prose-pre:shadow-sm prose-pre:border
          prose-table:border prose-table:border-collapse
          prose-th:border prose-th:px-3 prose-th:py-2 prose-th:bg-muted prose-th:text-sm prose-th:font-medium
          prose-td:border prose-td:px-3 prose-td:py-2 prose-td:text-sm
          prose-blockquote:border-l-4 prose-blockquote:border-muted-foreground/30 prose-blockquote:pl-4 prose-blockquote:text-muted-foreground
          prose-a:text-primary prose-a:underline
          prose-strong:font-semibold
          prose-hr:my-6
        ">
          <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
        </article>
      </div>
    </div>
  )
}