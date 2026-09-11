import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { api } from '../../lib/api'

const PIN_MIN = 4
const PIN_MAX = 8

interface LoginScreenProps {
  onLogin: (username: string, expiresAt?: number) => void
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [newPin, setNewPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [hasPin, setHasPin] = useState<boolean | null>(null)
  const [directRegistrationOpen, setDirectRegistrationOpen] = useState(true)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [oauthProviders, setOauthProviders] = useState<Array<{ id: string; name: string }>>([])

  useEffect(() => {
    api.getOauthProviders().then((r) => setOauthProviders(r.providers)).catch(() => {})
    // Show OAuth callback errors (e.g. registration closed)
    const params = new URLSearchParams(window.location.search)
    const oauthError = params.get('oauth_error')
    if (oauthError) {
      setError(decodeURIComponent(oauthError))
      const url = new URL(window.location.href)
      url.searchParams.delete('oauth_error')
      history.replaceState(null, '', url.toString())
    }
  }, [])

  const handleUsernameSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim()) return

    setLoading(true)
    setError('')
    try {
      const status = await api.getUserStatus(username.trim())
      setHasPin(status.has_pin)
      setDirectRegistrationOpen(status.direct_registration_open)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.operationFailed'))
    } finally {
      setLoading(false)
    }
  }

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const len = pin.length
    if (len < PIN_MIN || len > PIN_MAX) {
      setError(t('login.pinFormatError'))
      return
    }

    setLoading(true)
    setError('')
    try {
      const result = await api.verifyPin(username.trim(), pin)
      onLogin(username.trim(), result.expires_at)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.pinError'))
    } finally {
      setLoading(false)
    }
  }

  const handleSetPinSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const nLen = newPin.length
    if (nLen < PIN_MIN || nLen > PIN_MAX) {
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
      onLogin(username.trim(), result.expires_at)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.operationFailed'))
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

  // Step 1: Username input + OAuth2 provider buttons
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

          {/* OAuth2 provider buttons */}
          {oauthProviders.length > 0 && (
            <div className="space-y-3">
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-background px-2 text-muted-foreground">{t('login.oauthDivider')}</span>
                </div>
              </div>
              <div className="space-y-2">
                {oauthProviders.map((p) => (
                  <Button
                    key={p.id}
                    variant="outline"
                    className="w-full"
                    onClick={() => { window.location.href = `/api/oauth/${p.id}/login` }}
                  >
                    {t('login.oauthLoginWith', { provider: p.name })}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Step 2a: No PIN — register when open, refuse when closed
  if (!hasPin) {
    if (!directRegistrationOpen) {
      return (
        <div className="flex items-center justify-center h-screen bg-background">
          <div className="w-full max-w-sm p-6 space-y-6">
            <div className="text-center space-y-2">
              <h1 className="text-2xl font-bold">{t('login.noAccessTitle')}</h1>
              <p className="text-sm text-muted-foreground">{t('login.noAccessMessage')}</p>
            </div>
            <Button variant="outline" className="w-full" onClick={handleBack}>
              {t('login.back')}
            </Button>
          </div>
        </div>
      )
    }

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
                const val = e.target.value.replace(/\D/g, '')
                setNewPin(val)
              }}
              disabled={loading}
              maxLength={PIN_MAX}
            />
            <Input
              type="password"
              placeholder={t('login.confirmPinPlaceholder')}
              value={confirmPin}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, '')
                setConfirmPin(val)
              }}
              disabled={loading}
              maxLength={PIN_MAX}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={newPin.length < PIN_MIN || confirmPin.length < PIN_MIN || loading}>
              {loading ? t('common.loading') : t('login.setPin')}
            </Button>
            <Button type="button" variant="outline" className="w-full" onClick={handleBack}>
              {t('login.back')}
            </Button>
          </form>
        </div>
      </div>
    )
  }

  // Step 2b: PIN verification (existing user)
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
              const val = e.target.value.replace(/\D/g, '')
              setPin(val)
            }}
            onKeyDown={(e) => { if (e.key === 'Enter') handlePinSubmit(e) }}
            disabled={loading}
            maxLength={PIN_MAX}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={pin.length < PIN_MIN || loading}>
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