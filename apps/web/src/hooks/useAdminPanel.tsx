import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { AdminSidebar, ADMIN_TABS } from '@/components/admin/AdminSidebar'
import { AgentManager } from '@/components/admin/tabs/AgentManager'
import { GatewaySettings } from '@/components/admin/tabs/GatewaySettings'
import { ExperienceSettings } from '@/components/admin/tabs/ExperienceSettings'
import { McpManager } from '@/components/admin/tabs/McpManager'
import { SkillManager } from '@/components/admin/tabs/SkillManager'
import { ReviewPanel } from '@/components/admin/tabs/ReviewPanel'
import { UserManager } from '@/components/admin/tabs/UserManager'
import type { AgentManagerHandle } from '@/components/admin/tabs/AgentManager'
import type { GatewaySettingsHandle } from '@/components/admin/tabs/GatewaySettings'
import type { McpManagerHandle } from '@/components/admin/tabs/McpManager'
import type { SkillManagerHandle } from '@/components/admin/tabs/SkillManager'
import type { UserManagerHandle } from '@/components/admin/tabs/UserManager'
import { Button } from '@/components/ui/button'
import { PanelLeft, Plus, RotateCcw, Upload } from 'lucide-react'
import { api } from '@/lib/api'

interface UseAdminPanelOptions {
  isAdminUser: boolean
  standAlone: boolean
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
  onConfigChanged: () => void
}

export function useAdminPanel({
  isAdminUser,
  standAlone,
  sidebarOpen,
  setSidebarOpen,
  onConfigChanged,
}: UseAdminPanelOptions) {
  const { t } = useTranslation()
  const [adminViewOpen, setAdminViewOpen] = useState(false)
  const [adminTab, setAdminTab] = useState<string>(ADMIN_TABS[0].value)

  const agentRef = useRef<AgentManagerHandle>(null)
  const gatewayRef = useRef<GatewaySettingsHandle>(null)
  const mcpRef = useRef<McpManagerHandle>(null)
  const skillRef = useRef<SkillManagerHandle>(null)
  const userRef = useRef<UserManagerHandle>(null)

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
            setAdminTab(standAlone && normalized === 'users' ? ADMIN_TABS[0].value : normalized)
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
    <AdminSidebar
      activeTab={adminTab}
      onTabChange={handleTabChange}
      onBack={close}
      standAlone={standAlone}
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
        <div className="flex items-center gap-1.5">
          {adminTab === 'agent' && (
            <Button variant="outline" size="sm" onClick={() => agentRef.current?.triggerCreate()}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t('settings.agentAdd')}
            </Button>
          )}
          {adminTab === 'gateway' && (
            <Button variant="outline" size="sm" onClick={() => gatewayRef.current?.loadFromEnv()}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              {t('settings.gatewayLoadFromEnv')}
            </Button>
          )}
          {adminTab === 'mcp' && (
            <Button variant="outline" size="sm" onClick={() => mcpRef.current?.triggerAdd()}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t('settings.mcpAddServer')}
            </Button>
          )}
          {adminTab === 'skills' && (
            <Button variant="outline" size="sm" onClick={() => skillRef.current?.triggerUpload()}>
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {t('settings.uploadSkill')}
            </Button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-3xl mx-auto px-6 pb-8">
          {adminTab === 'agent' && <AgentManager ref={agentRef} />}
          {adminTab === 'gateway' && <GatewaySettings ref={gatewayRef} />}
          {adminTab === 'experience' && <ExperienceSettings />}
          {adminTab === 'mcp' && <McpManager ref={mcpRef} />}
          {adminTab === 'skills' && <SkillManager ref={skillRef} />}
          {adminTab === 'users' && !standAlone && <UserManager ref={userRef} />}
          {adminTab === 'review' && <ReviewPanel />}
        </div>
      </div>
    </div>
  )

  return { sidebarNode, mainNode, viewOpen: adminViewOpen, open, close }
}