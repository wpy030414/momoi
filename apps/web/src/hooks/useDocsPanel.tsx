import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { DocsSidebar } from '@/components/docs/DocsSidebar'
import type { DocEntry } from '@/components/docs/DocsSidebar'
import { DocsViewer } from '@/components/docs/DocsViewer'
import type { TocItem } from '@/components/docs/DocsViewer'
import { Button } from '@/components/ui/button'
import { PanelLeft, List } from 'lucide-react'
import { api } from '@/lib/api'

interface UseDocsPanelOptions {
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
}

export function useDocsPanel({ sidebarOpen, setSidebarOpen }: UseDocsPanelOptions) {
  const { t } = useTranslation()
  const [docsViewOpen, setDocsViewOpen] = useState(false)
  const [docsEntries, setDocsEntries] = useState<DocEntry[]>([])
  const [activeDoc, setActiveDoc] = useState<string | null>(null)
  const [docToc, setDocToc] = useState<TocItem[]>([])
  const [tocOpen, setTocOpen] = useState(false)
  const tocWrapRef = useRef<HTMLDivElement>(null)

  // Click-outside / Esc to close TOC popover
  useEffect(() => {
    if (!tocOpen) return
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (!tocWrapRef.current?.contains(e.target as Node)) setTocOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTocOpen(false) }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [tocOpen])

  // Route guard: #/docs/{path}
  useEffect(() => {
    const leaveDocsRoute = () => {
      setDocsViewOpen(false)
      if (window.location.hash.startsWith('#/docs')) {
        history.replaceState(null, '', window.location.pathname + window.location.search)
      }
    }
    const ensureDocsLoaded = () => {
      if (docsEntries.length === 0) {
        api.get<DocEntry[]>('/api/docs').then((r) => {
          setDocsEntries(r)
        }).catch(() => {})
      }
    }
    const syncDocsRoute = () => {
      const match = window.location.hash.match(/^#\/docs(?:\/(.+))?$/)
      if (match) {
        const docPath = match[1] ? decodeURIComponent(match[1]) : null
        ensureDocsLoaded()
        setDocsViewOpen(true)
        setActiveDoc((prev) => docPath || (docsEntries[0]?.path ?? null))
      } else {
        setDocsViewOpen(false)
      }
    }
    syncDocsRoute()
    window.addEventListener('hashchange', syncDocsRoute)
    return () => window.removeEventListener('hashchange', syncDocsRoute)
  }, [docsEntries.length])

  const open = useCallback(() => {
    if (docsEntries.length === 0) {
      api.get<DocEntry[]>('/api/docs').then((r) => {
        setDocsEntries(r)
        const firstDoc = r[0]?.path ?? null
        setActiveDoc(firstDoc)
        history.pushState(null, '', firstDoc ? `#/docs/${encodeURIComponent(firstDoc)}` : '#/docs')
      }).catch(() => {})
    } else {
      history.pushState(null, '', activeDoc ? `#/docs/${encodeURIComponent(activeDoc)}` : '#/docs')
    }
    setTimeout(() => {
      setDocsViewOpen(true)
    }, 100)
  }, [docsEntries.length, activeDoc])

  const close = useCallback(() => {
    setDocsViewOpen(false)
    if (window.location.hash.startsWith('#/docs')) {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [])

  const handleSelectDoc = useCallback((path: string) => {
    setActiveDoc(path)
    history.pushState(null, '', `#/docs/${encodeURIComponent(path)}`)
  }, [])

  const sidebarNode = (
    <DocsSidebar
      docs={docsEntries}
      activeDoc={activeDoc}
      onSelect={handleSelectDoc}
      onBack={close}
    />
  )

  const mainNode = (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="flex items-center justify-between px-3 border-b shrink-0" style={{ height: '60px' }}>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 hover:bg-accent/50"
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <PanelLeft className="h-4 w-4" />
        </Button>
        <div className="relative" ref={tocWrapRef}>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 hover:bg-accent/50"
            onClick={() => setTocOpen(v => !v)}
            title="目录"
          >
            <List className="h-4 w-4" />
          </Button>
          {tocOpen && (
            <div className="absolute right-0 top-full mt-2 w-64 rounded-md border bg-popover p-1 shadow-md z-50">
              <div className="max-h-[60vh] overflow-y-auto">
                {docToc.length === 0 ? (
                  <p className="px-2 py-3 text-sm text-muted-foreground text-center">{t('common.noChapters')}</p>
                ) : docToc.map((h) => (
                  <button
                    key={h.id}
                    className={`w-full text-left rounded-sm py-1.5 pr-2 text-sm truncate hover:bg-accent/60 transition-colors ${
                      h.level === 1 ? 'font-medium' : 'text-muted-foreground'
                    }`}
                    style={{ paddingLeft: `${(h.level - 1) * 14 + 8}px` }}
                    onClick={() => {
                      setTocOpen(false)
                      document.getElementById(h.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }}
                  >
                    {h.text}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <DocsViewer docPath={activeDoc} onTocChange={setDocToc} />
    </div>
  )

  return { sidebarNode, mainNode, viewOpen: docsViewOpen, open, close }
}