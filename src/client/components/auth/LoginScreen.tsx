import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { api } from '../../lib/api'

interface LoginScreenProps {
  onLogin: (username: string, token: string, expiresAt?: number) => void
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [hasPin, setHasPin] = useState<boolean | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleUsernameSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim()) return

    setLoading(true)
    setError('')
    try {
      const status = await api.getUserStatus(username.trim())
      setHasPin(status.has_pin)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.error'))
    } finally {
      setLoading(false)
    }
  }

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!/^\d{4}$/.test(pin)) {
      setError(t('login.pinFormatError'))
      return
    }

    setLoading(true)
    setError('')
    try {
      const result = await api.verifyPin(username.trim(), pin)
      onLogin(username.trim(), result.token, result.expires_at)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.pinError'))
    } finally {
      setLoading(false)
    }
  }

  const handleSetPinSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!/^\d{4}$/.test(newPin)) {
      setError(t('login.pinFormatError'))
      return
    }
    if (newPin !== confirmPin) {
      setError(t('login.pinMismatch'))
      return
    }

    setLoading(true)
    setError('')
    try {
      const result = await api.setPin(username.trim(), newPin)
      onLogin(username.trim(), result.token, result.expires_at)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.error'))
    } finally {
      setLoading(false)
    }
  }

  const handleBack = () => {
    setUsername('')
    setPin('')
    setNewPin('')
    setConfirmPin('')
    setHasPin(null)
    setError('')
  }

  // Step 1: Username input
  if (hasPin === null) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="w-full max-w-sm p-6 space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold">{t('login.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('login.subtitle')}</p>
          </div>
          <form onSubmit={handleUsernameSubmit} className="space-y-4">
            <Input
              autoFocus
              placeholder={t('login.usernamePlaceholder')}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleUsernameSubmit(e) }}
              disabled={loading}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={!username.trim() || loading}>
              {loading ? t('common.loading') : t('login.submit')}
            </Button>
          </form>
        </div>
      </div>
    )
  }

  // Step 2: PIN verification (existing user)
  if (hasPin) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="w-full max-w-sm p-6 space-y-6">
          <div className="text-center space-y-2">
            <h1 className="text-2xl font-bold">{t('login.verifyTitle')}</h1>
            <p className="text-sm text-muted-foreground">{t('login.verifySubtitle', { username })}</p>
          </div>
          <form onSubmit={handlePinSubmit} className="space-y-4">
            <Input
              autoFocus
              type="password"
              placeholder={t('login.pinPlaceholder')}
              value={pin}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, '').slice(0, 4)
                setPin(val)
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') handlePinSubmit(e) }}
              disabled={loading}
              maxLength={4}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={pin.length !== 4 || loading}>
              {loading ? t('common.loading') : t('login.verify')}
            </Button>
            <Button type="button" variant="outline" className="w-full" onClick={handleBack}>
              {t('login.back')}
            </Button>
          </form>
        </div>
      </div>
    )
  }

  // Step 2: Set new PIN (new user)
  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <div className="w-full max-w-sm p-6 space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">{t('login.setTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('login.setSubtitle', { username })}</p>
        </div>
        <form onSubmit={handleSetPinSubmit} className="space-y-4">
          <Input
            autoFocus
            type="password"
            placeholder={t('login.newPinPlaceholder')}
            value={newPin}
            onChange={(e) => {
              const val = e.target.value.replace(/\D/g, '').slice(0, 4)
              setNewPin(val)
            }}
            disabled={loading}
            maxLength={4}
          />
          <Input
            type="password"
            placeholder={t('login.confirmPinPlaceholder')}
            value={confirmPin}
            onChange={(e) => {
              const val = e.target.value.replace(/\D/g, '').slice(0, 4)
              setConfirmPin(val)
            }}
            disabled={loading}
            maxLength={4}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={newPin.length !== 4 || confirmPin.length !== 4 || loading}>
            {loading ? t('common.loading') : t('login.setPin')}
          </Button>
        </form>
      </div>
    </div>
  )
}
