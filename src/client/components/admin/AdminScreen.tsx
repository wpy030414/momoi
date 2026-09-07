import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs'
import { AgentManager } from './tabs/AgentManager'
import { GatewaySettings } from './tabs/GatewaySettings'
import { BrandingSettings } from './tabs/BrandingSettings'
import { SkillManager } from './tabs/SkillManager'
import { StatsPanel } from './tabs/StatsPanel'
import { ArrowLeft } from 'lucide-react'
import type { useAdmin } from '../../hooks/useAdmin'

interface AdminScreenProps {
  onBack: () => void
  admin: ReturnType<typeof useAdmin>
}

export function AdminScreen({ onBack, admin }: AdminScreenProps) {
  const { t } = useTranslation()
  const [key, setKey] = useState('')

  // Reset key when component mounts
  useEffect(() => {
    setKey('')
  }, [])

  const handleLogin = async () => {
    await admin.login(key)
    setKey('')
  }

  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <div className="w-full max-w-3xl h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-4 px-6 border-b" style={{ height: '60px' }}>
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            {t('settings.backToChat')}
          </button>
          <h1 className="text-lg font-semibold">{t('settings.title')}</h1>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!admin.authenticated ? (
            <div className="max-w-sm mx-auto pt-20 space-y-4">
              <p className="text-sm text-muted-foreground text-center">
                {t('settings.subtitleUnauthenticated')}
              </p>
              <Input
                type="password"
                placeholder={t('settings.adminKeyPlaceholder')}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
              />
              {admin.error && <p className="text-sm text-destructive">{admin.error}</p>}
              <Button onClick={handleLogin} className="w-full">
                {t('common.authenticate')}
              </Button>
            </div>
          ) : (
            <Tabs defaultValue="agent" className="w-full">
              <TabsList className="w-full grid grid-cols-5 mb-6">
                <TabsTrigger value="agent">{t('settings.tabAgent')}</TabsTrigger>
                <TabsTrigger value="gateway">{t('settings.tabGateway')}</TabsTrigger>
                <TabsTrigger value="branding">{t('settings.tabBranding')}</TabsTrigger>
                <TabsTrigger value="skills">{t('settings.tabSkills')}</TabsTrigger>
                <TabsTrigger value="stats">{t('settings.tabStats')}</TabsTrigger>
              </TabsList>
              <TabsContent value="agent">
                <AgentManager token={admin.token!} />
              </TabsContent>
              <TabsContent value="gateway">
                <GatewaySettings token={admin.token!} />
              </TabsContent>
              <TabsContent value="branding">
                <BrandingSettings token={admin.token!} />
              </TabsContent>
              <TabsContent value="skills">
                <SkillManager token={admin.token!} />
              </TabsContent>
              <TabsContent value="stats">
                <StatsPanel token={admin.token!} />
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    </div>
  )
}