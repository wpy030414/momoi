import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../ui/dialog'
import { Download, Upload, AlertTriangle } from 'lucide-react'
import { api } from '../../../lib/api'
import { errFromEnvelope } from '../../../lib/apiError'
import { errT } from '../../../i18n'
import { useToast } from '../../ui/toast'
import type { ImportIssue, ImportSummary } from '@momoi/shared/types'

const MAX_IMPORT_BYTES = 10 * 1024 * 1024

/** 预检 / 导入结果对话框状态（正式导入因并发校验失败时 ok 翻转为 false 并携带 errors） */
interface DialogState {
  ok: boolean
  errors: ImportIssue[]
  warnings: ImportIssue[]
  summary?: ImportSummary
}

function IssueList({ issues, destructive }: { issues: ImportIssue[]; destructive?: boolean }) {
  return (
    <ul className={`text-xs space-y-1.5 max-h-56 overflow-y-auto ${destructive ? 'text-destructive' : 'text-amber-600'}`}>
      {issues.map((e, i) => (
        <li key={i} className="font-mono break-all">
          {e.path ? `${e.path}: ` : ''}
          {errT(errFromEnvelope(e))}
        </li>
      ))}
    </ul>
  )
}

/** 一行分组摘要：标题 + 内容 */
function SummaryRow({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="text-sm">
      <span className="text-muted-foreground">{title}</span>
      <span className="ml-2">{children}</span>
    </div>
  )
}

export function ConfigTransfer() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [exporting, setExporting] = useState(false)
  const [reading, setReading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const contentRef = useRef('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleExport = async () => {
    setExporting(true)
    try {
      const { blob, filename } = await api.exportConfig()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      toast({ title: t('settings.configExportDone'), variant: 'success' })
    } catch (err) {
      toast({ title: errT(err), variant: 'error' })
    }
    setExporting(false)
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 允许重复选择同一文件
    if (!file) return
    if (file.size > MAX_IMPORT_BYTES) {
      toast({ title: t('settings.configImportTooLarge'), variant: 'error' })
      return
    }
    const content = await file.text()
    contentRef.current = content
    setReading(true)
    try {
      const res = await api.importConfigDryRun(content)
      setDialog({ ok: res.ok, errors: res.errors || [], warnings: res.warnings || [], summary: res.summary })
    } catch (err) {
      toast({ title: errT(err), variant: 'error' })
    }
    setReading(false)
  }

  const confirmImport = async () => {
    setApplying(true)
    try {
      const res = await api.importConfig(contentRef.current)
      if (res.ok) {
        setDialog(null)
        toast({ title: t('settings.configImportAppliedToast'), variant: 'success' })
      } else {
        // dry-run 与确认之间服务端状态变化——展示新的校验错误
        setDialog({ ok: false, errors: res.errors || [], warnings: res.warnings || [] })
      }
    } catch (err) {
      toast({ title: errT(err), variant: 'error' })
    }
    setApplying(false)
  }

  const s = dialog?.summary

  return (
    <div className="space-y-6 pt-4">
      {/* ---- 导出 ---- */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">{t('settings.configExportTitle')}</h3>
        <p className="text-xs text-muted-foreground">{t('settings.configExportDesc')}</p>
        <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          {t('settings.configExportSecretWarn')}
        </div>
        <Button onClick={handleExport} disabled={exporting}>
          <Download className="mr-1.5 h-3.5 w-3.5" />
          {exporting ? t('common.saving') : t('settings.configExportBtn')}
        </Button>
      </section>

      {/* ---- 导入 ---- */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">{t('settings.configImportTitle')}</h3>
        <p className="text-xs text-muted-foreground">{t('settings.configImportDesc')}</p>
        <input ref={fileInputRef} type="file" accept=".yml,.yaml" className="hidden" onChange={handleFileChange} />
        <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={reading}>
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          {reading ? t('settings.configImportReading') : t('settings.configImportBtn')}
        </Button>
      </section>

      {/* ---- 预检 / 确认对话框 ---- */}
      <Dialog open={!!dialog} onOpenChange={(open) => { if (!open && !applying) setDialog(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{dialog?.ok ? t('settings.configImportConfirmTitle') : t('settings.configImportFailed')}</DialogTitle>
            {dialog?.ok && <DialogDescription>{t('settings.configImportConfirmDesc')}</DialogDescription>}
          </DialogHeader>

          {!dialog?.ok ? (
            dialog && dialog.errors.length > 0 ? (
              <IssueList issues={dialog.errors} destructive />
            ) : null
          ) : (
            <div className="space-y-3">
              {/* 体验 */}
              {s?.experience && (
                <SummaryRow title={t('settings.configSummaryExperience')}>
                  {s.experience.changed.length > 0
                    ? `${t('settings.configSummaryChanged')}: ${s.experience.changed.join(', ')}`
                    : t('settings.configSummaryNoChanges')}
                </SummaryRow>
              )}
              {/* 智能体 */}
              {s?.agents && (
                <div className="text-sm space-y-1">
                  <div>
                    <span className="text-muted-foreground">{t('settings.configSummaryAgents')}</span>
                    <span className="ml-2">
                      {t('settings.configSummaryAgentUpdate', { n: s.agents.update.length })}
                      {' · '}
                      {t('settings.configSummaryAgentCreate', { n: s.agents.create.length })}
                      {' · '}
                      {t('settings.configSummaryAgentSkip', { n: s.agents.skip.length })}
                    </span>
                  </div>
                  {s.agents.create.length > 0 && (
                    <div className="pl-1 text-xs text-muted-foreground">
                      {s.agents.create.map((a) => a.name).join(', ')}
                      <span className="block text-amber-600">{t('settings.configSummaryAgentNewHint')}</span>
                    </div>
                  )}
                </div>
              )}
              {/* 用户 */}
              {s?.users && (
                <div className="text-sm space-y-1">
                  {s.users.direct_registration_open && (
                    <SummaryRow title="direct_registration_open">
                      {String(s.users.direct_registration_open.from)} → {String(s.users.direct_registration_open.to)}
                    </SummaryRow>
                  )}
                  {s.users.oauth_registration_open && (
                    <SummaryRow title="oauth_registration_open">
                      {String(s.users.oauth_registration_open.from)} → {String(s.users.oauth_registration_open.to)}
                    </SummaryRow>
                  )}
                  {(s.users.providers_update > 0 || s.users.providers_create > 0) && (
                    <SummaryRow title={t('settings.configSummaryUsers')}>
                      {t('settings.configSummaryProviders', { u: s.users.providers_update, c: s.users.providers_create })}
                    </SummaryRow>
                  )}
                </div>
              )}
              {dialog && dialog.warnings.length > 0 && (
                <div className="rounded-md border border-amber-300/60 bg-amber-500/10 p-3">
                  <p className="text-xs font-medium text-amber-700 dark:text-amber-400 mb-1.5">{t('settings.configWarnings')}</p>
                  <IssueList issues={dialog.warnings} />
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            {dialog?.ok ? (
              <>
                <Button variant="outline" onClick={() => setDialog(null)} disabled={applying}>
                  {t('common.cancel')}
                </Button>
                <Button variant="destructive" onClick={confirmImport} disabled={applying || dialog.errors.length > 0}>
                  {applying ? t('settings.configImportApplying') : t('settings.configImportConfirm')}
                </Button>
              </>
            ) : (
              <Button variant="outline" onClick={() => setDialog(null)}>{t('common.close')}</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
