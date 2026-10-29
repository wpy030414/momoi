import { useState, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button'
import { Loading } from '../../ui/spinner'
import { Input } from '../../ui/input'
import { Switch } from '../../ui/switch'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../ui/dialog'
import { Plus, Trash2, Pencil, Eye, EyeOff, Brain } from 'lucide-react'
import { api } from '../../../lib/api'
import { errT } from '../../../i18n'
import { useToast } from '../../ui/toast'
import { uuid } from '../../../lib/utils'
import type { AdminUserRow, OidcProvider } from '@momoi/shared/types'

export interface UserManagerHandle {}

function newProvider(): OidcProvider {
  return { id: uuid(), name: '', issuer: '', client_id: '', client_secret: '', scopes: 'openid' }
}

const PAGE_SIZE = 10

export const UserManager = forwardRef<UserManagerHandle>(function UserManager(_props, ref) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [users, setUsers] = useState<AdminUserRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [deleteUsername, setDeleteUsername] = useState<string | null>(null)
  const [directRegistrationOpen, setDirectRegistrationOpen] = useState(true)
  const [oidcRegistrationOpen, setOidcRegistrationOpen] = useState(true)
  const [oidcProviders, setOidcProviders] = useState<OidcProvider[]>([])
  const [oidcDialogOpen, setOidcDialogOpen] = useState(false)
  const [oidcEditingId, setOidcEditingId] = useState<string | null>(null)
  const [oidcForm, setOidcForm] = useState(newProvider())
  const [oidcDeleteId, setOidcDeleteId] = useState<string | null>(null)
  const [oidcSaving, setOidcSaving] = useState(false)
  const [showSecret, setShowSecret] = useState(false)

  useEffect(() => {
    api.getDirectRegistration().then((r) => setDirectRegistrationOpen(r.direct_registration_open)).catch(() => {})
    api.getOidcRegistration().then((r) => setOidcRegistrationOpen(r.oidc_registration_open)).catch(() => {})
    fetchOidcProviders()
  }, [])

  const fetchOidcProviders = () => {
    api.getConfig().then((c) => { setOidcProviders(c.oidc_providers || []) }).catch(console.error)
  }

  // useCallback 包裹后既是 effect 的合法依赖（规则要求），也被增删改操作
  // 复用为「操作完成后刷新列表」的句柄；仅随 page 变化重建。
  const fetchUsers = useCallback(() => {
    setLoading(true)
    api.listAdminUsers(page, PAGE_SIZE)
      .then((r) => { setUsers(r.users); setTotal(r.total) })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [page])

  useEffect(() => { fetchUsers() }, [fetchUsers])

  const saveOidcProviders = async (updated: OidcProvider[]) => {
    setOidcProviders(updated)
    try { await api.updateConfig({ oidc_providers: updated }) }
    catch { fetchOidcProviders() }
  }

  const handleToggleDirectRegistration = async (open: boolean) => {
    setDirectRegistrationOpen(open)
    try { await api.setDirectRegistration(open) }
    catch { setDirectRegistrationOpen(!open) }
  }

  const handleToggleOidcRegistration = async (open: boolean) => {
    setOidcRegistrationOpen(open)
    try { await api.setOidcRegistration(open) }
    catch { setOidcRegistrationOpen(!open) }
  }

  // ---- OIDC CRUD ----

  const openOidcAdd = () => {
    setOidcEditingId(null)
    setOidcForm(newProvider())
    setShowSecret(false)
    setOidcDialogOpen(true)
  }

  const openOidcEdit = (provider: OidcProvider) => {
    setOidcEditingId(provider.id)
    setOidcForm({ ...provider })
    setShowSecret(false)
    setOidcDialogOpen(true)
  }

  const handleOidcSave = async () => {
    if (!oidcForm.name.trim() || !oidcForm.id.trim()) return
    setOidcSaving(true)
    const updated = oidcEditingId
      ? oidcProviders.map((p) => p.id === oidcEditingId ? oidcForm : p)
      : [...oidcProviders, oidcForm]
    await saveOidcProviders(updated)
    setOidcDialogOpen(false)
    toast({ title: t('settings.toastOidcSaved'), variant: 'success' })
    setOidcSaving(false)
  }

  const confirmOidcDelete = async () => {
    if (!oidcDeleteId) return
    const updated = oidcProviders.filter((p) => p.id !== oidcDeleteId)
    await saveOidcProviders(updated)
    toast({ title: t('settings.toastOidcDeleted'), variant: 'success' })
    setOidcDeleteId(null)
  }

  // ---- User actions ----

  const handleToggleBan = async (username: string, banned: boolean) => {
    try {
      await api.setUserBan(username, banned)
      toast({ title: banned ? t('settings.toastUserBanned') : t('settings.toastUserUnbanned'), variant: 'success' })
      fetchUsers()
    } catch (err: any) {
      toast({ title: errT(err), variant: 'error' })
    }
  }

  const confirmDelete = async () => {
    if (!deleteUsername) return
    try {
      await api.deleteUser(deleteUsername)
      toast({ title: t('settings.toastUserDeleted'), variant: 'success' })
      fetchUsers()
    } catch (err: any) {
      toast({ title: errT(err), variant: 'error' })
    }
    setDeleteUsername(null)
  }

  const handleForgetMemories = async (username: string) => {
    try {
      const res = await api.forgetUserMemories(username)
      toast({ title: t('settings.toastUserForgotten', { count: res.deleted }), variant: 'success' })
    } catch (err: any) {
      toast({ title: errT(err), variant: 'error' })
    }
  }

  useImperativeHandle(ref, () => ({}))

  const formatTime = (ts: number | null) => ts ? new Date(ts * 1000).toLocaleString() : '-'
  const totalPages = Math.ceil(total / PAGE_SIZE)

  return (
    <div className="space-y-4 pt-4">
      {/* Direct registration toggle */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium">{t('settings.directRegistrationLabel')}</label>
        <Switch checked={directRegistrationOpen} onCheckedChange={handleToggleDirectRegistration} />
      </div>

      {/* OIDC registration toggle */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium">{t('settings.oidcRegistrationLabel')}</label>
        <Switch checked={oidcRegistrationOpen} onCheckedChange={handleToggleOidcRegistration} />
      </div>

      {/* OIDC providers */}
      <div>
        <div className="flex items-center mb-1">
          <label className="text-sm font-medium">{t('settings.oidcProviders')}</label>
          <Button variant="outline" size="sm" className="ml-auto" onClick={openOidcAdd}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('settings.oidcAddProvider')}
          </Button>
        </div>
        {oidcProviders.length === 0 ? (
          <p className="text-muted-foreground">{t('settings.oidcNoProviders')}</p>
        ) : (
          <div className="space-y-2 mt-1">
            {oidcProviders.map((p) => (
              <div key={p.id} className="flex items-center justify-between p-3 border rounded-md">
                <div className="flex-1 min-w-0 mr-4">
                  <p className="font-medium text-sm truncate">{p.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{p.issuer}</p>
                </div>
                <div className="flex gap-1 ml-2 shrink-0">
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => openOidcEdit(p)} title={t('settings.oidcEditProvider')}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive" onClick={() => setOidcDeleteId(p.id)} title={t('common.remove')}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* All users section */}
      <div>
        <label className="text-sm font-medium">{t('settings.allUsers')}</label>
        <div className="mt-1">

      {loading ? (
        <Loading className="py-8" />
      ) : users.length === 0 ? (
        <p className="text-muted-foreground">{t('settings.noUsers')}</p>
      ) : (
        <>
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">{t('settings.userUsername')}</th>
                  <th className="text-left px-3 py-2 font-medium">{t('settings.userOidcBindings')}</th>
                  <th className="text-left px-3 py-2 font-medium">{t('settings.userLastLogin')}</th>
                  <th className="text-right px-3 py-2 font-medium">{t('settings.userActions')}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.username} className="border-t">
                    <td className="px-3 py-2 font-medium">{u.username}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {u.oidc_providers.length > 0
                        ? u.oidc_providers.map((pid) => oidcProviders.find((p) => p.id === pid)?.name || pid).join(', ')
                        : '-'}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{formatTime(u.last_active_at ?? u.last_login_at)}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" className="text-amber-600 hover:text-amber-700" onClick={() => handleForgetMemories(u.username)}>
                          <Brain className="h-3.5 w-3.5 mr-1" />
                          {t('settings.userForget')}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleToggleBan(u.username, !u.banned)}>
                          {u.banned ? t('settings.userRestore') : t('settings.userBan')}
                        </Button>
                        <Button variant="destructive" size="sm" onClick={() => setDeleteUsername(u.username)}>
                          {t('settings.userRemove')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {(page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, total)} / {total}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(page - 1)}>
                  {t('settings.statsPrevPage')}
                </Button>
                <span className="flex items-center px-3 text-sm">{page} / {totalPages}</span>
                <Button variant="outline" size="sm" disabled={page === totalPages} onClick={() => setPage(page + 1)}>
                  {t('settings.statsNextPage')}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
        </div>
      </div>

      {/* OIDC add/edit dialog */}
      <Dialog open={oidcDialogOpen} onOpenChange={(open) => { if (!open) setOidcDialogOpen(false) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {oidcEditingId ? t('settings.oidcEditProvider') : t('settings.oidcAddProvider')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">{t('settings.oidcProviderName')}</label>
              <Input
                value={oidcForm.name}
                onChange={(e) => setOidcForm({ ...oidcForm, name: e.target.value })}
                placeholder={t('settings.oidcProviderNamePlaceholder')}
                className="mt-1.5"
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.oidcProviderId')}</label>
              <Input
                value={oidcForm.id}
                onChange={(e) => setOidcForm({ ...oidcForm, id: e.target.value })}
                placeholder={t('settings.oidcProviderIdPlaceholder')}
                className="mt-1.5"
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.oidcProviderClientId')}</label>
              <Input
                value={oidcForm.client_id}
                onChange={(e) => setOidcForm({ ...oidcForm, client_id: e.target.value })}
                className="mt-1.5"
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.oidcProviderClientSecret')}</label>
              <div className="relative mt-1.5">
                <Input
                  type={showSecret ? 'text' : 'password'}
                  value={oidcForm.client_secret}
                  onChange={(e) => setOidcForm({ ...oidcForm, client_secret: e.target.value })}
                  className="pr-10"
                />
                <button type="button" onClick={() => setShowSecret(!showSecret)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.oidcProviderIssuer')}</label>
              <Input
                value={oidcForm.issuer}
                onChange={(e) => setOidcForm({ ...oidcForm, issuer: e.target.value })}
                placeholder={t('settings.oidcProviderIssuerPlaceholder')}
                className="mt-1.5 font-mono text-xs"
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('settings.oidcProviderIssuerHint')}</p>
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.oidcProviderScopes')}</label>
              <Input
                value={oidcForm.scopes}
                onChange={(e) => setOidcForm({ ...oidcForm, scopes: e.target.value })}
                placeholder={t('settings.oidcProviderScopesPlaceholder')}
                className="mt-1.5"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOidcDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleOidcSave} disabled={oidcSaving || !oidcForm.name.trim() || !oidcForm.id.trim()}>
              {oidcSaving ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* OIDC delete confirmation dialog */}
      <Dialog open={!!oidcDeleteId} onOpenChange={(open) => { if (!open) setOidcDeleteId(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common.remove')}</DialogTitle>
            <DialogDescription>{t('settings.oidcDeleteConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOidcDeleteId(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmOidcDelete}>
              {t('common.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete user confirmation dialog */}
      <Dialog open={!!deleteUsername} onOpenChange={(open) => { if (!open) setDeleteUsername(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.userRemove')}</DialogTitle>
            <DialogDescription>
              {t('settings.userDeleteConfirm', { username: deleteUsername ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteUsername(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              {t('settings.userRemove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})