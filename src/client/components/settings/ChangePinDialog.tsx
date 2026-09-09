import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { api } from '../../lib/api'

const PIN_MIN = 4
const PIN_MAX = 8

interface ChangePinDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  username: string
}

export function ChangePinDialog({ open, onOpenChange, username }: ChangePinDialogProps) {
  const { t } = useTranslation()
  const [oldPin, setOldPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)

  const pinValid = (p: string) => p.length >= PIN_MIN && p.length <= PIN_MAX

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!pinValid(oldPin)) {
      setError(t('changePin.oldPinError'))
      return
    }
    if (!pinValid(newPin)) {
      setError(t('changePin.newPinError'))
      return
    }
    if (newPin !== confirmPin) {
      setError(t('changePin.confirmPinError'))
      return
    }

    setLoading(true)
    setError('')
    try {
      await api.changePin(username, oldPin, newPin)
      setSuccess(true)
      setTimeout(() => {
        handleReset()
        onOpenChange(false)
      }, 1500)
    } catch (err) {
      setError(t('changePin.oldPinWrong'))
    } finally {
      setLoading(false)
    }
  }

  const handleReset = () => {
    setOldPin('')
    setNewPin('')
    setConfirmPin('')
    setError('')
    setSuccess(false)
  }

  const handleClose = () => {
    handleReset()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('changePin.title')}</DialogTitle>
          <DialogDescription>{t('changePin.description')}</DialogDescription>
        </DialogHeader>

        {success ? (
          <div className="py-4 text-center">
            <p className="text-sm text-green-600">{t('changePin.success')}</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('changePin.oldPin')}</label>
              <Input
                type="password"
                placeholder={t('login.pinPlaceholder')}
                value={oldPin}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, '')
                  setOldPin(val)
                }}
                maxLength={PIN_MAX}
                disabled={loading}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">{t('changePin.newPin')}</label>
              <Input
                type="password"
                placeholder={t('login.pinPlaceholder')}
                value={newPin}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, '')
                  setNewPin(val)
                }}
                maxLength={PIN_MAX}
                disabled={loading}
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">{t('changePin.confirmPin')}</label>
              <Input
                type="password"
                placeholder={t('login.pinPlaceholder')}
                value={confirmPin}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, '')
                  setConfirmPin(val)
                }}
                maxLength={PIN_MAX}
                disabled={loading}
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1" onClick={handleClose} disabled={loading}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" className="flex-1" disabled={loading || !pinValid(oldPin) || !pinValid(newPin) || !pinValid(confirmPin)}>
                {loading ? t('common.loading') : t('common.save')}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}