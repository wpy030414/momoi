import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog'
import { Button } from '../ui/button'
import { api } from '../../lib/api'
import { Smartphone, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'

interface WechatBindDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  convId: string
}

type BindState =
  | { phase: 'loading' }
  | { phase: 'already_bound'; wechat_user_id: string; bound_at: number; conversation_id?: string }
  | { phase: 'showing_qr'; qrcode_id: string; qrcode_data_uri: string; expires_at: number }
  | { phase: 'confirmed' }
  | { phase: 'expired' }
  | { phase: 'error'; message: string }

export function WechatBindDialog({ open, onOpenChange, convId }: WechatBindDialogProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<BindState>({ phase: 'loading' })
  const [unbindConfirmOpen, setUnbindConfirmOpen] = useState(false)
  const [rebindConfirmOpen, setRebindConfirmOpen] = useState(false)
  const [unbinding, setUnbinding] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const startBind = useCallback(async (force = false) => {
    clearPoll()
    setState({ phase: 'loading' })
    try {
      if (!force) {
        const info = await api.wechatBindInfo()
        if (info.bound) {
          setState({
            phase: 'already_bound',
            wechat_user_id: info.wechat_user_id || '',
            bound_at: info.bound_at || 0,
            conversation_id: info.conversation_id || '',
          })
          return
        }
      }

      const result = await api.wechatBindStart(convId)
      setState({
        phase: 'showing_qr',
        qrcode_id: result.qrcode_id,
        qrcode_data_uri: result.qrcode_data_uri,
        expires_at: result.expires_at,
      })

      pollRef.current = setInterval(async () => {
        try {
          const status = await api.wechatBindStatus(result.qrcode_id)
          if (status.status === 'confirmed') {
            clearPoll()
            setState({ phase: 'confirmed' })
          } else if (status.status === 'expired') {
            clearPoll()
            setState({ phase: 'expired' })
          }
        } catch {
          // Silently continue polling on transient errors
        }
      }, 5000)
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : t('common.error') })
    }
  }, [clearPoll, t, convId])

  const handleUnbind = useCallback(async () => {
    setUnbinding(true)
    try {
      await api.wechatUnbind()
      setUnbindConfirmOpen(false)
      setState({ phase: 'loading' })
      startBind()
    } catch (err) {
      setState({ phase: 'error', message: err instanceof Error ? err.message : t('common.error') })
    } finally {
      setUnbinding(false)
    }
  }, [startBind, t])

  useEffect(() => {
    if (open) {
      startBind()
    } else {
      clearPoll()
    }
    return () => clearPoll()
  }, [open, startBind, clearPoll])

  useEffect(() => {
    if (state.phase !== 'showing_qr') return
    const expiry = state.expires_at
    const check = setInterval(() => {
      if (Date.now() >= expiry) {
        clearPoll()
        setState({ phase: 'expired' })
      }
    }, 1000)
    return () => clearInterval(check)
  }, [state.phase === 'showing_qr' ? (state as any).expires_at : null, clearPoll])

  useEffect(() => {
    if (state.phase === 'confirmed') {
      const t = setTimeout(() => onOpenChange(false), 3000)
      return () => clearTimeout(t)
    }
  }, [state.phase, onOpenChange])

  const renderContent = () => {
    switch (state.phase) {
      case 'loading':
        return (
          <div className="flex flex-col items-center justify-center py-8 gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          </div>
        )

      case 'already_bound':
        return (
          <div className="flex flex-col items-center gap-4 py-4">
            <CheckCircle2 className="h-12 w-12 text-green-500" />
            <div className="text-center">
              <p className="font-medium">{t('wechatBind.alreadyBound')}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {t('wechatBind.alreadyBoundDesc')}
              </p>
              {state.wechat_user_id && (
                <p className="text-xs text-muted-foreground mt-1">
                  WeChat ID: {state.wechat_user_id}
                </p>
              )}
              {state.conversation_id && state.conversation_id !== convId && (
                <p className="text-xs text-muted-foreground mt-1">
                  {t('wechatBind.boundToOtherConv')}
                </p>
              )}
            </div>
            <div className="flex gap-2">
              {state.conversation_id !== convId && (
                <Button variant="outline" size="sm" onClick={() => setRebindConfirmOpen(true)}>
                  {t('wechatBind.rebindHere')}
                </Button>
              )}
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setUnbindConfirmOpen(true)}
              >
                {t('wechatBind.unbind')}
              </Button>
            </div>
          </div>
        )

      case 'showing_qr':
        return (
          <div className="flex flex-col items-center gap-3 py-2">
            <p className="text-sm text-muted-foreground">{t('wechatBind.scanning')}</p>
            {state.qrcode_data_uri ? (
              <div className="border rounded-lg p-3 bg-white">
                <img
                  src={state.qrcode_data_uri}
                  alt="WeChat QR Code"
                  className="w-64 h-64 object-contain"
                />
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-6">
                <AlertCircle className="h-12 w-12 text-amber-500" />
                <p className="text-sm text-muted-foreground">{t('common.error')}</p>
                <Button variant="outline" size="sm" onClick={() => startBind(false)}>
                  {t('wechatBind.retry')}
                </Button>
              </div>
            )}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Smartphone className="h-4 w-4" />
              <span>{t('wechatBind.description')}</span>
            </div>
          </div>
        )

      case 'confirmed':
        return (
          <div className="flex flex-col items-center gap-3 py-6">
            <CheckCircle2 className="h-12 w-12 text-green-500" />
            <p className="font-medium text-green-600 dark:text-green-400">{t('wechatBind.success')}</p>
            <p className="text-sm text-muted-foreground text-center">{t('wechatBind.successDesc')}</p>
          </div>
        )

      case 'expired':
        return (
          <div className="flex flex-col items-center gap-4 py-6">
            <AlertCircle className="h-12 w-12 text-amber-500" />
            <p className="text-sm text-muted-foreground">{t('wechatBind.expired')}</p>
            <Button variant="outline" onClick={() => startBind(false)}>
              {t('wechatBind.retry')}
            </Button>
          </div>
        )

      case 'error':
        return (
          <div className="flex flex-col items-center gap-4 py-6">
            <AlertCircle className="h-12 w-12 text-destructive" />
            <p className="text-sm text-destructive">{state.message}</p>
            <Button variant="outline" onClick={() => startBind(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        )
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('wechatBind.title')}</DialogTitle>
            <DialogDescription>
              {state.phase !== 'showing_qr' && state.phase !== 'confirmed'
                ? t('wechatBind.description')
                : undefined}
            </DialogDescription>
          </DialogHeader>
          {renderContent()}
        </DialogContent>
      </Dialog>

      <Dialog open={unbindConfirmOpen} onOpenChange={(open) => { if (!open) setUnbindConfirmOpen(false) }}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>{t('common.remove')}</DialogTitle>
            <DialogDescription>{t('wechatBind.unbindConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnbindConfirmOpen(false)} disabled={unbinding}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleUnbind} disabled={unbinding}>
              {unbinding ? t('common.loading') : t('wechatBind.unbind')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rebind confirmation — binding will move to this conversation (需求3) */}
      <Dialog open={rebindConfirmOpen} onOpenChange={(open) => { if (!open) setRebindConfirmOpen(false) }}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>{t('wechatBind.rebindTitle')}</DialogTitle>
            <DialogDescription>{t('wechatBind.rebindConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRebindConfirmOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="default" onClick={() => { setRebindConfirmOpen(false); startBind(true) }}>
              {t('wechatBind.rebindHere')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}