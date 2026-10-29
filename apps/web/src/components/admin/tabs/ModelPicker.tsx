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
  /** 禁用下拉与输入（批量保存进行中） */
  disabled?: boolean
  /**
   * 混搭态：仅用于「统一模型」这类批量入口——当前各智能体模型不一致时，
   * 触发器显示「多个模型」占位，不进入自定义输入，也不额外渲染「模型」标签。
   */
  mixed?: boolean
}

/**
 * Agent 模型选择器：
 * - 打开表单时自动拉取当前上游派发的模型目录，渲染为下拉框；
 * - 目录里没有想要的模型时选「自定义」，回退为手动输入模型 ID；
 * - 目录拉取失败不阻塞编辑，直接以自定义输入形态呈现。
 */
export function ModelPicker({ value, onChange, disabled = false, mixed = false }: ModelPickerProps) {
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
  // 混搭态下 value 为空是正常的（不指向任何单一模型），不得退化成自定义输入
  const isCustom = !mixed && (manual || (!loading && (models.length === 0 || (value.trim() !== '' && !matched))))
  const selectValue = isCustom ? CUSTOM_VALUE : matched ? value : undefined
  const placeholder = mixed
    ? t('settings.agentModelMixed')
    : loading ? t('settings.agentModelLoading') : t('settings.agentModelSelect')

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
        {!mixed && <label className="text-sm font-medium">{t('settings.agentModel')}</label>}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={mixed ? 'ml-auto h-6 px-2 -mr-1' : 'h-6 px-2'}
          onClick={() => void load()}
          disabled={loading || disabled}
          title={t('settings.agentModelRefresh')}
        >
          <RefreshCw className={loading ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
        </Button>
      </div>

      <Select value={selectValue} onValueChange={handleSelect} disabled={disabled}>
        <SelectTrigger className="mt-1">
          <SelectValue placeholder={placeholder} />
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
