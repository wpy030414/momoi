import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'

// The whole admin UI (sidebar + main pane + tabs) loads as ONE chunk through
// the panel barrel — see components/admin/panel.tsx. Most users never visit
// admin settings, so this keeps the ~80 KB (gzip) out of the main bundle
// without fragmenting it into per-tab chunks.
const AdminSidebar = lazy(() => import('@/components/admin/panel').then(m => ({ default: m.AdminSidebar })))
const AdminPanelMain = lazy(() => import('@/components/admin/panel').then(m => ({ default: m.AdminPanelMain })))

const DEFAULT_ADMIN_TAB = 'gateway'

interface UseAdminPanelOptions {
  isAdminUser: boolean
  standAlone: boolean
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
  onConfigChanged: () => void
}

function AdminFallback() {
  return <div className="flex-1 flex items-center justify-center"><div className="animate-pulse text-muted-foreground text-sm">…</div></div>
}

export function useAdminPanel({
  isAdminUser,
  standAlone,
  sidebarOpen,
  setSidebarOpen,
  onConfigChanged,
}: UseAdminPanelOptions) {
  const [adminViewOpen, setAdminViewOpen] = useState(false)
  const [adminTab, setAdminTab] = useState<string>(DEFAULT_ADMIN_TAB)

  // Re-fetch app config only when admin view closes (not on mount)
  const prevOpenRef = useRef(false)
  useEffect(() => {
    if (prevOpenRef.current && !adminViewOpen) {
      onConfigChanged()
    }
    prevOpenRef.current = adminViewOpen
  }, [adminViewOpen])

  // Route guard: #/settings/{tab}
  useEffect(() => {
    const leaveAdminRoute = () => {
      setAdminViewOpen(false)
      if (window.location.hash.startsWith('#/settings')) {
        history.replaceState(null, '', window.location.pathname + window.location.search)
      }
    }
    const syncAdminRoute = () => {
      const match = window.location.hash.match(/^#\/settings(?:\/(\w+))?$/)
      if (match) {
        if (isAdminUser) {
          const tab = match[1]
          if (tab) {
            const normalized = tab === 'branding' ? 'experience' : tab
            setAdminTab(standAlone && normalized === 'users' ? DEFAULT_ADMIN_TAB : normalized)
          }
          setAdminViewOpen(true)
        } else {
          leaveAdminRoute()
        }
      } else {
        setAdminViewOpen(false)
      }
    }
    syncAdminRoute()
    window.addEventListener('hashchange', syncAdminRoute)
    return () => window.removeEventListener('hashchange', syncAdminRoute)
  }, [isAdminUser, standAlone])

  const open = useCallback(() => {
    setTimeout(() => {
      setAdminViewOpen(true)
      history.pushState(null, '', `#/settings/${adminTab}`)
    }, 300)
  }, [adminTab])

  const close = useCallback(() => {
    setAdminViewOpen(false)
    if (window.location.hash.startsWith('#/settings')) {
      history.replaceState(null, '', window.location.pathname + window.location.search)
    }
  }, [])

  const handleTabChange = useCallback((tab: string) => {
    setAdminTab(tab)
    history.pushState(null, '', `#/settings/${tab}`)
  }, [])

  const sidebarNode = (
    <Suspense fallback={<AdminFallback />}>
      <AdminSidebar
        activeTab={adminTab}
        onTabChange={handleTabChange}
        onBack={close}
        standAlone={standAlone}
      />
    </Suspense>
  )

  const mainNode = (
    <Suspense fallback={<AdminFallback />}>
      <AdminPanelMain
        activeTab={adminTab}
        standAlone={standAlone}
        sidebarOpen={sidebarOpen}
        setSidebarOpen={setSidebarOpen}
      />
    </Suspense>
  )

  return { sidebarNode, mainNode, viewOpen: adminViewOpen, open, close }
}
