import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../../lib/api'
import type { Agent } from '@momoi/shared/types'
import { Input } from '../../ui/input'
import { Loading } from '../../ui/spinner'
import { Button } from '../../ui/button'
import { Switch } from '../../ui/switch'
import { Slider } from '../../ui/slider'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../ui/dialog'
import { Pencil, Trash2, Plus, Upload, Copy, Shield, Mic, Volume2 } from 'lucide-react'
import { useToast } from '../../ui/toast'

export interface AgentManagerHandle {
  triggerCreate: () => void
}

// ---- Voice sub-form state ----
interface VoiceFormState {
  enabled: boolean
  sampleUrl: string
  speakerId: string
  speed: number
  pitch: number
  emotionStrength: number
}

const DEFAULT_VOICE_FORM: VoiceFormState = {
  enabled: false,
  sampleUrl: '',
  speakerId: '',
  speed: 1.0,
  pitch: 0,
  emotionStrength: 0.8,
}

function voiceFormFromAgent(agent: Agent): VoiceFormState {
  try {
    const vs = JSON.parse((agent as any).voice_settings || '{}')
    return {
      enabled: (agent as any).voice_enabled ?? false,
      sampleUrl: (agent as any).voice_sample_url || '',
      speakerId: vs.speakerId || '',
      speed: vs.speed ?? 1.0,
      pitch: vs.pitch ?? 0,
      emotionStrength: vs.emotionStrength ?? 0.8,
    }
  } catch {
    return DEFAULT_VOICE_FORM
  }
}

/** A single agent row — card in view mode, expands into edit form in edit mode */
function AgentRow({
  agent, isNeutral, isEditing, onEdit, onCancel, onSave, onCopy, onDelete,
  formName, setFormName, formModel, setFormModel, formSystemPrompt, setFormSystemPrompt,
  formAvatar, setFormAvatar, avatarInputRef, handleAvatarChange,
  voice, onVoiceChange, voiceAudioRef, handleVoiceUpload, handleVoiceClone, handleVoiceDelete,
  voiceCloning, loading, t,
}: {
  agent?: Agent
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
  // Voice
  voice: VoiceFormState
  onVoiceChange: (partial: Partial<VoiceFormState>) => void
  voiceAudioRef: React.RefObject<HTMLInputElement | null>
  handleVoiceUpload: (e: React.ChangeEvent<HTMLInputElement>) => void
  handleVoiceClone: () => void
  handleVoiceDelete: () => void
  voiceCloning: boolean
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
    <div className="border rounded-md p-4 space-y-4">
      {/* Name */}
      {isNeutral ? (
        <div>
          <label className="text-sm font-medium">{t('settings.agentName')}</label>
          <Input value={formName} disabled className="mt-1 opacity-60" />
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
              <img src={formAvatar} alt={t('settings.altAvatarPreview')} className="h-10 w-10 rounded-full object-cover" />
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

      {/* ═══════ Voice / TTS — hidden for neutral agent ═══════ */}
      {!isNeutral && (
        <div className="border-t pt-4 space-y-4">
          {/* Header with switch */}
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold">{t('voice.label')}</span>
            <Switch
              checked={voice.enabled}
              onCheckedChange={(checked) => onVoiceChange({ enabled: checked })}
            />
          </div>
          
          {voice.enabled && (
            <>
              {/* Audio sample upload */}
              <div>
                <label className="text-sm font-medium">{t('voice.uploadSample')}</label>
                <p className="text-xs text-muted-foreground mt-0.5 mb-2">{t('voice.uploadSampleHint')}</p>
                <div className="flex items-center gap-2">
                  <input
                    ref={voiceAudioRef}
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={handleVoiceUpload}
                  />
                  <Button variant="outline" size="sm" onClick={() => voiceAudioRef.current?.click()}>
                    <Upload className="h-3.5 w-3.5 mr-1.5" />
                    {voice.sampleUrl ? t('voice.changeSample') : t('voice.uploadSample')}
                  </Button>
                  {voice.sampleUrl && (
                    <span className="text-xs text-green-600 font-medium">{t('voice.sampleUploaded')}</span>
                  )}
                </div>
              </div>

              {/* Clone button */}
              {voice.sampleUrl && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleVoiceClone}
                    disabled={voiceCloning}
                  >
                    <Mic className="h-3.5 w-3.5 mr-1.5" />
                    {voiceCloning
                      ? t('voice.cloning')
                      : voice.speakerId
                        ? t('voice.reclone')
                        : t('voice.clone')}
                  </Button>
                  {voice.speakerId && !voiceCloning && (
                    <span className="text-xs text-green-600 font-medium">{t('voice.cloned')}</span>
                  )}
                </div>
              )}

              {/* Parameters */}
              <div className="space-y-3">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span>{t('voice.speed')}</span>
                    <span className="text-muted-foreground tabular-nums">{voice.speed.toFixed(1)}</span>
                  </div>
                  <Slider
                    min={0.5}
                    max={2.0}
                    step={0.1}
                    value={voice.speed}
                    onValueChange={(v) => onVoiceChange({ speed: v })}
                  />
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span>{t('voice.pitch')}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {voice.pitch > 0 ? '+' : ''}{voice.pitch}
                    </span>
                  </div>
                  <Slider
                    min={-12}
                    max={12}
                    step={1}
                    value={voice.pitch}
                    onValueChange={(v) => onVoiceChange({ pitch: v })}
                  />
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span>{t('voice.emotionStrength')}</span>
                    <span className="text-muted-foreground tabular-nums">{voice.emotionStrength.toFixed(1)}</span>
                  </div>
                  <Slider
                    min={0}
                    max={1}
                    step={0.1}
                    value={voice.emotionStrength}
                    onValueChange={(v) => onVoiceChange({ emotionStrength: v })}
                  />
                </div>
              </div>

              {/* Delete voice */}
              {voice.sampleUrl && (
                <div className="pt-1">
                  <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={handleVoiceDelete}>
                    <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                    {t('voice.deleteVoice')}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Save / Cancel */}
      <div className="flex gap-2 pt-1">
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

export const AgentManager = forwardRef<AgentManagerHandle>(function AgentManager(_props, ref) {
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
  const voiceAudioRef = useRef<HTMLInputElement>(null)
  const [voiceCloning, setVoiceCloning] = useState(false)

  // Form state
  const [formName, setFormName] = useState('')
  const [formModel, setFormModel] = useState('')
  const [formSystemPrompt, setFormSystemPrompt] = useState('')
  const [formAvatar, setFormAvatar] = useState('')
  const [voice, setVoice] = useState<VoiceFormState>(DEFAULT_VOICE_FORM)

  const fetchAgents = async () => {
    try {
      const res = await api.listAdminAgents()
      const all = res.agents
      setAgents(all.filter((a) => a.role !== 'neutral'))
      setNeutralAgent(all.find((a) => a.role === 'neutral') || null)
    } catch (err) {
      console.error('Failed to fetch agents:', err)
    } finally {
      setFetching(false)
    }
  }

  useEffect(() => { fetchAgents() }, [])

  // ── Voice helpers ──

  const editingAgent = editingId
    ? (neutralAgent?.id === editingId ? neutralAgent : agents.find((a) => a.id === editingId))
    : null

  const handleVoiceUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !editingAgent) return
    const formData = new FormData()
    formData.append('file', file)
    try {
      const res = await fetch(`/api/admin/agents/${editingAgent.id}/voice/upload`, { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Upload failed' }))
        toast({ title: err.error || 'Voice sample upload failed', variant: 'error' })
        return
      }
      const data = await res.json()
      setVoice((prev) => ({ ...prev, sampleUrl: data.sample_url }))
      toast({ title: t('voice.sampleUploaded'), variant: 'success' })
    } catch (err) {
      console.error('Voice sample upload failed:', err)
      toast({ title: String(err), variant: 'error' })
    }
  }

  const handleVoiceClone = async () => {
    if (!editingAgent) return
    setVoiceCloning(true)
    try {
      const res = await fetch(`/api/admin/agents/${editingAgent.id}/voice/clone`, { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Clone failed' }))
        toast({ title: err.error || 'Voice clone failed', variant: 'error' })
        setVoiceCloning(false)
        return
      }
      const data = await res.json()
      setVoice((prev) => ({ ...prev, speakerId: data.speaker_id }))
      toast({ title: t('voice.cloned'), variant: 'success' })
    } catch (err) {
      console.error('Voice clone failed:', err)
      toast({ title: String(err), variant: 'error' })
    }
    setVoiceCloning(false)
  }

  const handleVoiceDelete = async () => {
    if (!editingAgent) return
    try {
      await fetch(`/api/admin/agents/${editingAgent.id}/voice`, { method: 'DELETE' })
      setVoice(DEFAULT_VOICE_FORM)
      toast({ title: t('voice.deleteVoice'), variant: 'success' })
    } catch (err) {
      console.error('Voice delete failed:', err)
    }
  }

  // ── Save ──

  const handleSave = async () => {
    if (!formName.trim() && !editingAgent) return
    setLoading(true)
    try {
      if (editingAgent) {
        const body: Record<string, any> = {}
        if (editingAgent.role === 'neutral') {
          body.model = formModel.trim()
          body.system_prompt = formSystemPrompt
        } else {
          body.name = formName.trim()
          body.model = formModel.trim()
          body.system_prompt = formSystemPrompt
          body.avatar = formAvatar
          body.voice_enabled = voice.enabled
          body.voice_sample_url = voice.sampleUrl
          body.voice_settings = JSON.stringify({
            speed: voice.speed,
            pitch: voice.pitch,
            emotionStrength: voice.emotionStrength,
            speakerId: voice.speakerId,
            provider: 'gpt-sovits',
          })
        }
        await api.updateAgent(editingAgent.id, body)
      } else {
        await api.createAgent({
          name: formName.trim(),
          model: formModel.trim(),
          system_prompt: formSystemPrompt,
          avatar: formAvatar,
        } as any)
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
      await api.createAgent({
        name: `${agent.name}${t('settings.agentCopySuffix')}`,
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
      await api.deleteAgent(deleteTarget.id)
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
    setVoice(voiceFormFromAgent(agent))
  }

  const startCreate = () => {
    setEditingId(null)
    setIsCreating(true)
    setFormName('')
    setFormModel('')
    setFormSystemPrompt('')
    setFormAvatar('')
    setVoice(DEFAULT_VOICE_FORM)
  }

  const resetForm = () => {
    setEditingId(null)
    setIsCreating(false)
    setFormName('')
    setFormModel('')
    setFormSystemPrompt('')
    setFormAvatar('')
    setVoice(DEFAULT_VOICE_FORM)
  }

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setFormAvatar(reader.result as string)
    reader.readAsDataURL(file)
  }

  const isEditing = !!(isCreating || editingId)

  useImperativeHandle(ref, () => ({ triggerCreate: startCreate }))

  return (
    <div className="space-y-2 pt-4">
      {fetching ? (
        <Loading className="py-8" />
      ) : (
        <>
          {/* Create form — inline at top */}
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
              voice={voice}
              onVoiceChange={(p) => setVoice((prev) => ({ ...prev, ...p }))}
              voiceAudioRef={voiceAudioRef}
              handleVoiceUpload={handleVoiceUpload}
              handleVoiceClone={handleVoiceClone}
              handleVoiceDelete={handleVoiceDelete}
              voiceCloning={voiceCloning}
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
                  voice={voice}
                  onVoiceChange={(p) => setVoice((prev) => ({ ...prev, ...p }))}
                  voiceAudioRef={voiceAudioRef}
                  handleVoiceUpload={handleVoiceUpload}
                  handleVoiceClone={handleVoiceClone}
                  handleVoiceDelete={handleVoiceDelete}
                  voiceCloning={voiceCloning}
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
                  voice={voice}
                  onVoiceChange={(p) => setVoice((prev) => ({ ...prev, ...p }))}
                  voiceAudioRef={voiceAudioRef}
                  handleVoiceUpload={handleVoiceUpload}
                  handleVoiceClone={handleVoiceClone}
                  handleVoiceDelete={handleVoiceDelete}
                  voiceCloning={voiceCloning}
                  loading={loading}
                  t={t}
                />
              ))}
            </>
          )}
        </>
      )}

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
})