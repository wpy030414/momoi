import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../../lib/api'
import type { Agent, AgentImportPersonaAction, AgentImportPreview, AgentImportSkillAction } from '@/shared/types'
import { DEFAULT_AGENT_MODEL } from '@/shared/constants'
import { Input } from '../../ui/input'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../ui/dialog'
import { Pencil, Trash2, Plus, Upload, Copy, Shield, PackagePlus, AlertTriangle, Image as ImageIcon } from 'lucide-react'
import { useToast } from '../../ui/toast'
import { cn } from '../../../lib/utils'

interface AgentManagerProps {
  token: string
}

/** Persona conflict choices, in display order (overwrite / skip / create new) */
const PERSONA_ACTIONS: AgentImportPersonaAction[] = ['overwrite', 'skip', 'create']

const PERSONA_ACTION_LABEL: Record<AgentImportPersonaAction, string> = {
  overwrite: 'settings.agentImportActionOverwrite',
  skip: 'settings.agentImportActionSkip',
  create: 'settings.agentImportActionCreate',
}

/** A single agent row — card in view mode, expands into edit form in edit mode */
function AgentRow({
  agent, isNeutral, isEditing, onEdit, onCancel, onSave, onCopy, onDelete,
  formName, setFormName, formModel, setFormModel, formSystemPrompt, setFormSystemPrompt,
  formAvatar, setFormAvatar, avatarInputRef, handleAvatarChange, loading, t,
}: {
  agent?: Agent  // undefined when creating new
  isNeutral?: boolean
  isEditing: boolean
  onEdit?: () => void
  onCancel: () => void
  onSave: () => void
  onCopy?: (agent: Agent) => void
  onDelete?: (agent: Agent) => void
  formName: string; setFormName: (v: string) => void
  formModel: string; setFormModel: (v: string) => void
  formSystemPrompt: string; setFormSystemPrompt: (v: string) => void
  formAvatar: string; setFormAvatar: (v: string) => void
  avatarInputRef: React.RefObject<HTMLInputElement | null>
  handleAvatarChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  loading: boolean
  t: (key: string) => string
}) {
  // --- View mode ---
  if (!isEditing && agent) {
    if (isNeutral) {
      return (
        <div className="border rounded-md p-3 bg-muted/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <Shield className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="font-medium text-sm">{t('settings.agentNeutral')}</p>
                <p className="text-xs text-muted-foreground truncate">{agent.model}</p>
              </div>
            </div>
            <div className="flex gap-1 ml-2 flex-shrink-0">
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onEdit}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="flex items-center justify-between p-3 border rounded-md">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {agent.avatar ? (
            <img src={agent.avatar} alt={agent.name} className="h-8 w-8 rounded-full object-cover flex-shrink-0" />
          ) : (
            <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              <span className="text-xs font-medium text-primary">{agent.name.charAt(0).toUpperCase()}</span>
            </div>
          )}
          <div className="min-w-0">
            <p className="font-medium text-sm truncate">{agent.name}</p>
            <p className="text-xs text-muted-foreground truncate">{agent.model}</p>
          </div>
        </div>
        <div className="flex gap-1 ml-2 flex-shrink-0">
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => onCopy?.(agent)}>
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive" onClick={() => onDelete?.(agent)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    )
  }

  // --- Edit mode ---
  return (
    <div className="border rounded-md p-4 space-y-3">
      {/* Name */}
      {isNeutral ? (
        <div>
          <label className="text-sm font-medium">{t('settings.agentName')}</label>
          <Input
            value={formName}
            disabled
            className="mt-1 opacity-60"
          />
        </div>
      ) : (
        <div>
          <label className="text-sm font-medium">{t('settings.agentName')}</label>
          <Input
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder={t('settings.agentName')}
            className="mt-1"
          />
        </div>
      )}

      {/* Avatar — hidden for neutral agent */}
      {!isNeutral && (
        <div>
          <label className="text-sm font-medium">{t('settings.agentAvatar')}</label>
          <div className="flex items-center gap-3 mt-1">
            {formAvatar ? (
              <img src={formAvatar} alt="avatar" className="h-10 w-10 rounded-full object-cover" />
            ) : (
              <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                <Upload className="h-4 w-4 text-muted-foreground" />
              </div>
            )}
            <input ref={avatarInputRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
            <Button variant="outline" size="sm" onClick={() => avatarInputRef.current?.click()}>
              {t('settings.uploadAvatar')}
            </Button>
            {formAvatar && (
              <Button variant="ghost" size="sm" onClick={() => setFormAvatar('')}>
                {t('common.remove')}
              </Button>
            )}
          </div>
        </div>
      )}

      <div>
        <label className="text-sm font-medium">{t('settings.agentModel')}</label>
        <Input
          value={formModel}
          onChange={(e) => setFormModel(e.target.value)}
          placeholder={t('settings.modelPlaceholder')}
          className="mt-1"
        />
      </div>

      <div>
        <label className="text-sm font-medium">{t('settings.agentSystemPrompt')}</label>
        <textarea
          value={formSystemPrompt}
          onChange={(e) => setFormSystemPrompt(e.target.value)}
          rows={8}
          className="w-full mt-1 rounded-md border bg-background px-3 py-2 text-sm font-mono"
        />
      </div>

      <div className="flex gap-2">
        <Button onClick={onSave} disabled={loading || (!isNeutral && !agent && !formName.trim())}>
          {loading ? t('common.saving') : t('common.save')}
        </Button>
        <Button variant="outline" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}

export function AgentManager({ token }: AgentManagerProps) {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [agents, setAgents] = useState<Agent[]>([])
  const [neutralAgent, setNeutralAgent] = useState<Agent | null>(null)
  const [fetching, setFetching] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [loading, setLoading] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Agent | null>(null)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  // Form state
  const [formName, setFormName] = useState('')
  const [formModel, setFormModel] = useState('')
  const [formSystemPrompt, setFormSystemPrompt] = useState('')
  const [formAvatar, setFormAvatar] = useState('')

  // Import state
  const importInputRef = useRef<HTMLInputElement>(null)
  const [importing, setImporting] = useState(false)
  const [importPreview, setImportPreview] = useState<AgentImportPreview | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [committing, setCommitting] = useState(false)
  const [personaDrafts, setPersonaDrafts] = useState<Record<string, { name: string; model: string; action: AgentImportPersonaAction }>>({})
  const [skillDrafts, setSkillDrafts] = useState<Record<string, AgentImportSkillAction>>({})

  const fetchAgents = async () => {
    try {
      const res = await api.listAdminAgents(token)
      const all = res.agents
      setAgents(all.filter((a) => a.role !== 'neutral'))
      setNeutralAgent(all.find((a) => a.role === 'neutral') || null)
    } catch (err) {
      console.error('Failed to fetch agents:', err)
    } finally {
      setFetching(false)
    }
  }

  useEffect(() => {
    fetchAgents()
  }, [token])

  const handleSave = async () => {
    const editingAgent = editingId
      ? (neutralAgent?.id === editingId ? neutralAgent : agents.find((a) => a.id === editingId))
      : null
    if (!formName.trim() && !editingAgent) return
    setLoading(true)
    try {
      if (editingAgent) {
        const body: Record<string, string> = {}
        if (editingAgent.role === 'neutral') {
          body.model = formModel.trim()
          body.system_prompt = formSystemPrompt
        } else {
          body.name = formName.trim()
          body.model = formModel.trim()
          body.system_prompt = formSystemPrompt
          body.avatar = formAvatar
        }
        await api.updateAgent(token, editingAgent.id, body)
      } else {
        await api.createAgent(token, {
          name: formName.trim(),
          model: formModel.trim(),
          system_prompt: formSystemPrompt,
          avatar: formAvatar,
        })
      }
      await fetchAgents()
      resetForm()
      toast({ title: t('settings.toastAgentSaved'), variant: 'success' })
    } catch (err) {
      console.error('Failed to save agent:', err)
    }
    setLoading(false)
  }

  const handleCopy = async (agent: Agent) => {
    try {
      await api.createAgent(token, {
        name: `${agent.name} ${t('settings.agentCopy')}`,
        model: agent.model,
        system_prompt: agent.system_prompt,
        avatar: agent.avatar,
      })
      await fetchAgents()
      toast({ title: t('settings.toastAgentCopied'), variant: 'success' })
    } catch (err) {
      console.error('Failed to copy agent:', err)
    }
  }

  const handleDelete = async (agent: Agent) => {
    setDeleteTarget(agent)
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    try {
      await api.deleteAgent(token, deleteTarget.id)
      await fetchAgents()
      toast({ title: t('settings.toastAgentDeleted'), variant: 'success' })
    } catch (err) {
      console.error('Failed to delete agent:', err)
    }
    setDeleteTarget(null)
  }

  const startEdit = (agent: Agent) => {
    setEditingId(agent.id)
    setIsCreating(false)
    setFormName(agent.name)
    setFormModel(agent.model)
    setFormSystemPrompt(agent.system_prompt)
    setFormAvatar(agent.avatar || '')
  }

  const startCreate = () => {
    setEditingId(null)
    setIsCreating(true)
    setFormName('')
    setFormModel('')
    setFormSystemPrompt('')
    setFormAvatar('')
  }

  const resetForm = () => {
    setEditingId(null)
    setIsCreating(false)
    setFormName('')
    setFormModel('')
    setFormSystemPrompt('')
    setFormAvatar('')
  }

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setFormAvatar(reader.result as string)
    reader.readAsDataURL(file)
  }

  // --- Agent package import ---

  const closeImportDialog = () => {
    setImportPreview(null)
    setImportError(null)
    setPersonaDrafts({})
    setSkillDrafts({})
  }

  const updatePersonaDraft = (
    id: string,
    patch: Partial<{ name: string; model: string; action: AgentImportPersonaAction }>,
  ) => {
    setPersonaDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setImporting(true)
    setImportError(null)
    try {
      const preview = await api.importAgentPackage(token, file)
      // 空 model 会触发运行时回退（连系统提示词一起替换），预览输入框预填实例默认模型
      const defaultModel = agents[0]?.model || DEFAULT_AGENT_MODEL
      const personas: typeof personaDrafts = {}
      for (const candidate of preview.candidates) {
        personas[candidate.id] = {
          name: candidate.name,
          model: defaultModel,
          // Same-origin update defaults to overwrite; any other conflict defaults to skip.
          action: candidate.conflict ? (candidate.conflict.same_origin ? 'overwrite' : 'skip') : 'create',
        }
      }
      const skills: Record<string, AgentImportSkillAction> = {}
      for (const skill of preview.skills) {
        // Same-name skills default to skip; content-identical ones have nothing to install.
        skills[skill.name] = skill.conflict.installed ? 'skip' : 'install'
      }
      setPersonaDrafts(personas)
      setSkillDrafts(skills)
      setImportPreview(preview)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    }
    setImporting(false)
    if (importInputRef.current) importInputRef.current.value = ''
  }

  const handleImportCommit = async () => {
    if (!importPreview) return
    setCommitting(true)
    setImportError(null)
    try {
      const result = await api.commitAgentImport(token, importPreview.import_id, {
        personas: importPreview.candidates.map((candidate) => ({
          id: candidate.id,
          action: personaDrafts[candidate.id]?.action ?? 'skip',
          name: personaDrafts[candidate.id]?.name?.trim() || candidate.name,
          model: personaDrafts[candidate.id]?.model?.trim() ?? '',
        })),
        skills: importPreview.skills.map((skill) => ({
          name: skill.name,
          action: skillDrafts[skill.name] ?? 'skip',
        })),
      })
      await fetchAgents()
      const skillSummary = t('settings.agentImportToastSkills', {
        installed: result.skills.installed.length,
        overwritten: result.skills.overwritten.length,
        skipped: result.skills.skipped.length,
      })
      toast({
        title: t('settings.agentImportToast', {
          imported: result.imported.length,
          overwritten: result.overwritten.length,
          skipped: result.skipped.length,
        }),
        description: result.errors.length
          ? `${skillSummary} · ${t('settings.agentImportToastErrors', { n: result.errors.length })}`
          : skillSummary,
        variant: result.errors.length ? 'error' : 'success',
      })
      closeImportDialog()
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    }
    setCommitting(false)
  }

  const isEditing = !!(isCreating || editingId)

  return (
    <div className="space-y-2 pt-4">
      {fetching ? (
        <p className="text-muted-foreground text-center py-4">{t('common.loading')}</p>
      ) : (
        <>
          {/* Add / import buttons — inline at top, like SkillManager */}
          {!isEditing && (
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={startCreate}>
                <Plus className="mr-2 h-4 w-4" />
                {t('settings.agentAdd')}
              </Button>
              <input ref={importInputRef} type="file" accept=".zip" className="hidden" onChange={handleImportFile} />
              <Button variant="outline" size="sm" disabled={importing} onClick={() => importInputRef.current?.click()}>
                <PackagePlus className="mr-2 h-4 w-4" />
                {importing ? t('common.loading') : t('settings.agentImport')}
              </Button>
            </div>
          )}
          {importError && !importPreview && <p className="text-sm text-destructive">{importError}</p>}

          {/* Create form — inline at top, below the button */}
          {isCreating && (
            <AgentRow
              isEditing
              onCancel={resetForm}
              onSave={handleSave}
              formName={formName} setFormName={setFormName}
              formModel={formModel} setFormModel={setFormModel}
              formSystemPrompt={formSystemPrompt} setFormSystemPrompt={setFormSystemPrompt}
              formAvatar={formAvatar} setFormAvatar={setFormAvatar}
              avatarInputRef={avatarInputRef}
              handleAvatarChange={handleAvatarChange}
              loading={loading}
              t={t}
            />
          )}

          {!neutralAgent && agents.length === 0 && !isCreating ? (
            <p className="text-muted-foreground text-center py-4">{t('settings.agentNoAgents')}</p>
          ) : (
            <>
              {/* Neutral Agent — always at top */}
              {neutralAgent && (
                <AgentRow
                  agent={neutralAgent}
                  isNeutral
                  isEditing={editingId === neutralAgent.id}
                  onEdit={() => startEdit(neutralAgent)}
                  onCancel={resetForm}
                  onSave={handleSave}
                  formName={formName} setFormName={setFormName}
                  formModel={formModel} setFormModel={setFormModel}
                  formSystemPrompt={formSystemPrompt} setFormSystemPrompt={setFormSystemPrompt}
                  formAvatar={formAvatar} setFormAvatar={setFormAvatar}
                  avatarInputRef={avatarInputRef}
                  handleAvatarChange={handleAvatarChange}
                  loading={loading}
                  t={t}
                />
              )}

              {/* Regular agents */}
              {agents.map((agent) => (
                <AgentRow
                  key={agent.id}
                  agent={agent}
                  isEditing={editingId === agent.id}
                  onEdit={() => startEdit(agent)}
                  onCancel={resetForm}
                  onSave={handleSave}
                  onCopy={handleCopy}
                  onDelete={handleDelete}
                  formName={formName} setFormName={setFormName}
                  formModel={formModel} setFormModel={setFormModel}
                  formSystemPrompt={formSystemPrompt} setFormSystemPrompt={setFormSystemPrompt}
                  formAvatar={formAvatar} setFormAvatar={setFormAvatar}
                  avatarInputRef={avatarInputRef}
                  handleAvatarChange={handleAvatarChange}
                  loading={loading}
                  t={t}
                />
              ))}
            </>
          )}
        </>
      )}

      {/* Agent package import dialog */}
      <Dialog
        open={!!importPreview}
        onOpenChange={(open) => {
          if (!open && !committing) closeImportDialog()
        }}
      >
        <DialogContent className="max-w-2xl">
          {importPreview && (
            <>
              <DialogHeader>
                <DialogTitle>{t('settings.agentImportTitle')}</DialogTitle>
                <DialogDescription>
                  {t('settings.agentImportDesc', {
                    name: importPreview.package.name,
                    version: importPreview.package.version,
                  })}
                </DialogDescription>
              </DialogHeader>

              <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
                {/* Personas */}
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">{t('settings.agentImportPersonas')}</h3>
                  {importPreview.candidates.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('settings.agentImportNoPersonas')}</p>
                  ) : (
                    importPreview.candidates.map((candidate) => {
                      const draft = personaDrafts[candidate.id]
                      const conflict = candidate.conflict
                      return (
                        <div
                          key={candidate.id}
                          className={cn('space-y-2 rounded-md border p-3', conflict && 'border-amber-500/60 bg-amber-500/5')}
                        >
                          <div className="flex items-start gap-3">
                            {candidate.has_avatar ? (
                              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary/10">
                                <ImageIcon className="h-4 w-4 text-primary" />
                              </div>
                            ) : (
                              <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-muted">
                                <span className="text-xs font-medium text-muted-foreground">
                                  {candidate.name.charAt(0).toUpperCase()}
                                </span>
                              </div>
                            )}
                            <div className="min-w-0 flex-1 space-y-2">
                              <Input
                                value={draft?.name ?? candidate.name}
                                onChange={(e) => updatePersonaDraft(candidate.id, { name: e.target.value })}
                                placeholder={t('settings.agentName')}
                              />
                              <Input
                                value={draft?.model ?? ''}
                                onChange={(e) => updatePersonaDraft(candidate.id, { model: e.target.value })}
                                placeholder={t('settings.agentImportModelPlaceholder')}
                              />
                              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                                <span className="font-mono">{candidate.id}</span>
                                <span>{t('settings.agentImportLevelsCount', { n: candidate.level_count })}</span>
                                {candidate.level_count > 1 && (
                                  <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-500">
                                    <AlertTriangle className="h-3 w-3" />
                                    {t('settings.agentImportLevels', { n: candidate.level_count - 1 })}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>

                          {conflict && (
                            <div className="flex flex-wrap items-center gap-2 border-t pt-2">
                              <span className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
                                <AlertTriangle className="h-3 w-3" />
                                {t('settings.agentImportConflict', { name: conflict.agent_name })}
                                {conflict.same_origin && ` · ${t('settings.agentImportSameOrigin')}`}
                              </span>
                              <div className="ml-auto flex items-center gap-1">
                                {PERSONA_ACTIONS.map((action) => (
                                  <Button
                                    key={action}
                                    type="button"
                                    size="sm"
                                    variant={draft?.action === action ? 'default' : 'outline'}
                                    className="h-7 px-2 text-xs"
                                    onClick={() => updatePersonaDraft(candidate.id, { action })}
                                  >
                                    {t(PERSONA_ACTION_LABEL[action])}
                                  </Button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })
                  )}
                </section>

                {/* Skills */}
                <section className="space-y-2">
                  <h3 className="text-sm font-medium">{t('settings.agentImportSkills')}</h3>
                  {importPreview.skills.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t('settings.agentImportNoSkills')}</p>
                  ) : (
                    importPreview.skills.map((skill) => {
                      const installed = skill.conflict.installed
                      const identical = installed && skill.conflict.content_identical
                      return (
                        <div
                          key={skill.name}
                          className={cn('rounded-md border p-3', installed && 'border-amber-500/60 bg-amber-500/5')}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{skill.name}</p>
                              {skill.description && (
                                <p className="text-xs text-muted-foreground">{skill.description}</p>
                              )}
                              {installed && (
                                <p
                                  className={cn(
                                    'mt-1 text-xs',
                                    identical ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-500',
                                  )}
                                >
                                  {identical
                                    ? t('settings.agentImportSkillIdentical')
                                    : t('settings.agentImportSkillDifferent')}
                                </p>
                              )}
                            </div>
                            {installed && !identical && (
                              <label className="flex flex-shrink-0 cursor-pointer items-center gap-2 text-xs">
                                <input
                                  type="checkbox"
                                  className="h-4 w-4 accent-primary"
                                  checked={skillDrafts[skill.name] === 'install'}
                                  onChange={(e) =>
                                    setSkillDrafts((prev) => ({
                                      ...prev,
                                      [skill.name]: e.target.checked ? 'install' : 'skip',
                                    }))
                                  }
                                />
                                {t('settings.agentImportSkillOverwrite')}
                              </label>
                            )}
                          </div>
                        </div>
                      )
                    })
                  )}
                </section>

                {importPreview.warnings.length > 0 && (
                  <div className="space-y-1 rounded-md border border-amber-500/60 bg-amber-500/5 p-3">
                    <p className="text-xs font-medium text-amber-600 dark:text-amber-500">
                      {t('settings.agentImportWarnings')}
                    </p>
                    <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                      {importPreview.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {importPreview.errors.length > 0 && (
                  <div className="space-y-1 rounded-md border border-destructive/50 bg-destructive/5 p-3">
                    <p className="text-xs font-medium text-destructive">{t('settings.agentImportErrors')}</p>
                    <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                      {importPreview.errors.map((error, index) => (
                        <li key={index}>{error}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {importError && <p className="text-sm text-destructive">{importError}</p>}
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={closeImportDialog} disabled={committing}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={handleImportCommit} disabled={committing}>
                  {committing ? t('common.saving') : t('settings.agentImportCommit')}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.agentDelete')}</DialogTitle>
            <DialogDescription>
              {t('settings.agentDeleteConfirm')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              {t('settings.agentDelete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}