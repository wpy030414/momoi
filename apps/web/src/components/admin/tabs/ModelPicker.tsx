import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { api } from '../../../lib/api'
import { Input } from '../../ui/input'
import { Button } from '../../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import type { GatewayModelList } from '@momoi/shared/types'

const CUSTOM_VALUE = '__custom__'

interface ModelPickerProps {
  value: string
  onChange: (value: string) => void
}

/**
 * Agent 模型选择器：
 * - 打开表单时自动拉取当前上游派发的模型目录，渲染为下拉框；
 * - 目录里没有想要的模型时选「自定义」，回退为手动输入模型 ID；
 * - 目录拉取失败不阻塞编辑，直接以自定义输入形态呈现。
 */
export function ModelPicker({ value, onChange }: ModelPickerProps) {
  const { t } = useTranslation()
  const [catalog, setCatalog] = useState<GatewayModelList | null>(null)
  const [loading, setLoading] = useState(true)
  const [manual, setManual] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setCatalog(await api.gatewayModels())
    } catch (err) {
      console.error('Failed to load gateway models:', err)
      setCatalog({ source: 'custom', models: [], warning: 'upstream_error' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const models = catalog?.models ?? []
  const matched = models.some((m) => m.id === value)
  // 目录为空（无可用上游 / 拉取失败）或当前值不在目录里 → 自定义输入
  const isCustom = manual || (!loading && (models.length === 0 || (value.trim() !== '' && !matched)))
  const selectValue = isCustom ? CUSTOM_VALUE : matched ? value : undefined

  const handleSelect = (next: string) => {
    if (next === CUSTOM_VALUE) {
      setManual(true)
      // 从目录项切到自定义时清空，让输入框从空白开始；本来就是自定义则保留原文
      if (matched) onChange('')
      return
    }
    setManual(false)
    onChange(next)
  }

  const warning = catalog?.warning
  return (
    <div>
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">{t('settings.agentModel')}</label>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2"
          onClick={() => void load()}
          disabled={loading}
          title={t('settings.agentModelRefresh')}
        >
          <RefreshCw className={loading ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
        </Button>
      </div>

      <Select value={selectValue} onValueChange={handleSelect}>
        <SelectTrigger className="mt-1">
          <SelectValue placeholder={loading ? t('settings.agentModelLoading') : t('settings.agentModelSelect')} />
        </SelectTrigger>
        <SelectContent>
          {models.map((model) => (
            <SelectItem key={model.id} value={model.id}>
              {model.name && model.name !== model.id ? `${model.name} (${model.id})` : model.id}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM_VALUE}>{t('settings.agentModelCustom')}</SelectItem>
        </SelectContent>
      </Select>

      {isCustom && (
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('settings.modelPlaceholder')}
          className="mt-2"
        />
      )}

      {warning && !loading && (
        <p className="mt-1 text-xs text-muted-foreground break-words">
          {t(`settings.agentModelWarning_${warning}`)}
          {catalog?.detail ? ` (${catalog.detail})` : ''}
        </p>
      )}
    </div>
  )
}
