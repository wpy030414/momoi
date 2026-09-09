import { useState, useEffect, forwardRef, useImperativeHandle } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../ui/dialog'
import { api } from '../../../lib/api'
import { useToast } from '../../ui/toast'
import type { AdminUserRow } from '@/shared/types'

export interface UserManagerHandle {}

export const UserManager = forwardRef<UserManagerHandle>(function UserManager(_props, ref) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [users, setUsers] = useState<AdminUserRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [deleteUsername, setDeleteUsername] = useState<string | null>(null)
  const pageSize = 10

  const fetchUsers = () => {
    setLoading(true)
    api.listAdminUsers(page, pageSize)
      .then((r) => { setUsers(r.users); setTotal(r.total) })
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchUsers() }, [page])

  const handleToggleBan = async (username: string, banned: boolean) => {
    try {
      await api.setUserBan(username, banned)
      toast({
        title: banned ? t('settings.toastUserBanned') : t('settings.toastUserUnbanned'),
        variant: 'success',
      })
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
                  <th className="text-left px-3 py-2 font-medium">{t('settings.userFirstLogin')}</th>
                  <th className="text-left px-3 py-2 font-medium">{t('settings.userLastLogin')}</th>
                  <th className="text-left px-3 py-2 font-medium">{t('settings.userStatus')}</th>
                  <th className="text-right px-3 py-2 font-medium">{t('settings.userActions')}</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.username} className="border-t">
                    <td className="px-3 py-2 font-medium">{u.username}</td>
                    <td className="px-3 py-2 text-muted-foreground">{formatTime(u.first_login_at)}</td>
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
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleToggleBan(u.username, !u.banned)}
                        >
                          {u.banned ? t('settings.userUnban') : t('settings.userBan')}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setDeleteUsername(u.username)}
                        >
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

      {/* Delete confirmation dialog */}
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