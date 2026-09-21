import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { PanelLeft, Plus, RotateCcw, Upload } from 'lucide-react'

import { AgentManager, type AgentManagerHandle } from './tabs/AgentManager'
import { GatewaySettings, type GatewaySettingsHandle } from './tabs/GatewaySettings'
import { ExperienceSettings } from './tabs/ExperienceSettings'
import { McpManager, type McpManagerHandle } from './tabs/McpManager'
import { SkillManager, type SkillManagerHandle } from './tabs/SkillManager'
import { ReviewPanel } from './tabs/ReviewPanel'
import { UserManager, type UserManagerHandle } from './tabs/UserManager'

interface AdminPanelMainProps {
  activeTab: string
  standAlone: boolean
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
}

/**
 * Admin main pane: header bar with per-tab actions + tab content.
 *
 * Imported (together with AdminSidebar) only through the panel barrel in
 * `./panel.tsx` — the single lazy-loading boundary for all admin UI. Statically
 * importing the tab components keeps them in one chunk; do not lazy-load
 * individual tabs.
 */
export function AdminPanelMain({ activeTab, standAlone, sidebarOpen, setSidebarOpen }: AdminPanelMainProps) {
  const { t } = useTranslation()
  const agentRef = useRef<AgentManagerHandle>(null)
  const gatewayRef = useRef<GatewaySettingsHandle>(null)
  const mcpRef = useRef<McpManagerHandle>(null)
  const skillRef = useRef<SkillManagerHandle>(null)

  return (
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
          {activeTab === 'agent' && (
            <Button variant="outline" size="sm" onClick={() => agentRef.current?.triggerCreate()}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t('settings.agentAdd')}
            </Button>
          )}
          {activeTab === 'gateway' && (
            <Button variant="outline" size="sm" onClick={() => gatewayRef.current?.loadFromEnv()}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              {t('settings.gatewayLoadFromEnv')}
            </Button>
          )}
          {activeTab === 'mcp' && (
            <Button variant="outline" size="sm" onClick={() => mcpRef.current?.triggerAdd()}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t('settings.mcpAddServer')}
            </Button>
          )}
          {activeTab === 'skills' && (
            <Button variant="outline" size="sm" onClick={() => skillRef.current?.triggerUpload()}>
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {t('settings.uploadSkill')}
            </Button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-3xl mx-auto px-6 pb-8">
          {activeTab === 'agent' && <AgentManager ref={agentRef} />}
          {activeTab === 'gateway' && <GatewaySettings ref={gatewayRef} />}
          {activeTab === 'experience' && <ExperienceSettings />}
          {activeTab === 'mcp' && <McpManager ref={mcpRef} />}
          {activeTab === 'skills' && <SkillManager ref={skillRef} />}
          {activeTab === 'users' && !standAlone && <UserManager />}
          {activeTab === 'review' && <ReviewPanel />}
        </div>
      </div>
    </div>
  )
}
