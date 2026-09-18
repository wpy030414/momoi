import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { api } from '../../lib/api'

interface ChangeUsernameDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  username: string
  onDone: (newUsername: string, expiresAt: number) => void
}

export function ChangeUsernameDialog({ open, onOpenChange, username, onDone }: ChangeUsernameDialogProps) {
  const { t } = useTranslation()
  const [newUsername, setNewUsername] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    if (open) {
      setNewUsername('')
      setError('')
      setSuccess(false)
    }
  }, [open])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newUsername.trim()) return

    setLoading(true)
    setError('')
    try {
      const result = await api.renameUser(newUsername.trim())
      setSuccess(true)
      setTimeout(() => {
        onDone(result.username, result.expires_at)
        onOpenChange(false)
      }, 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('changeUsername.conflict'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('changeUsername.title')}</DialogTitle>
          <DialogDescription>{t('changeUsername.description')}</DialogDescription>
        </DialogHeader>

        {success ? (
          <div className="py-4 text-center">
            <p className="text-sm text-green-600">{t('changeUsername.success')}</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('changeUsername.newUsernameLabel')}</label>
              <Input
                autoFocus
                placeholder={username}
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                disabled={loading}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1" onClick={() => onOpenChange(false)} disabled={loading}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" className="flex-1" disabled={loading || !newUsername.trim()}>
                {loading ? t('common.loading') : t('common.save')}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}