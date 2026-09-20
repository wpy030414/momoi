import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../ui/dialog'
import { Plus, Trash2, Pencil, ChevronLeft, ChevronRight } from 'lucide-react'
import { api } from '../../lib/api'
import { useToast } from '../ui/toast'
import type { UserAgentMemory } from '@momoi/shared/types'

// Keep in sync with MAX_MEMORY_LENGTH in server tools/memory-tool.ts and routes/memories.ts
const MAX_CONTENT_LENGTH = 4000
const PAGE_SIZE = 50

interface MemoryManagerProps {
  /** Currently selected agent id (may be an orphan id whose agent was deleted). */
  agentId: string | null
  /** The agent object; null when agentId is an orphan (deleted agent). */
  agent: { id: string; name: string; avatar: string } | null
  /** All memories of the current user (unfiltered; newest first). */
  memories: UserAgentMemory[]
  loading: boolean
  /** Refetch callback after any mutation. */
  onChanged: () => void
}

/** Memory manager main area — entry list of the selected agent with
 *  add / edit / delete / clear-all dialogs. Client-side paging, 50 per page. */
export function MemoryManager({ agentId, agent, memories, loading, onChanged }: MemoryManagerProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [page, setPage] = useState(1)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formContent, setFormContent] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [clearAllOpen, setClearAllOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const entries = useMemo(
    () => (agentId ? memories.filter((m) => m.agent_id === agentId) : []),
    [memories, agentId]
  )
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE))
  const paged = entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  // Switching agent resets paging; shrinking lists clamp back into range.
  useEffect(() => { setPage(1) }, [agentId])
  useEffect(() => { if (page > totalPages) setPage(totalPages) }, [totalPages, page])

  const openAdd = () => {
    setEditingId(null)
    setFormContent('')
    setFormError(null)
    setDialogOpen(true)
  }

  const openEdit = (m: UserAgentMemory) => {
    setEditingId(m.id)
    setFormContent(m.content)
    setFormError(null)
    setDialogOpen(true)
  }

  const handleSave = async () => {
    const content = formContent.trim()
    if (!content) {
      setFormError(t('memory.contentRequired'))
      return
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      setFormError(t('memory.tooLong'))
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      if (editingId) {
        await api.updateMemory(editingId, content)
      } else if (agentId) {
        await api.createMemory(agentId, content)
      }
      setDialogOpen(false)
      onChanged()
      toast({ title: t('memory.toastSaved'), variant: 'success' })
    } catch (err: any) {
      setFormError(err.message)
    }
    setSaving(false)
  }

  const confirmDelete = async () => {
    if (!deleteId) return
    try {
      await api.deleteMemory(deleteId)
      onChanged()
      toast({ title: t('memory.toastDeleted'), variant: 'success' })
    } catch (err) {
      console.error('Failed to delete memory:', err)
    }
    setDeleteId(null)
  }

  const confirmClearAll = async () => {
    if (!agentId) return
    try {
      const r = await api.clearAgentMemories(agentId)
      onChanged()
      toast({ title: t('memory.toastCleared', { count: r.deleted }), variant: 'success' })
    } catch (err) {
      console.error('Failed to clear agent memories:', err)
    }
    setClearAllOpen(false)
  }

  const agentName = agent?.name ?? t('memory.unknownAgent')

  return (
    <div className="space-y-4 pt-4 max-w-3xl">
      {/* Header — agent name + actions */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          {agent?.avatar ? (
            <img src={agent.avatar} alt="" className="w-6 h-6 rounded-full object-cover flex-shrink-0" />
          ) : (
            <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium flex-shrink-0">
              {agentName.charAt(0)}
            </div>
          )}
          <h2 className="text-sm font-semibold truncate">{agentName}</h2>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {/* Cannot add memories to a deleted agent */}
          {agent && (
            <Button variant="outline" size="sm" onClick={openAdd}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              {t('memory.add')}
            </Button>
          )}
          {entries.length > 0 && (
            <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => setClearAllOpen(true)}>
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {t('memory.clearAll')}
            </Button>
          )}
        </div>
      </div>

      {/* Entry list */}
      {loading ? (
        <p className="text-muted-foreground">{t('common.loading')}</p>
      ) : entries.length === 0 ? (
        <p className="text-muted-foreground">{t('memory.noEntries')}</p>
      ) : (
        <div className="space-y-2">
          {paged.map((m) => (
            <div key={m.id} className="flex items-start justify-between p-3 border rounded-md">
              <div className="flex-1 min-w-0 mr-4">
                <p className="text-sm whitespace-pre-wrap break-words line-clamp-3">{m.content}</p>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${
                    m.source === 'agent'
                      ? 'bg-secondary text-secondary-foreground'
                      : 'bg-primary/10 text-primary'
                  }`}>
                    {t(m.source === 'agent' ? 'memory.sourceAgent' : 'memory.sourceUser')}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(m.created_at * 1000).toLocaleString()}
                  </span>
                </div>
              </div>
              <div className="flex gap-1 ml-2 shrink-0">
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => openEdit(m)} title={t('memory.edit')}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive" onClick={() => setDeleteId(m.id)} title={t('common.remove')}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}

          {/* Pagination — 50 per page, newest first */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-2">
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm text-muted-foreground tabular-nums">
                {t('memory.pageInfo', { page, total: totalPages })}
              </span>
              <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) setDialogOpen(false) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingId ? t('memory.edit') : t('memory.add')}
            </DialogTitle>
            <DialogDescription>{agentName}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">{t('memory.content')}</label>
              <textarea
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                rows={6}
                placeholder={t('memory.contentPlaceholder')}
                className="w-full mt-1 rounded-md border bg-background px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground text-right tabular-nums">
                {formContent.length} / {MAX_CONTENT_LENGTH}
              </p>
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
            <DialogDescription>{t('memory.deleteConfirm')}</DialogDescription>
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

      {/* Clear-All Confirmation Dialog */}
      <Dialog open={clearAllOpen} onOpenChange={setClearAllOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('memory.clearAll')}</DialogTitle>
            <DialogDescription>
              {t('memory.clearAllConfirm', { name: agentName, count: entries.length })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearAllOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmClearAll}>
              {t('memory.clearAll')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
