import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../ui/dialog'
import { Upload, Trash2 } from 'lucide-react'
import { api } from '../../../lib/api'
import { useToast } from '../../ui/toast'

export interface SkillManagerHandle {
  triggerUpload: () => void
}

export const SkillManager = forwardRef<SkillManagerHandle>(function SkillManager(_props, ref) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [skills, setSkills] = useState<any[]>([])
  const [fetching, setFetching] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [deleteSkillName, setDeleteSkillName] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.listAdminSkills()
      .then((r) => setSkills(r.skills))
      .catch(console.error)
      .finally(() => setFetching(false))
  }, [])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadError(null)
    try {
      const result = await api.uploadSkill(file)
      setSkills(result.skills)
      toast({ title: t('settings.toastSkillUploaded'), variant: 'success' })
    } catch (err: any) {
      setUploadError(err.message)
    }
    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const confirmUninstallSkill = async () => {
    if (!deleteSkillName) return
    try {
      await api.uninstallSkill(deleteSkillName)
      const r = await api.listAdminSkills()
      setSkills(r.skills)
      toast({ title: t('settings.toastSkillRemoved'), variant: 'success' })
    } catch (err) {
      console.error('Failed to uninstall skill:', err)
    }
    setDeleteSkillName(null)
  }

  useImperativeHandle(ref, () => ({ triggerUpload: () => fileInputRef.current?.click() }))

  return (
    <div className="space-y-4 pt-4">
      <input ref={fileInputRef} type="file" accept=".zip" className="hidden" hidden onChange={handleUpload} />
      {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}
      {fetching ? (
        <p className="text-muted-foreground">{t('common.loading')}</p>
      ) : skills.length === 0 ? (
        <p className="text-muted-foreground">{t('settings.noSkills')}</p>
      ) : (
        <div className="space-y-2">
          {skills.map((s) => (
          <div key={s.manifest?.name || s.name} className="flex items-center justify-between p-3 border rounded-md">
            <div className="min-w-0 flex-1 mr-4">
              <p className="font-medium text-sm truncate">{s.manifest?.name || s.name}</p>
              <p className="text-xs text-muted-foreground truncate">{s.manifest?.description || s.description}</p>
            </div>
            <div className="flex gap-1 ml-2 shrink-0">
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive" onClick={() => {
                setDeleteSkillName(s.manifest?.name || s.name)
              }} title={t('common.remove')}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteSkillName} onOpenChange={(open) => { if (!open) setDeleteSkillName(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('common.remove')}</DialogTitle>
            <DialogDescription>
              {t('settings.skillDeleteConfirm')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteSkillName(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmUninstallSkill}>
              {t('common.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})
