import { useState, useEffect, forwardRef, useImperativeHandle } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Switch } from '../../ui/switch'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../ui/dialog'
import { Plus, Trash2, Pencil, Eye, EyeOff } from 'lucide-react'
import { api } from '../../../lib/api'
import { useToast } from '../../ui/toast'
import type { AdminUserRow, OAuth2Provider } from '@/shared/types'

export interface UserManagerHandle {}

function newProvider(): OAuth2Provider {
  return { id: crypto.randomUUID(), name: '', client_id: '', client_secret: '', authorize_url: '', token_url: '', userinfo_url: '', scopes: '' }
}

export const UserManager = forwardRef<UserManagerHandle>(function UserManager(_props, ref) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [users, setUsers] = useState<AdminUserRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [deleteUsername, setDeleteUsername] = useState<string | null>(null)
  const [registrationOpen, setRegistrationOpen] = useState(true)
  const [oauthProviders, setOauthProviders] = useState<OAuth2Provider[]>([])
  const [oauthDialogOpen, setOauthDialogOpen] = useState(false)
  const [oauthEditingId, setOauthEditingId] = useState<string | null>(null)
  const [oauthForm, setOauthForm] = useState(newProvider())
  const [oauthDeleteId, setOauthDeleteId] = useState<string | null>(null)
  const [oauthSaving, setOauthSaving] = useState(false)
  const [showSecret, setShowSecret] = useState(false)
  const pageSize = 10

  useEffect(() => {
    api.getRegistration().then((r) => setRegistrationOpen(r.registration_open)).catch(() => {})
    fetchOauthProviders()
  }, [])

  const fetchOauthProviders = () => {
    api.getConfig().then((c) => { setOauthProviders(c.oauth_providers || []) }).catch(console.error)
  }

  const fetchUsers = () => {
    setLoading(true)
    api.listAdminUsers(page, pageSize)
      .then((r) => { setUsers(r.users); setTotal(r.total) })
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchUsers() }, [page])

  const saveOauthProviders = async (updated: OAuth2Provider[]) => {
    setOauthProviders(updated)
    try { await api.updateConfig({ oauth_providers: updated }) }
    catch { fetchOauthProviders() }
  }

  const handleToggleRegistration = async (open: boolean) => {
    setRegistrationOpen(open)
    try { await api.setRegistration(open) }
    catch { setRegistrationOpen(!open) }
  }

  // ---- OAuth2 CRUD ----

  const openOauthAdd = () => {
    setOauthEditingId(null)
    setOauthForm(newProvider())
    setShowSecret(false)
    setOauthDialogOpen(true)
  }

  const openOauthEdit = (provider: OAuth2Provider) => {
    setOauthEditingId(provider.id)
    setOauthForm({ ...provider })
    setShowSecret(false)
    setOauthDialogOpen(true)
  }

  const handleOauthSave = async () => {
    if (!oauthForm.name.trim()) return
    setOauthSaving(true)
    const updated = oauthEditingId
      ? oauthProviders.map((p) => p.id === oauthEditingId ? oauthForm : p)
      : [...oauthProviders, oauthForm]
    await saveOauthProviders(updated)
    setOauthDialogOpen(false)
    toast({ title: t('settings.toastOauthSaved'), variant: 'success' })
    setOauthSaving(false)
  }

  const confirmOauthDelete = async () => {
    if (!oauthDeleteId) return
    const updated = oauthProviders.filter((p) => p.id !== oauthDeleteId)
    await saveOauthProviders(updated)
    toast({ title: t('settings.toastOauthDeleted'), variant: 'success' })
    setOauthDeleteId(null)
  }

  // ---- User actions ----

  const handleToggleBan = async (username: string, banned: boolean) => {
    try {
      await api.setUserBan(username, banned)
      toast({ title: banned ? t('settings.toastUserBanned') : t('settings.toastUserUnbanned'), variant: 'success' })
      fetchUsers()
    } catch (err: any) {
      toast({ title: err.message, variant: 'error' })
    }
  }

  const confirmDelete = async () => {
    if (!deleteUsername) return
    try {
      await api.deleteUser(deleteUsername)
      toast({ title: t('settings.toastUserDeleted'), variant: 'success' })
      fetchUsers()
    } catch (err: any) {
      toast({ title: err.message, variant: 'error' })
    }
    setDeleteUsername(null)
  }

  useImperativeHandle(ref, () => ({}))

  const formatTime = (ts: number | null) => ts ? new Date(ts * 1000).toLocaleString() : '-'
  const totalPages = Math.ceil(total / pageSize)

  return (
    <div className="space-y-4 pt-4">
      {/* Registration toggle */}
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium">{t('settings.registrationLabel')}</label>
        <Switch checked={registrationOpen} onCheckedChange={handleToggleRegistration} />
      </div>

      {/* OAuth2 providers */}
      <div>
        <div className="flex items-center mb-1">
          <label className="text-sm font-medium">{t('settings.oauthProviders')}</label>
          <Button variant="outline" size="sm" className="ml-auto" onClick={openOauthAdd}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            {t('settings.oauthAddProvider')}
          </Button>
        </div>
        {oauthProviders.length === 0 ? (
          <p className="text-muted-foreground">{t('settings.oauthNoProviders')}</p>
        ) : (
          <div className="space-y-2 mt-1">
            {oauthProviders.map((p) => (
              <div key={p.id} className="flex items-center justify-between p-3 border rounded-md">
                <div className="flex-1 min-w-0 mr-4">
                  <p className="font-medium text-sm truncate">{p.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{p.authorize_url || p.token_url}</p>
                </div>
                <div className="flex gap-1 ml-2 shrink-0">
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => openOauthEdit(p)} title={t('settings.oauthEditProvider')}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive" onClick={() => setOauthDeleteId(p.id)} title={t('common.remove')}>
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
        <p className="text-muted-foreground">{t('common.loading')}</p>
      ) : users.length === 0 ? (
        <p className="text-muted-foreground">{t('settings.noUsers')}</p>
      ) : (
        <>
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">{t('settings.userUsername')}</th>
                  <th className="text-left px-3 py-2 font-medium">{t('settings.userLastLogin')}</th>
                  <th className="text-left px-3 py-2 font-medium">{t('settings.userStatus')}</th>
                  <th className="text-right px-3 py-2 font-medium">{t('settings.userActions')}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.username} className="border-t">
                    <td className="px-3 py-2 font-medium">{u.username}</td>
                    <td className="px-3 py-2 text-muted-foreground">{formatTime(u.last_login_at)}</td>
                    <td className="px-3 py-2">
                      {u.banned ? (
                        <span className="text-xs text-destructive bg-destructive/10 px-1.5 py-0.5 rounded">
                          {t('settings.userBanned')}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {t('settings.userActive')}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => handleToggleBan(u.username, !u.banned)}>
                          {u.banned ? t('settings.userUnban') : t('settings.userBan')}
                        </Button>
                        <Button variant="destructive" size="sm" onClick={() => setDeleteUsername(u.username)}>
                          {t('common.remove')}
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
                {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, total)} / {total}
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

      {/* OAuth2 add/edit dialog */}
      <Dialog open={oauthDialogOpen} onOpenChange={(open) => { if (!open) setOauthDialogOpen(false) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {oauthEditingId ? t('settings.oauthEditProvider') : t('settings.oauthAddProvider')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">{t('settings.oauthProviderName')}</label>
              <Input
                value={oauthForm.name}
                onChange={(e) => setOauthForm({ ...oauthForm, name: e.target.value })}
                placeholder="GitHub"
                className="mt-1.5"
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.oauthProviderClientId')}</label>
              <Input
                value={oauthForm.client_id}
                onChange={(e) => setOauthForm({ ...oauthForm, client_id: e.target.value })}
                className="mt-1.5"
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.oauthProviderClientSecret')}</label>
              <div className="relative mt-1.5">
                <Input
                  type={showSecret ? 'text' : 'password'}
                  value={oauthForm.client_secret}
                  onChange={(e) => setOauthForm({ ...oauthForm, client_secret: e.target.value })}
                  className="pr-10"
                />
                <button type="button" onClick={() => setShowSecret(!showSecret)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                  {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.oauthProviderAuthorizeUrl')}</label>
              <Input
                value={oauthForm.authorize_url}
                onChange={(e) => setOauthForm({ ...oauthForm, authorize_url: e.target.value })}
                placeholder="https://github.com/login/oauth/authorize"
                className="mt-1.5"
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.oauthProviderTokenUrl')}</label>
              <Input
                value={oauthForm.token_url}
                onChange={(e) => setOauthForm({ ...oauthForm, token_url: e.target.value })}
                placeholder="https://github.com/login/oauth/access_token"
                className="mt-1.5"
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.oauthProviderUserinfoUrl')}</label>
              <Input
                value={oauthForm.userinfo_url}
                onChange={(e) => setOauthForm({ ...oauthForm, userinfo_url: e.target.value })}
                placeholder="https://api.github.com/user"
                className="mt-1.5"
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.oauthProviderScopes')}</label>
              <Input
                value={oauthForm.scopes}
                onChange={(e) => setOauthForm({ ...oauthForm, scopes: e.target.value })}
                placeholder="openid profile email"
                className="mt-1.5"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOauthDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleOauthSave} disabled={oauthSaving || !oauthForm.name.trim()}>
              {oauthSaving ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* OAuth2 delete confirmation dialog */}
      <Dialog open={!!oauthDeleteId} onOpenChange={(open) => { if (!open) setOauthDeleteId(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common.remove')}</DialogTitle>
            <DialogDescription>{t('settings.oauthDeleteConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOauthDeleteId(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmOauthDelete}>
              {t('common.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete user confirmation dialog */}
      <Dialog open={!!deleteUsername} onOpenChange={(open) => { if (!open) setDeleteUsername(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common.remove')}</DialogTitle>
            <DialogDescription>
              {t('settings.userDeleteConfirm', { username: deleteUsername ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteUsername(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              {t('common.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})