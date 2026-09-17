import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { api } from '../../lib/api'
import { Loader2, CheckCircle2, AlertCircle, ArrowLeft, ExternalLink } from 'lucide-react'

interface QqBindPanelProps {
  convId: string
  /** 返回渠道选择页（ImBindDialog 提供） */
  onBack?: () => void
  /** 绑定流程完成（含 3s 成功展示后由本组件触发） */
  onComplete?: () => void
}

type BindInfo = {
  bound: boolean
  app_id?: string
  bound_at?: number
  conversation_id?: string
  status?: 'connected' | 'error'
  error?: string
  ws_connected?: boolean
  group_enabled?: boolean
}

type PanelState =
  | { phase: 'loading' }
  | { phase: 'form'; appId: string; error?: string }
  | { phase: 'submitting' }
  | { phase: 'confirmed' }
  | { phase: 'connected'; info: BindInfo }

export function QqBindPanel({ convId, onBack, onComplete }: QqBindPanelProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<PanelState>({ phase: 'loading' })
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [unbindConfirmOpen, setUnbindConfirmOpen] = useState(false)
  const [rebindConfirmOpen, setRebindConfirmOpen] = useState(false)
  const [unbinding, setUnbinding] = useState(false)
  const [groupEnabled, setGroupEnabled] = useState(false)

  const loadInfo = useCallback(async () => {
    setState({ phase: 'loading' })
    try {
      const info = await api.qqBindInfo()
      if (info.bound) {
        setState({ phase: 'connected', info })
      } else {
        setState({ phase: 'form', appId: '' })
      }
    } catch (err) {
      setState({ phase: 'form', appId: '', error: err instanceof Error ? err.message : t('common.error') })
    }
  }, [t])

  useEffect(() => {
    loadInfo()
  }, [loadInfo])

  useEffect(() => {
    if (state.phase === 'confirmed') {
      const timer = setTimeout(() => onComplete?.(), 3000)
      return () => clearTimeout(timer)
    }
  }, [state.phase, onComplete])

  const handleSubmit = useCallback(async () => {
    if (!appId.trim() || !appSecret.trim()) {
      setState({ phase: 'form', appId, error: t('qqBind.missingCredentials') })
      return
    }
    setState({ phase: 'submitting' })
    try {
      await api.qqBindStart(convId, appId.trim(), appSecret.trim(), groupEnabled)
      setState({ phase: 'confirmed' })
    } catch (err) {
      setState({ phase: 'form', appId, error: err instanceof Error ? err.message : t('common.error') })
    }
  }, [appId, appSecret, convId, t])

  const handleRebindHere = useCallback(async () => {
    setRebindConfirmOpen(false)
    try {
      await api.qqBindStart(convId)
      await loadInfo()
    } catch (err) {
      setState({ phase: 'form', appId, error: err instanceof Error ? err.message : t('common.error') })
    }
  }, [convId, loadInfo, t])

  const handleUnbind = useCallback(async () => {
    setUnbinding(true)
    try {
      await api.qqUnbind()
      setUnbindConfirmOpen(false)
      setAppId('')
      setAppSecret('')
      setState({ phase: 'form', appId: '' })
    } catch (err) {
      setState({ phase: 'form', appId, error: err instanceof Error ? err.message : t('common.error') })
    } finally {
      setUnbinding(false)
    }
  }, [t])

  const renderContent = () => {
    switch (state.phase) {
      case 'loading':
        return (
          <div className="flex flex-col items-center justify-center py-8 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          </div>
        )

      case 'form':
        return (
          <div className="flex flex-col gap-4 py-2">
            <p className="text-sm text-muted-foreground">{t('qqBind.description')}</p>
            <a
              href="https://q.qq.com/qqbot/openclaw/index.html"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <ExternalLink className="h-3 w-3" />
              {t('qqBind.createBotGuide')}
            </a>
            <div className="flex flex-col gap-2">
              <label htmlFor="qq-app-id" className="text-sm font-medium leading-none">AppID</label>
              <Input
                id="qq-app-id"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                placeholder={t('qqBind.appIdPlaceholder')}
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-2">
              <label htmlFor="qq-app-secret" className="text-sm font-medium leading-none">AppSecret</label>
              <Input
                id="qq-app-secret"
                type="password"
                value={appSecret}
                onChange={(e) => setAppSecret(e.target.value)}
                placeholder={t('qqBind.appSecretPlaceholder')}
                autoComplete="off"
              />
            </div>
            {state.error && (
              <p className="text-sm text-destructive break-all">{state.error}</p>
            )}
            <div className="flex items-center justify-between py-1">
              <span className="text-sm">{t('qqBind.groupEnabled')}</span>
              <Switch checked={groupEnabled} onCheckedChange={setGroupEnabled} />
            </div>
            <p className="text-xs text-muted-foreground -mt-1">{t('qqBind.groupEnabledDesc')}</p>
            <Button onClick={handleSubmit} disabled={!appId.trim() || !appSecret.trim()}>
              {t('qqBind.submit')}
            </Button>
          </div>
        )

      case 'submitting':
        return (
          <div className="flex flex-col items-center justify-center py-8 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('qqBind.submitting')}</p>
          </div>
        )

      case 'confirmed':
        return (
          <div className="flex flex-col items-center gap-3 py-6">
            <CheckCircle2 className="h-12 w-12 text-green-500" />
            <p className="font-medium text-green-600 dark:text-green-400">{t('qqBind.success')}</p>
            <p className="text-sm text-muted-foreground text-center">{t('qqBind.successDesc')}</p>
          </div>
        )

      case 'connected': {
        const info = state.info
        const unhealthy = info.status === 'error' || info.ws_connected === false
        return (
          <div className="flex flex-col items-center gap-4 py-4">
            <CheckCircle2 className={`h-12 w-12 ${unhealthy ? 'text-amber-500' : 'text-green-500'}`} />
            <div className="text-center">
              <p className="font-medium">{t('qqBind.alreadyBound')}</p>
              {info.app_id && (
                <p className="text-xs text-muted-foreground mt-1">
                  AppID: {info.app_id}
                </p>
              )}
              {info.conversation_id && info.conversation_id !== convId && (
                <p className="text-xs text-muted-foreground mt-1">
                  {t('qqBind.boundToOtherConv')}
                </p>
              )}
              {unhealthy && (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 break-all">
                  {info.error || t('qqBind.notConnected')}
                </p>
              )}
            </div>
            <div className="flex items-center justify-between w-full px-2">
              <span className="text-sm">{t('qqBind.groupEnabled')}</span>
              <Switch
                checked={info.group_enabled ?? false}
                onCheckedChange={async (checked) => {
                  try {
                    await api.qqBindStart(undefined, undefined, undefined, checked)
                    await loadInfo()
                  } catch { /* 切换失败静默，toggle 回弹 */ }
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground -mt-2">{t('qqBind.groupEnabledDesc')}</p>
            <div className="flex flex-wrap justify-center gap-2">
              {info.conversation_id !== convId && (
                <Button variant="outline" size="sm" onClick={() => setRebindConfirmOpen(true)}>
                  {t('qqBind.rebindHere')}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => { setAppId(info.app_id || ''); setAppSecret(''); setState({ phase: 'form', appId: info.app_id || '' }) }}>
                {t('qqBind.changeCredentials')}
              </Button>
              <Button variant="destructive" size="sm" onClick={() => setUnbindConfirmOpen(true)}>
                {t('qqBind.unbind')}
              </Button>
            </div>
          </div>
        )
      }
    }
  }

  return (
    <>
      {onBack && state.phase !== 'submitting' && (
        <Button
          variant="ghost"
          size="sm"
          className="absolute left-4 top-4 h-7 w-7 p-0 z-10"
          onClick={onBack}
          aria-label={t('imBind.back')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
      )}
      {renderContent()}

      <Dialog open={rebindConfirmOpen} onOpenChange={(open) => { if (!open) setRebindConfirmOpen(false) }}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>{t('qqBind.rebindTitle')}</DialogTitle>
            <DialogDescription>{t('qqBind.rebindConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRebindConfirmOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="default" onClick={handleRebindHere}>
              {t('qqBind.rebindHere')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={unbindConfirmOpen} onOpenChange={(open) => { if (!open) setUnbindConfirmOpen(false) }}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>{t('common.remove')}</DialogTitle>
            <DialogDescription>{t('qqBind.unbindConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnbindConfirmOpen(false)} disabled={unbinding}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleUnbind} disabled={unbinding}>
              {unbinding ? t('common.loading') : t('qqBind.unbind')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
