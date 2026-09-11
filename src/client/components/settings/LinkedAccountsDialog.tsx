import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog'
import { Button } from '../ui/button'
import { api } from '../../lib/api'

interface LinkedAccountsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function LinkedAccountsDialog({ open, onOpenChange }: LinkedAccountsDialogProps) {
  const { t } = useTranslation()
  const [bindings, setBindings] = useState<Array<{ id: string; provider_id: string; created_at: number }>>([])
  const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(false)
  const [unbindId, setUnbindId] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setError('')
      fetchBindings()
      api.getOauthProviders().then((r) => setProviders(r.providers)).catch(() => {})
    }
  }, [open])

  const fetchBindings = async () => {
    try {
      const result = await api.getOauthBindings()
      setBindings(result.bindings)
    } catch (err) {
      console.error('Failed to fetch bindings', err)
    }
  }

  const handleUnbind = async () => {
    if (!unbindId) return
    setLoading(true)
    setError('')
    try {
      await api.unbindOauth(unbindId)
      setBindings((prev) => prev.filter((b) => b.id !== unbindId))
      setUnbindId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'))
    } finally {
      setLoading(false)
    }
  }

  const getProviderName = (providerId: string) => {
    return providers.find((p) => p.id === providerId)?.name || providerId
  }

  const handleLink = (providerId: string) => {
    // Full-page redirect to OAuth flow. Browser carries momoi_token cookie,
    // callback will auto-bind to current user.
    window.location.href = `/api/oauth/${providerId}/login`
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('linkedAccounts.title')}</DialogTitle>
            <DialogDescription>{t('linkedAccounts.description')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {bindings.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('linkedAccounts.noBindings')}</p>
            ) : (
              bindings.map((b) => (
                <div key={b.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                  <div>
                    <span className="text-sm font-medium">{getProviderName(b.provider_id)}</span>
                    <p className="text-xs text-muted-foreground">
                      {new Date(b.created_at * 1000).toLocaleDateString()}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setUnbindId(b.id)}
                    disabled={loading}
                  >
                    {t('linkedAccounts.unbind')}
                  </Button>
                </div>
              ))
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            {/* Link account: provider picker */}
            <div className="pt-2 border-t">
              <p className="text-sm font-medium mb-2">{t('linkedAccounts.add')}</p>
              <div className="space-y-1">
                {providers
                  .filter((p) => !bindings.some((b) => b.provider_id === p.id))
                  .map((p) => (
                    <Button
                      key={p.id}
                      variant="outline"
                      className="w-full justify-start"
                      onClick={() => handleLink(p.id)}
                    >
                      {p.name}
                    </Button>
                  ))}
                {providers.filter((p) => !bindings.some((b) => b.provider_id === p.id)).length === 0 && (
                  <p className="text-xs text-muted-foreground">{t('linkedAccounts.chooseProvider')}</p>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Unbind confirmation dialog */}
      <Dialog open={!!unbindId} onOpenChange={(open) => { if (!open) setUnbindId(null) }}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>{t('common.remove')}</DialogTitle>
            <DialogDescription>{t('linkedAccounts.unbindConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUnbindId(null)} disabled={loading}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleUnbind} disabled={loading}>
              {loading ? t('common.loading') : t('linkedAccounts.unbind')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}