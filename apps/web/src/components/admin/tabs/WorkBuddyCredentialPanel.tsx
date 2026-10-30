import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button'
import { Loading } from '../../ui/spinner'
import { useToast } from '../../ui/toast'
import { Copy, ExternalLink, LogIn, LogOut, RefreshCw, ShieldCheck } from 'lucide-react'
import { api } from '../../../lib/api'
import type { WorkBuddyLoginStatus, WorkBuddyStatus } from '@momoi/shared/types'

const POLL_MS = 1500
const LOGIN_DEADLINE_MS = 5 * 60_000

/**
 * WorkBuddy 上游的凭证面板。
 *
 * 状态机：进入面板拉状态、点登录后轮询进度、展示二维码、失败/超时可刷新、
 * 退出登录清除凭证。二维码来自登录页的微信授权。
 *
 * 登录页由服务端无头浏览器打开并截获微信二维码；前端不自动弹窗。二维码捕获
 * 完成前按钮保持「正在启动登录浏览器」；只有服务端确认二维码拿不到时，面板才
 * 提供「在浏览器中打开登录页」的最终回退。
 */
export function WorkBuddyCredentialPanel() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [credential, setCredential] = useState<WorkBuddyStatus | null>(null)
  const [login, setLogin] = useState<WorkBuddyLoginStatus | null>(null)
  const [starting, setStarting] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [])

  const refreshStatus = useCallback(async () => {
    try {
      setCredential(await api.workbuddyStatus())
    } catch (err) {
      console.error(err)
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
    return stopPolling
  }, [refreshStatus, stopPolling])

  const startLogin = useCallback(async () => {
    stopPolling()
    setStarting(true)
    try {
      await api.workbuddyLogin()
      // 握手只返回登录页地址；二维码由服务端异步截获，等 qr_state=ready 才结束启动态
      setLogin({ status: 'pending', qr_state: 'loading' })
      const deadline = Date.now() + LOGIN_DEADLINE_MS
      pollTimer.current = setInterval(async () => {
        if (Date.now() > deadline) {
          stopPolling()
          setLogin((prev) => ({
            ...(prev ?? { status: 'failed' }),
            status: 'failed',
            message: t('settings.gatewayLoginTimeout'),
          }))
          return
        }
        try {
          const status = await api.workbuddyLoginStatus()
          setLogin(status)
          if (status.status === 'success') {
            stopPolling()
            if (status.credential) setCredential(status.credential)
            else void refreshStatus()
            toast({ title: t('settings.gatewayLoginSuccess'), variant: 'success' })
          } else if (status.status === 'failed') {
            stopPolling()
            toast({ title: t('settings.gatewayLoginFailed'), variant: 'error' })
          } else if (status.status === 'idle') {
            // 服务端重启或登录会话已被清理：停止轮询，回到未登录态
            stopPolling()
          }
        } catch (err) {
          console.error(err)
        }
      }, POLL_MS)
    } catch (err) {
      console.error(err)
      setLogin({
        status: 'failed',
        message: err instanceof Error ? err.message : String(err),
      })
      toast({ title: t('settings.gatewayLoginFailed'), variant: 'error' })
    } finally {
      setStarting(false)
    }
  }, [refreshStatus, stopPolling, t, toast])

  const handleLogout = useCallback(async () => {
    stopPolling()
    try {
      await api.workbuddyLogout()
      setCredential({ logged_in: false, auto_refresh: true })
      setLogin(null)
      toast({ title: t('settings.gatewayLogoutSuccess'), variant: 'success' })
    } catch (err) {
      console.error(err)
    }
  }, [stopPolling, t, toast])

  /** 复制登录页地址：局域网 http 下 navigator.clipboard 不可用，退回 textarea + execCommand */
  const copyLoginUrl = useCallback(async (url: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url)
      } else {
        const el = document.createElement('textarea')
        el.value = url
        el.style.position = 'fixed'
        el.style.opacity = '0'
        document.body.appendChild(el)
        el.select()
        document.execCommand('copy')
        document.body.removeChild(el)
      }
      toast({ title: t('settings.workbuddyCopyLoginLinkSuccess'), variant: 'success' })
    } catch (err) {
      console.error(err)
      toast({ title: t('settings.workbuddyCopyLoginLinkFailed'), variant: 'error' })
    }
  }, [t, toast])

  if (!loaded && !login) return <Loading className="py-8" />

  const loggedIn = credential?.logged_in === true
  const expired = credential?.expired === true
  const waiting = login?.status === 'pending' || login?.status === 'scanned'
  const failed = login?.status === 'failed'
  const qrDataUrl = waiting ? login?.qr_data_url : undefined
  // 二维码未就绪（申请中）时按钮保持「正在获取二维码」
  const qrLoading = waiting && login?.qr_state !== 'ready' && login?.qr_state !== 'unavailable'
  const qrUnavailable = waiting && login?.qr_state === 'unavailable'
  const busy = starting || qrLoading

  return (
    <div>
      <label className="text-sm font-medium">{t('settings.gatewayCredential')}</label>
      <div className="mt-1 rounded-lg border bg-muted/30 p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <ShieldCheck className={loggedIn && !expired ? 'h-4 w-4 text-green-500' : 'h-4 w-4 text-muted-foreground'} />
          <span className="font-medium">
            {busy
              ? t('settings.gatewayStarting')
              : waiting
                ? login?.status === 'scanned'
                  ? t('settings.gatewayScanScanned')
                  : t('settings.gatewayScanWaiting')
                : loggedIn
                  ? expired
                    ? t('settings.gatewayCredentialExpired')
                    : t('settings.gatewayLoggedIn')
                  : t('settings.gatewayNotLoggedIn')}
          </span>
        </div>

        {loggedIn && (
          <div className="text-sm text-muted-foreground space-y-1">
            {(credential?.nickname || credential?.uid) && (
              <div>
                {t('settings.gatewayAccount')}：{credential.nickname || credential.uid}
                {credential.nickname && credential.uid ? ` (${credential.uid})` : ''}
              </div>
            )}
            {credential?.expires_at && (
              <div>{t('settings.workbuddyCredentialExpiresAt')}：{new Date(credential.expires_at).toLocaleString()}</div>
            )}
            {credential?.refresh_expires_at && (
              <div>{t('settings.workbuddyRefreshExpiresAt')}：{new Date(credential.refresh_expires_at).toLocaleString()}</div>
            )}
            <div>{t('settings.workbuddyAutoRefresh')}：{credential.auto_refresh ? t('settings.workbuddyAutoRefreshOn') : '—'}</div>
          </div>
        )}

        {waiting && qrDataUrl && (
          <div className="space-y-2">
            <img
              src={qrDataUrl}
              alt={t('settings.workbuddyQrAlt')}
              className="mx-auto h-44 w-44 rounded-md bg-white p-2"
            />
            <p className="text-center text-xs text-muted-foreground">{t('settings.workbuddyScanHint')}</p>
          </div>
        )}

        {qrUnavailable && login?.auth_url && (
          <div className="space-y-1">
            <p className="text-sm text-destructive break-words">{t('settings.workbuddyQrUnavailable')}</p>
            <div className="flex items-start gap-2">
              <code className="flex-1 break-all rounded bg-muted px-2 py-1 text-xs">{login.auth_url}</code>
              <Button
                size="sm"
                variant="outline"
                onClick={() => copyLoginUrl(login.auth_url!)}
              >
                <Copy className="mr-1 h-3 w-3" />
                {t('settings.workbuddyCopyLoginLink')}
              </Button>
            </div>
            <a
              href={login.auth_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('settings.workbuddyOpenLoginLink')}
            </a>
          </div>
        )}

        {failed && login?.message && (
          <p className="text-sm text-destructive break-words">{login.message}</p>
        )}

        <div className="flex items-center gap-2 pt-1">
          {waiting || failed ? (
            <Button size="sm" onClick={startLogin} disabled={busy}>
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5${busy ? ' animate-spin' : ''}`} />
              {busy ? t('settings.gatewayStarting') : t('settings.gatewayRefreshQr')}
            </Button>
          ) : (
            <Button size="sm" onClick={startLogin} disabled={starting}>
              <LogIn className="mr-1.5 h-3.5 w-3.5" />
              {starting ? t('settings.gatewayStarting') : loggedIn ? t('settings.gatewayRelogin') : t('settings.gatewayScanLogin')}
            </Button>
          )}
          {loggedIn && !waiting && (
            <Button size="sm" variant="outline" onClick={handleLogout}>
              <LogOut className="mr-1.5 h-3.5 w-3.5" />
              {t('settings.gatewayLogout')}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
