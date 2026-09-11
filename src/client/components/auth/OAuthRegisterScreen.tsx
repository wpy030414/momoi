import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { api } from '../../lib/api'

const PIN_MIN = 4
const PIN_MAX = 8

interface OAuthRegisterScreenProps {
  providerId: string
  providerUserId: string
  onLogin: (username: string, expiresAt?: number) => void
}

export function OAuthRegisterScreen({ providerId, providerUserId, onLogin }: OAuthRegisterScreenProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<'link' | 'create'>('link')

  // Link tab state
  const [linkUsername, setLinkUsername] = useState('')
  const [linkPin, setLinkPin] = useState('')

  // Create tab state
  const [newUsername, setNewUsername] = useState('')
  const [newPin, setNewPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleLink = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!linkUsername.trim() || linkPin.length < PIN_MIN) return

    setLoading(true)
    setError('')
    try {
      const result = await api.oauthRegister({
        provider_id: providerId,
        provider_user_id: providerUserId,
        action: 'link',
        username: linkUsername.trim(),
        pin: linkPin,
      })
      onLogin(result.username, result.expires_at)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.error'))
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newUsername.trim()) return
    if (newPin.length < PIN_MIN || newPin.length > PIN_MAX) {
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
      const result = await api.oauthRegister({
        provider_id: providerId,
        provider_user_id: providerUserId,
        action: 'create',
        username: newUsername.trim(),
        pin: newPin,
      })
      onLogin(result.username, result.expires_at)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.error'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex items-center justify-center h-screen bg-background">
      <div className="w-full max-w-sm p-6 space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold">{t('oauthRegister.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('oauthRegister.subtitle')}</p>
        </div>

        {/* Tab bar */}
        <div className="flex border-b">
          <button
            className={`flex-1 pb-2 text-sm font-medium border-b-2 transition-colors ${tab === 'link' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            onClick={() => { setTab('link'); setError('') }}
          >
            {t('oauthRegister.linkTab')}
          </button>
          <button
            className={`flex-1 pb-2 text-sm font-medium border-b-2 transition-colors ${tab === 'create' ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
            onClick={() => { setTab('create'); setError('') }}
          >
            {t('oauthRegister.createTab')}
          </button>
        </div>

        {tab === 'link' ? (
          <form onSubmit={handleLink} className="space-y-4">
            <Input
              autoFocus
              placeholder={t('login.usernamePlaceholder')}
              value={linkUsername}
              onChange={(e) => setLinkUsername(e.target.value)}
              disabled={loading}
            />
            <Input
              type="password"
              placeholder={t('login.pinPlaceholder')}
              value={linkPin}
              onChange={(e) => { setLinkPin(e.target.value.replace(/\D/g, '')) }}
              maxLength={PIN_MAX}
              disabled={loading}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={!linkUsername.trim() || linkPin.length < PIN_MIN || loading}>
              {loading ? t('common.loading') : t('oauthRegister.linkExisting')}
            </Button>
          </form>
        ) : (
          <form onSubmit={handleCreate} className="space-y-4">
            <Input
              autoFocus
              placeholder={t('login.usernamePlaceholder')}
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              disabled={loading}
            />
            <Input
              type="password"
              placeholder={t('login.newPinPlaceholder')}
              value={newPin}
              onChange={(e) => { setNewPin(e.target.value.replace(/\D/g, '')) }}
              maxLength={PIN_MAX}
              disabled={loading}
            />
            <Input
              type="password"
              placeholder={t('login.confirmPinPlaceholder')}
              value={confirmPin}
              onChange={(e) => { setConfirmPin(e.target.value.replace(/\D/g, '')) }}
              maxLength={PIN_MAX}
              disabled={loading}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={!newUsername.trim() || newPin.length < PIN_MIN || confirmPin.length < PIN_MIN || loading}>
              {loading ? t('common.loading') : t('oauthRegister.createNew')}
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}