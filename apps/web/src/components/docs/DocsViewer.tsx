import { useState, useEffect, useRef } from 'react'
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

export interface TocItem {
  id: string
  text: string
  level: number
}

function slugify(text: string): string {
  const slug = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
  return slug || 'section'
}

interface DocsViewerProps {
  docPath: string | null
  onTocChange?: (toc: TocItem[]) => void
}

export function DocsViewer({ docPath, onTocChange }: DocsViewerProps) {
  const { content, loading } = useDocContent(docPath)
  const articleRef = useRef<HTMLElement>(null)

  // 渲染完成后从 DOM 提取 h1–h4 → 生成目录（id 直接写到标题元素上，供滚动定位）
  useEffect(() => {
    if (!content) { onTocChange?.([]); return }
    const root = articleRef.current
    if (!root) return
    const used = new Map<string, number>()
    const items: TocItem[] = []
    root.querySelectorAll('h1,h2,h3,h4').forEach((el) => {
      const text = (el.textContent ?? '').trim()
      if (!text) return
      let id = slugify(text)
      const n = used.get(id) ?? 0
      used.set(id, n + 1)
      if (n > 0) id = `${id}-${n}`
      el.id = id
      items.push({ id, text, level: Number(el.tagName[1]) })
    })
    onTocChange?.(items)
  }, [content, onTocChange])

  if (!docPath) {
    return (
      <div className="flex-1 flex items-center justify-center bg-background">
        <div className="text-center text-muted-foreground">
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
        <article ref={articleRef} className="prose prose-sm dark:prose-invert max-w-none
          prose-headings:scroll-mt-20
          prose-h1:text-2xl prose-h1:font-bold prose-h1:mt-8 prose-h1:mb-4
          prose-h2:text-xl prose-h2:font-semibold prose-h2:mt-6 prose-h2:mb-3 prose-h2:pb-1 prose-h2:border-b
          prose-h3:text-lg prose-h3:font-semibold prose-h3:mt-5 prose-h3:mb-2
          prose-h4:text-base prose-h4:font-semibold prose-h4:mt-4 prose-h4:mb-2
          prose-p:leading-7 prose-p:mb-4
          prose-li:my-1
          prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-sm prose-code:font-normal
          prose-code:before:content-none prose-code:after:content-none
          prose-pre:bg-zinc-100 prose-pre:dark:bg-zinc-800 prose-pre:text-zinc-900 prose-pre:dark:text-zinc-100 prose-pre:shadow-sm prose-pre:border
          prose-table:border prose-table:border-collapse
          prose-th:border prose-th:px-3 prose-th:py-2 prose-th:bg-muted prose-th:text-sm prose-th:font-medium
          prose-td:border prose-td:px-3 prose-td:py-2 prose-td:text-sm
          prose-blockquote:border-l-4 prose-blockquote:border-muted-foreground/30 prose-blockquote:pl-4 prose-blockquote:text-muted-foreground
          prose-a:text-primary prose-a:underline
          prose-strong:font-semibold
          prose-hr:my-6
        ">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              // 长表格不撑宽限宽列布局：外层包横向滚动容器（与聊天消息的表格处理一致）
              table: ({ children, ...props }) => (
                <div className="my-4 overflow-x-auto">
                  <table {...props}>{children}</table>
                </div>
              ),
            }}
          >
            {content}
          </Markdown>
        </article>
      </div>
    </div>
  )
}
