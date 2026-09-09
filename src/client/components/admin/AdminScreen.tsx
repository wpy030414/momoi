import { useTranslation } from 'react-i18next'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs'
import { AgentManager } from './tabs/AgentManager'
import { GatewaySettings } from './tabs/GatewaySettings'
import { BrandingSettings } from './tabs/BrandingSettings'
import { SkillManager } from './tabs/SkillManager'
import { StatsPanel } from './tabs/StatsPanel'
import { McpManager } from './tabs/McpManager'
import { ArrowLeft } from 'lucide-react'

interface AdminScreenProps {
  onBack: () => void
}

// No key input: the server authorizes admin endpoints via the logged-in
// user's JWT + ADMIN env list, and the client route guard only lets
// admins reach this screen.
export function AdminScreen({ onBack }: AdminScreenProps) {
  const { t } = useTranslation()

  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <div className="w-full max-w-3xl h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-4 px-6 border-b" style={{ height: '60px' }}>
          <button
            onClick={onBack}
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="text-lg font-semibold">{t('settings.title')}</h1>
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col min-h-0">
          <Tabs defaultValue="agent" className="w-full flex flex-col min-h-0 flex-1 px-6 pt-4">
            <TabsList className="w-full grid grid-cols-6 shrink-0">
              <TabsTrigger value="agent">{t('settings.tabAgent')}</TabsTrigger>
              <TabsTrigger value="gateway">{t('settings.tabGateway')}</TabsTrigger>
              <TabsTrigger value="branding">{t('settings.tabBranding')}</TabsTrigger>
              <TabsTrigger value="mcp">{t('settings.tabMcp')}</TabsTrigger>
              <TabsTrigger value="skills">{t('settings.tabSkills')}</TabsTrigger>
              <TabsTrigger value="stats">{t('settings.tabStats')}</TabsTrigger>
            </TabsList>
            <div className="flex-1 overflow-y-auto min-h-0 pb-4">
              <TabsContent value="agent">
                <AgentManager />
              </TabsContent>
              <TabsContent value="gateway">
                <GatewaySettings />
              </TabsContent>
              <TabsContent value="branding">
                <BrandingSettings />
              </TabsContent>
              <TabsContent value="mcp">
                <McpManager />
              </TabsContent>
              <TabsContent value="skills">
                <SkillManager />
              </TabsContent>
              <TabsContent value="stats">
                <StatsPanel />
              </TabsContent>
            </div>
          </Tabs>
        </div>
      </div>
    </div>
  )
}
