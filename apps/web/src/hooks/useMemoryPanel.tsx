import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react'
import { Loading } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { PanelLeft } from 'lucide-react'
import { api } from '@/lib/api'
import type { UserAgentMemory } from '@momoi/shared/types'

// Lazy-load memory panel components — most users never visit the memory page.
const MemorySidebar = lazy(() => import('@/components/memory/MemorySidebar').then(m => ({ default: m.MemorySidebar })))
const MemoryManager = lazy(() => import('@/components/memory/MemoryManager').then(m => ({ default: m.MemoryManager })))

interface UseMemoryPanelOptions {
  agents: Array<{ id: string; name: string; avatar: string; voice_enabled?: boolean }>
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
}

export function useMemoryPanel({ agents, sidebarOpen, setSidebarOpen }: UseMemoryPanelOptions) {
  const [memoryViewOpen, setMemoryViewOpen] = useState(false)
  const [memoryEntries, setMemoryEntries] = useState<UserAgentMemory[]>([])
  const [memoryAgentId, setMemoryAgentId] = useState<string | null>(null)
  const [memoriesLoading, setMemoriesLoading] = useState(false)

  // Route guard: #/memories/{agentId}
  useEffect(() => {
    const syncMemoryRoute = () => {
      const match = window.location.hash.match(/^#\/memories(?:\/([^/]+))?$/)
      if (match) {
        api.listMemories().then((r) => setMemoryEntries(r.memories)).catch(() => {})
        if (match[1]) setMemoryAgentId(decodeURIComponent(match[1]))
        setMemoryViewOpen(true)
      } else {
        setMemoryViewOpen(false)
      }
    }
    syncMemoryRoute()
    window.addEventListener('hashchange', syncMemoryRoute)
    return () => window.removeEventListener('hashchange', syncMemoryRoute)
  }, [])

  const refreshMemories = useCallback(() => {
    setMemoriesLoading(true)
    api.listMemories()
      .then((r) => setMemoryEntries(r.memories))
      .catch(() => {})
      .finally(() => setMemoriesLoading(false))
  }, [])

  const open = useCallback(() => {
    api.listMemories().then((r) => {
      setMemoryEntries(r.memories)
      const stillValid = (id: string | null): string | null =>
        id && (agents.some((a) => a.id === id) || r.memories.some((m) => m.agent_id === id)) ? id : null
      setMemoryAgentId((prev) =>
        stillValid(prev) ?? stillValid(r.memories[0]?.agent_id ?? null) ?? agents[0]?.id ?? null
      )
    }).catch(() => {})
    history.pushState(null, '', '#/memories')
    setTimeout(() => { setMemoryViewOpen(true) }, 100)
  }, [agents])

  const close = useCallback(() => {
    setMemoryViewOpen(false)
    if (window.location.hash.startsWith('#/memories')) {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [])

  const handleSelectAgent = useCallback((agentId: string) => {
    setMemoryAgentId(agentId)
    history.replaceState(null, '', `#/memories/${encodeURIComponent(agentId)}`)
  }, [])

  const activeMemoryAgent = useMemo(() =>
    memoryAgentId && (agents.some((a) => a.id === memoryAgentId) || memoryEntries.some((m) => m.agent_id === memoryAgentId))
      ? memoryAgentId
      : agents[0]?.id ?? null,
    [memoryAgentId, agents, memoryEntries]
  )

  const sidebarNode = (
    <Suspense fallback={<Loading className="flex-1 h-full" size="lg" />}>
      <MemorySidebar
        agents={agents}
        memories={memoryEntries}
        activeAgentId={activeMemoryAgent}
        onSelect={handleSelectAgent}
        onBack={close}
      />
    </Suspense>
  )

  const mainNode = (
    <Suspense fallback={<Loading className="flex-1 h-full" size="lg" />}>
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
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="max-w-3xl mx-auto px-6 pb-8">
            <MemoryManager
              agentId={activeMemoryAgent}
              agent={activeMemoryAgent ? agents.find((a) => a.id === activeMemoryAgent) ?? null : null}
              memories={memoryEntries}
              loading={memoriesLoading}
              onChanged={refreshMemories}
            />
          </div>
        </div>
      </div>
    </Suspense>
  )

  return { sidebarNode, mainNode, viewOpen: memoryViewOpen, open, close }
}