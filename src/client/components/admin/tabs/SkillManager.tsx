import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../ui/dialog'
import { Upload } from 'lucide-react'
import { api } from '../../../lib/api'
import { useToast } from '../../ui/toast'

interface SkillManagerProps {
  token: string
}

export function SkillManager({ token }: SkillManagerProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [skills, setSkills] = useState<any[]>([])
  const [fetching, setFetching] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [deleteSkillName, setDeleteSkillName] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.listAdminSkills(token)
      .then((r) => setSkills(r.skills))
      .catch(console.error)
      .finally(() => setFetching(false))
  }, [token])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadError(null)
    try {
      const result = await api.uploadSkill(token, file)
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
      await api.uninstallSkill(token, deleteSkillName)
      const r = await api.listAdminSkills(token)
      setSkills(r.skills)
      toast({ title: t('settings.toastSkillRemoved'), variant: 'success' })
    } catch (err) {
      console.error('Failed to uninstall skill:', err)
    }
    setDeleteSkillName(null)
  }

  return (
    <div className="space-y-4 pt-4">
      <div className="flex items-center gap-2">
        <input ref={fileInputRef} type="file" accept=".zip" className="hidden" onChange={handleUpload} />
        <Button variant="outline" size="sm" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
          <Upload className="mr-2 h-4 w-4" />
          {uploading ? t('common.loading') : t('settings.uploadSkill')}
        </Button>
      </div>
      {uploadError && <p className="text-sm text-destructive">{uploadError}</p>}
      {fetching ? (
        <p className="text-muted-foreground">{t('common.loading')}</p>
      ) : skills.length === 0 ? (
        <p className="text-muted-foreground">{t('settings.noSkills')}</p>
      ) : (
        skills.map((s) => (
          <div key={s.manifest?.name || s.name} className="flex items-center justify-between p-3 border rounded-md">
            <div>
              <p className="font-medium">{s.manifest?.name || s.name}</p>
              <p className="text-sm text-muted-foreground">{s.manifest?.description || s.description}</p>
            </div>
            <Button variant="destructive" size="sm" onClick={() => {
              setDeleteSkillName(s.manifest?.name || s.name)
            }}>
              {t('common.remove')}
            </Button>
          </div>
        ))
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
}