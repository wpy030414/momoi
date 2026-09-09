import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '../../ui/input'
import { Button } from '../../ui/button'
import { Switch } from '../../ui/switch'
import { Eye, EyeOff, RotateCcw } from 'lucide-react'
import { api } from '../../../lib/api'
import { useToast } from '../../ui/toast'

interface GatewaySettingsProps {
  token: string
}

export function GatewaySettings({ token }: GatewaySettingsProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [config, setConfig] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)

  useEffect(() => {
    api.getConfig(token).then(setConfig).catch(console.error)
  }, [token])

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.updateConfig(token, config)
      toast({ title: t('settings.toastSaved'), variant: 'success' })
    } catch (err) {
      console.error(err)
    }
    setSaving(false)
  }

  if (!config) return <div className="py-8 text-center text-muted-foreground">{t('common.loading')}</div>

  const handleLoadFromEnv = async () => {
    try {
      const envGateway = await api.getEnvGateway(token)
      setConfig({
        ...config,
        api_endpoint: envGateway.api_endpoint,
        api_key: envGateway.api_key,
      })
    } catch (err) {
      console.error(err)
    }
  }

  return (
    <div className="space-y-4 pt-4">
      <div>
        <Button variant="outline" size="sm" onClick={handleLoadFromEnv}>
          <RotateCcw className="mr-2 h-4 w-4" />
          {t('settings.gatewayLoadFromEnv')}
        </Button>
      </div>
      <div>
        <label className="text-sm font-medium">{t('settings.apiEndpoint')}</label>
        <Input value={config.api_endpoint || ''} onChange={(e) => setConfig({ ...config, api_endpoint: e.target.value })} className="mt-1" />
      </div>
      <div>
        <label className="text-sm font-medium">{t('settings.apiKey')}</label>
        <div className="relative mt-1">
          <Input
            type={showApiKey ? 'text' : 'password'}
            value={config.api_key || ''}
            onChange={(e) => setConfig({ ...config, api_key: e.target.value })}
            className="pr-10"
          />
          <button
            type="button"
            onClick={() => setShowApiKey(!showApiKey)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">{t('settings.supportAttachments')}</label>
        <Switch
          checked={!!config.support_attachments}
          onCheckedChange={(v) => setConfig({ ...config, support_attachments: v })}
        />
      </div>
      <Button onClick={handleSave} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</Button>
    </div>
  )
}