import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Switch } from '../../ui/switch'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../ui/dialog'
import { Plus, Trash2, Edit3 } from 'lucide-react'
import { api } from '../../../lib/api'
import { useToast } from '../../ui/toast'
import type { McpServerConfig } from '@/shared/types'

interface McpManagerProps {
  token: string
}

export function McpManager({ token }: McpManagerProps) {
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
    api.listMcpServers(token)
      .then((r) => setServers(r.servers))
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchServers()
  }, [token])

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
      setFormError(t('settings.mcpNameUrlRequired') || 'Name and URL are required')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      if (editingId) {
        await api.updateMcpServer(token, editingId, { name: formName.trim(), url: formUrl.trim() })
      } else {
        await api.createMcpServer(token, { name: formName.trim(), url: formUrl.trim() })
      }
      setDialogOpen(false)
      fetchServers()
      toast({ title: t('settings.toastMcpSaved'), variant: 'success' })
    } catch (err: any) {
      setFormError(err.message)
    }
    setSaving(false)
  }

  const handleToggle = async (server: McpServerConfig) => {
    try {
      await api.updateMcpServer(token, server.id, { enabled: !server.enabled })
      fetchServers()
    } catch (err) {
      console.error('Failed to toggle MCP server:', err)
    }
  }

  const confirmDelete = async () => {
    if (!deleteId) return
    try {
      await api.deleteMcpServer(token, deleteId)
      fetchServers()
      toast({ title: t('settings.toastMcpDeleted'), variant: 'success' })
    } catch (err) {
      console.error('Failed to delete MCP server:', err)
    }
    setDeleteId(null)
  }

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={openAdd}>
          <Plus className="mr-2 h-4 w-4" />
          {t('settings.mcpAddServer')}
        </Button>
      </div>

      {loading ? (
        <p className="text-muted-foreground">{t('common.loading')}</p>
      ) : servers.length === 0 ? (
        <p className="text-muted-foreground">{t('settings.mcpNoServers')}</p>
      ) : (
        <div className="space-y-2">
          {servers.map((s) => (
            <div key={s.id} className="flex items-center justify-between p-3 border rounded-md">
              <div className="flex-1 min-w-0 mr-4">
                <div className="flex items-center gap-2">
                  <p className="font-medium truncate">{s.name}</p>
                  {!s.enabled && (
                    <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      {t('settings.mcpDisabled') || 'Disabled'}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground truncate">{s.url}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Switch checked={s.enabled} onCheckedChange={() => handleToggle(s)} />
                <Button variant="ghost" size="icon" onClick={() => openEdit(s)} title={t('settings.mcpEditServer')}>
                  <Edit3 className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => setDeleteId(s.id)} title={t('common.remove')}>
                  <Trash2 className="h-4 w-4 text-destructive" />
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
                placeholder="e.g. DingTalk MCP"
                className="mt-1.5"
              />
            </div>
            <div>
              <label className="text-sm font-medium">{t('settings.mcpServerUrl')}</label>
              <Input
                value={formUrl}
                onChange={(e) => setFormUrl(e.target.value)}
                placeholder="http://localhost:8080"
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
}