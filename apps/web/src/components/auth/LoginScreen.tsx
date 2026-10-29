import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { api } from '../../lib/api'
import { ApiError } from '../../lib/apiError'
import { errT } from '../../i18n'
import { PinDots } from './PinDots'
import { PinKeypad } from './PinKeypad'
import { usePinKeypad, PIN_MIN, PIN_MAX } from '../../hooks/usePinKeypad'

interface LoginScreenProps {
  onLogin: (username: string, expiresAt?: number) => void
}

export function LoginScreen({ onLogin }: LoginScreenProps) {
  const { t } = useTranslation()
  const [username, setUsername] = useState('')
  const [hasPin, setHasPin] = useState<boolean | null>(null)
  const [directRegistrationOpen, setDirectRegistrationOpen] = useState(true)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [oauthProviders, setOauthProviders] = useState<Array<{ id: string; name: string }>>([])
  // 输错计数：每 +1 让圆点换 key 重播『变红 → 摇晃 → 淡回灰色』动画
  const [errorTick, setErrorTick] = useState(0)

  // 设置流程分两步收集：先新 PIN，再确认 PIN
  const [setStage, setSetStage] = useState<'new' | 'confirm'>('new')
  const [firstPin, setFirstPin] = useState('')

  const verifyKeypad = usePinKeypad({ onChange: () => { setError(''); setErrorTick(0) } })
  const setKeypad = usePinKeypad({ onChange: () => { setError(''); setErrorTick(0) } })

  const triggerInvalid = () => setErrorTick((n) => n + 1)

  useEffect(() => {
    api.getOauthProviders().then((r) => setOauthProviders(r.providers)).catch(() => {})
    // Show OAuth callback errors (e.g. registration closed) —
    // 回调以 oauth_error_code（+可选 oauth_error_detail）携带服务端错误码信封
    const params = new URLSearchParams(window.location.search)
    const oauthErrorCode = params.get('oauth_error_code')
    if (oauthErrorCode) {
      const detail = params.get('oauth_error_detail')
      setError(errT(new ApiError(oauthErrorCode, 0, detail ? { detail } : undefined)))
      const url = new URL(window.location.href)
      url.searchParams.delete('oauth_error_code')
      url.searchParams.delete('oauth_error_detail')
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
      setError(errT(err))
    } finally {
      setLoading(false)
    }
  }

  const handlePinSubmit = async () => {
    const len = verifyKeypad.length
    if (len < PIN_MIN || len > PIN_MAX) {
      setError(t('login.pinFormatError'))
      return
    }

    setLoading(true)
    setError('')
    try {
      const result = await api.verifyPin(username.trim(), verifyKeypad.value)
      onLogin(username.trim(), result.expires_at)
    } catch (err) {
      setError(errT(err))
      triggerInvalid()
      verifyKeypad.clear()
    } finally {
      setLoading(false)
    }
  }

  const handleSetPinSubmit = async () => {
    const len = setKeypad.length
    if (len < PIN_MIN || len > PIN_MAX) {
      setError(t('login.pinFormatError'))
      triggerInvalid()
      return
    }
    if (setStage === 'new') {
      setFirstPin(setKeypad.value)
      setKeypad.clear()
      setSetStage('confirm')
      return
    }
    if (setKeypad.value !== firstPin) {
      setError(t('login.pinMismatch'))
      triggerInvalid()
      setSetStage('new')
      return
    }

    setLoading(true)
    setError('')
    try {
      const result = await api.setPin(username.trim(), setKeypad.value)
      onLogin(username.trim(), result.expires_at)
    } catch (err) {
      setError(errT(err))
      triggerInvalid()
    } finally {
      setLoading(false)
    }
  }

  /** 设置流程的返回：确认阶段回到重输新 PIN，首次阶段回到用户名 */
  const handleSetBack = () => {
    if (setStage === 'confirm') {
      setKeypad.clear()
      setSetStage('new')
      return
    }
    handleBack()
  }

  const handleBack = () => {
    setUsername('')
    verifyKeypad.clear()
    setKeypad.clear()
    setFirstPin('')
    setSetStage('new')
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
      <PinPadLayout
        title={setStage === 'new' ? t('login.setTitle') : t('login.confirmPinTitle')}
        subtitle={
          setStage === 'new'
            ? t('login.setSubtitle', { username })
            : t('login.confirmPinSubtitle')
        }
        onKeyDown={setKeypad.handleKeyDown}
      >
        <PinDots length={setKeypad.length} maxLength={PIN_MAX} errorTick={errorTick} />
        {error && (
          <p className="text-center text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <PinKeypad
          onDigit={setKeypad.append}
          onBackspace={setKeypad.backspace}
          onExtra={handleSetBack}
          extraLabel={t('login.back')}
          showSubmit={setKeypad.length >= PIN_MIN}
          submitLabel={t('login.submitPin')}
          onSubmit={handleSetPinSubmit}
          disabled={loading}
        />
      </PinPadLayout>
    )
  }

  // Step 2b: PIN verification (existing user)
  return (
    <PinPadLayout
      title={t('login.verifyTitle')}
      subtitle={t('login.verifySubtitle', { username })}
      onKeyDown={verifyKeypad.handleKeyDown}
    >
      <PinDots length={verifyKeypad.length} maxLength={PIN_MAX} errorTick={errorTick} />
      {error && (
        <p className="text-center text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <PinKeypad
        onDigit={verifyKeypad.append}
        onBackspace={verifyKeypad.backspace}
        onExtra={handleBack}
        extraLabel={t('login.back')}
        showSubmit={verifyKeypad.length >= PIN_MIN}
        submitLabel={t('login.verify')}
        onSubmit={handlePinSubmit}
        disabled={loading}
      />
    </PinPadLayout>
  )
}

/**
 * PIN 键盘页的统一外框：标题 + 圆点 + 键盘。
 * 挂上 keydown 以支持物理键盘输入（桌面端不必点屏也能输 PIN）。
 */
function PinPadLayout({
  title,
  subtitle,
  onKeyDown,
  children,
}: {
  title: string
  subtitle: string
  onKeyDown: (e: React.KeyboardEvent) => void
  children: React.ReactNode
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  // 进入键盘页时把焦点放到外框，物理键盘的数字键才能落到 onKeyDown 上
  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  return (
    <div
      ref={rootRef}
      className="flex h-screen touch-manipulation flex-col items-center justify-center bg-background px-6 py-10 outline-none"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  )
}