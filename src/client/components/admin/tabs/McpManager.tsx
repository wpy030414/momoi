import { useState, useEffect, forwardRef, useImperativeHandle } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../ui/dialog'
import { Plus, Trash2, Pencil } from 'lucide-react'
import { api } from '../../../lib/api'
import { useToast } from '../../ui/toast'
import type { McpServerConfig } from '@/shared/types'

export interface McpManagerHandle {
  triggerAdd: () => void
}

export const McpManager = forwardRef<McpManagerHandle>(function McpManager(_props, ref) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [servers, setServers] = useState<McpServerConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formName, setFormName] = useState('')
  const [formUrl, setFormUrl] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const fetchServers = () => {
    api.listMcpServers()
      .then((r) => setServers(r.servers))
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchServers()
  }, [])

  const openAdd = () => {
    setEditingId(null)
    setFormName('')
    setFormUrl('')
    setFormError(null)
    setDialogOpen(true)
  }

  const openEdit = (server: McpServerConfig) => {
    setEditingId(server.id)
    setFormName(server.name)
    setFormUrl(server.url)
    setFormError(null)
    setDialogOpen(true)
  }

  const handleSave = async () => {
    if (!formName.trim() || !formUrl.trim()) {
      setFormError(t('settings.mcpNameUrlRequired'))
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      if (editingId) {
        await api.updateMcpServer(editingId, { name: formName.trim(), url: formUrl.trim() })
      } else {
        await api.createMcpServer({ name: formName.trim(), url: formUrl.trim() })
      }
      setDialogOpen(false)
      fetchServers()
      toast({ title: t('settings.toastMcpSaved'), variant: 'success' })
    } catch (err: any) {
      setFormError(err.message)
    }
    setSaving(false)
  }

  const confirmDelete = async () => {
    if (!deleteId) return
    try {
      await api.deleteMcpServer(deleteId)
      fetchServers()
      toast({ title: t('settings.toastMcpDeleted'), variant: 'success' })
    } catch (err) {
      console.error('Failed to delete MCP server:', err)
    }
    setDeleteId(null)
  }

  useImperativeHandle(ref, () => ({ triggerAdd: openAdd }))

  return (
    <div className="space-y-4 pt-4">
      {loading ? (
        <p className="text-muted-foreground">{t('common.loading')}</p>
      ) : servers.length === 0 ? (
        <p className="text-muted-foreground">{t('settings.mcpNoServers')}</p>
      ) : (
        <div className="space-y-2">
          {servers.map((s) => (
            <div key={s.id} className="flex items-center justify-between p-3 border rounded-md">
              <div className="flex-1 min-w-0 mr-4">
                <p className="font-medium text-sm truncate">{s.name}</p>
                <p className="text-xs text-muted-foreground truncate">{s.url}</p>
              </div>
              <div className="flex gap-1 ml-2 shrink-0">
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => openEdit(s)} title={t('settings.mcpEditServer')}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive" onClick={() => setDeleteId(s.id)} title={t('common.remove')}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) setDialogOpen(false) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingId ? t('settings.mcpEditServer') : t('settings.mcpAddServer')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">{t('settings.mcpServerName')}</label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder={t('settings.mcpServerNamePlaceholder')}
                className="mt-1.5"
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.mcpServerUrl')}</label>
              <Input
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                placeholder={t('settings.mcpServerUrlPlaceholder')}
                className="mt-1.5"
              />
            </div>
            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteId} onOpenChange={(open) => { if (!open) setDeleteId(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common.remove')}</DialogTitle>
            <DialogDescription>
              {t('settings.mcpDeleteConfirm')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)}>
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
