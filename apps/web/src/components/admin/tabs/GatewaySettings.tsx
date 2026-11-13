import { useState, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '../../ui/input'
import { Button } from '../../ui/button'
import { Switch } from '../../ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Loading } from '../../ui/spinner'
import { Eye, EyeOff } from 'lucide-react'
import { api } from '../../../lib/api'
import { useToast } from '../../ui/toast'
import { WorkBuddyCredentialPanel } from './WorkBuddyCredentialPanel'
import type { GatewaySource } from '@momoi/shared/types'

export interface GatewaySettingsHandle {
  loadFromEnv: () => void
}

interface GatewaySettingsProps {
  /** 上游类型变化时通知父级（决定右上角是否显示「从环境变量加载」） */
  onSourceChange?: (source: GatewaySource) => void
}

const normalizeSource = (value: unknown): GatewaySource =>
  value === 'workbuddy' ? value : 'custom'

export const GatewaySettings = forwardRef<GatewaySettingsHandle, GatewaySettingsProps>(function GatewaySettings(
  { onSourceChange },
  ref,
) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [config, setConfig] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [showApiKey, setShowApiKey] = useState(false)

  const source: GatewaySource = normalizeSource(config?.gateway_source)

  useEffect(() => {
    api.getConfig().then((cfg) => {
      setConfig(cfg)
      onSourceChange?.(normalizeSource(cfg.gateway_source))
    }).catch(console.error)
    // onSourceChange 在父级是稳定 setState，无需进 deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleLoadFromEnv = useCallback(async () => {
    // 空值守卫折进函数式更新（prev ? {...} : prev）：闭包不再引用 config，
    // deps 可以为空——config 每次表单输入都换新引用，入 deps 会让本回调
    // （及其 useImperativeHandle）跟着每次击键重建。
    try {
      const envGateway = await api.getEnvGateway()
      setConfig((prev: any) => prev ? {
        ...prev,
        api_endpoint: envGateway.api_endpoint,
        api_key: envGateway.api_key,
      } : prev)
    } catch (err) {
      console.error(err)
    }
  }, [])

  const handleSourceChange = useCallback((value: string) => {
    const next = normalizeSource(value)
    setConfig((prev: any) => prev ? { ...prev, gateway_source: next } : prev)
    onSourceChange?.(next)
  }, [onSourceChange])

  useImperativeHandle(ref, () => ({ loadFromEnv: handleLoadFromEnv }), [handleLoadFromEnv])

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.updateConfig(config)
      toast({ title: t('settings.toastSaved'), variant: 'success' })
    } catch (err) {
      console.error(err)
    }
    setSaving(false)
  }

  if (!config) return <Loading className="py-16" />

  return (
    <div className="space-y-4 pt-4">
      <div>
        <label className="text-sm font-medium">{t('settings.gatewaySource')}</label>
        <Select value={source} onValueChange={handleSourceChange}>
          <SelectTrigger className="mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="custom">{t('settings.gatewaySourceCustom')}</SelectItem>
            <SelectItem value="workbuddy">{t('settings.gatewaySourceWorkBuddy')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {source === 'custom' ? (
        <>
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
        </>
      ) : (
        <WorkBuddyCredentialPanel />
      )}

      <div>
        <label className="text-sm font-medium">{t('settings.contextWindow')}</label>
        <Input
          type="number"
          min={1}
          value={config.context_window ?? 128000}
          onChange={(e) => setConfig({ ...config, context_window: Number(e.target.value) || 128000 })}
          className="mt-1"
        />
      </div>
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium">{t('settings.supportInfiniteMode')}</label>
        <Switch
          checked={config.support_infinite_mode !== false}
          onCheckedChange={(v) => setConfig({ ...config, support_infinite_mode: v })}
        />
      </div>
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium">{t('settings.supportAttachments')}</label>
        <Switch
          checked={!!config.support_attachments}
          onCheckedChange={(v) => setConfig({ ...config, support_attachments: v })}
        />
      </div>
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium">{t('settings.useExternalImageHosting')}</label>
        <Switch
          checked={!!config.use_external_image_hosting}
          onCheckedChange={(v) => setConfig({ ...config, use_external_image_hosting: v })}
        />
      </div>
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium">{t('settings.allowImConversations')}</label>
        <Switch
          checked={config.allow_im_conversations !== false}
          onCheckedChange={(v) => setConfig({ ...config, allow_im_conversations: v })}
        />
      </div>
      {/* 限流：分桶滑动窗口，见 middleware/requestGate.ts */}
      <div className="pt-2 border-t">
        <div className="flex items-center gap-3 mb-3">
          <label className="text-sm font-medium">{t('settings.rateLimitEnabled')}</label>
          <Switch
            checked={config.rate_limit_enabled !== false}
            onCheckedChange={(v) => setConfig({ ...config, rate_limit_enabled: v })}
          />
        </div>
        <p className="text-xs text-muted-foreground mb-3">{t('settings.rateLimitHint')}</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium">{t('settings.rateLimitGenerate')}</label>
            <Input
              type="number"
              min={0}
              value={config.rate_limit_generate_per_min ?? 10}
              onChange={(e) => setConfig({ ...config, rate_limit_generate_per_min: Math.max(0, Number(e.target.value) || 0) })}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-sm font-medium">{t('settings.rateLimitRest')}</label>
            <Input
              type="number"
              min={0}
              value={config.rate_limit_rest_per_min ?? 120}
              onChange={(e) => setConfig({ ...config, rate_limit_rest_per_min: Math.max(0, Number(e.target.value) || 0) })}
              className="mt-1"
            />
          </div>
        </div>
      </div>

      {/* 实例总额度：与各用户个人额度先到者拦截，见 lib/quota.ts */}
      <div className="pt-2 border-t">
        <label className="text-sm font-medium">{t('settings.instanceQuota')}</label>
        <Input
          type="number"
          min={0}
          value={config.instance_weekly_quota_mtok ?? 0}
          onChange={(e) => setConfig({ ...config, instance_weekly_quota_mtok: Math.max(0, Number(e.target.value) || 0) })}
          className="mt-1"
        />
        <p className="text-xs text-muted-foreground mt-1">{t('settings.instanceQuotaHint')}</p>
      </div>

      <Button onClick={handleSave} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</Button>
    </div>
  )
})
