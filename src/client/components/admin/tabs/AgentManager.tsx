import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../../lib/api'
import type { Agent } from '@/shared/types'
import { Input } from '../../ui/input'
import { Button } from '../../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '../../ui/dialog'
import { Pencil, Trash2, Plus, Upload, Copy, Shield, Mic, Volume2 } from 'lucide-react'
import { useToast } from '../../ui/toast'

export interface AgentManagerHandle {
  triggerCreate: () => void
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

  // Form state
  const [formName, setFormName] = useState('')
  const [formModel, setFormModel] = useState('')
  const [formSystemPrompt, setFormSystemPrompt] = useState('')
  const [formAvatar, setFormAvatar] = useState('')
  const [formVoiceEnabled, setFormVoiceEnabled] = useState(false)
  const [formVoiceSpeed, setFormVoiceSpeed] = useState(1.0)
  const [formVoicePitch, setFormVoicePitch] = useState(0)
  const [formVoiceEmotion, setFormVoiceEmotion] = useState(0.8)
  const [voiceSampleUrl, setVoiceSampleUrl] = useState('')
  const [voiceSpeakerId, setVoiceSpeakerId] = useState('')
  const [voiceCloning, setVoiceCloning] = useState(false)
  const voiceAudioRef = useRef<HTMLInputElement>(null)
  const [testText, setTestText] = useState('')
  const [testPlaying, setTestPlaying] = useState(false)
  const testAudioRef = useRef<HTMLAudioElement | null>(null)

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

  useEffect(() => {
    fetchAgents()
  }, [])

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
          ;(body as any).voice_enabled = formVoiceEnabled
          ;(body as any).voice_sample_url = voiceSampleUrl
          ;(body as any).voice_settings = JSON.stringify({
            speed: formVoiceSpeed,
            pitch: formVoicePitch,
            emotionStrength: formVoiceEmotion,
            speakerId: voiceSpeakerId,
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
    setFormVoiceEnabled((agent as any).voice_enabled ?? false)
    setVoiceSampleUrl((agent as any).voice_sample_url || '')
    try {
      const vs = JSON.parse((agent as any).voice_settings || '{}')
      setFormVoiceSpeed(vs.speed ?? 1.0)
      setFormVoicePitch(vs.pitch ?? 0)
      setFormVoiceEmotion(vs.emotionStrength ?? 0.8)
      setVoiceSpeakerId(vs.speakerId || '')
    } catch {
      setFormVoiceSpeed(1.0)
      setFormVoicePitch(0)
      setFormVoiceEmotion(0.8)
      setVoiceSpeakerId('')
    }
  }

  const startCreate = () => {
    setEditingId(null)
    setIsCreating(true)
    setFormName('')
    setFormModel('')
    setFormSystemPrompt('')
    setFormAvatar('')
    setFormVoiceEnabled(false)
    setFormVoiceSpeed(1.0)
    setFormVoicePitch(0)
    setFormVoiceEmotion(0.8)
    setVoiceSampleUrl('')
    setVoiceSpeakerId('')
  }

  const resetForm = () => {
    setEditingId(null)
    setIsCreating(false)
    setFormName('')
    setFormModel('')
    setFormSystemPrompt('')
    setFormAvatar('')
    setFormVoiceEnabled(false)
    setFormVoiceSpeed(1.0)
    setFormVoicePitch(0)
    setFormVoiceEmotion(0.8)
    setVoiceSampleUrl('')
    setVoiceSpeakerId('')
  }

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setFormAvatar(reader.result as string)
    reader.readAsDataURL(file)
  }

  const handleVoiceSampleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const editingAgent = editingId ? (neutralAgent?.id === editingId ? neutralAgent : agents.find((a) => a.id === editingId)) : null
    if (!editingAgent) return

    const formData = new FormData()
    formData.append('file', file)
    try {
      const res = await fetch(`/api/admin/agents/${editingAgent.id}/voice/upload`, {
        method: 'POST',
        body: formData,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Upload failed' }))
        toast({ title: err.error || 'Voice sample upload failed', variant: 'error' })
        return
      }
      const data = await res.json()
      setVoiceSampleUrl(data.sample_url)
      toast({ title: 'Voice sample uploaded', variant: 'success' })
    } catch (err) {
      console.error('Voice sample upload failed:', err)
      toast({ title: 'Voice sample upload failed', variant: 'error' })
    }
  }

  const handleVoiceClone = async () => {
    const editingAgent = editingId ? (neutralAgent?.id === editingId ? neutralAgent : agents.find((a) => a.id === editingId)) : null
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
      setVoiceSpeakerId(data.speaker_id)
      toast({ title: 'Voice cloned successfully!', variant: 'success' })
    } catch (err) {
      console.error('Voice clone failed:', err)
      toast({ title: 'Voice clone failed', variant: 'error' })
    }
    setVoiceCloning(false)
  }

  const handleVoiceDelete = async () => {
    const editingAgent = editingId ? (neutralAgent?.id === editingId ? neutralAgent : agents.find((a) => a.id === editingId)) : null
    if (!editingAgent) return
    try {
      await fetch(`/api/admin/agents/${editingAgent.id}/voice`, { method: 'DELETE' })
      setVoiceSampleUrl('')
      setVoiceSpeakerId('')
      setFormVoiceEnabled(false)
      toast({ title: 'Voice data deleted', variant: 'success' })
    } catch (err) {
      console.error('Voice delete failed:', err)
    }
  }

  const handleVoiceTest = async () => {
    const editingAgent = editingId ? (neutralAgent?.id === editingId ? neutralAgent : agents.find((a) => a.id === editingId)) : null
    if (!editingAgent || !testText.trim()) return
    setTestPlaying(true)
    try {
      // First ensure voice settings are saved
      const body: Record<string, any> = {
        voice_settings: JSON.stringify({
          speed: formVoiceSpeed,
          pitch: formVoicePitch,
          emotionStrength: formVoiceEmotion,
          speakerId: voiceSpeakerId,
          provider: 'gpt-sovits',
        }),
        voice_sample_url: voiceSampleUrl,
        voice_enabled: true,
      }
      await api.updateAgent(editingAgent.id, body)

      // Create a temporary message ID for testing
      const testMsgId = Date.now()
      const res = await fetch('/api/voice/segments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: editingAgent.id, message_id: testMsgId }),
      })
      // We need a different approach — just fetch the TTS directly isn't exposed as an API.
      // For now, show a toast that test requires the agent to respond in chat
      toast({ title: 'Voice preview: have the agent respond in chat to hear it!', variant: 'success' })
    } catch (err) {
      console.error('Voice test failed:', err)
    }
    setTestPlaying(false)
  }

  const isEditing = !!(isCreating || editingId)

  useImperativeHandle(ref, () => ({ triggerCreate: startCreate }))

  return (
    <div className="space-y-2 pt-4">
      {fetching ? (
        <p className="text-muted-foreground text-center py-4">{t('common.loading')}</p>
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

              {/* Voice Configuration — shown when editing/creating a non-neutral agent */}
      {isEditing && editingId && (
        <div className="border rounded-md p-4 space-y-3 mt-4">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Volume2 className="h-4 w-4" />
            Voice / TTS
          </h3>

          {/* Voice enabled toggle */}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={formVoiceEnabled}
              onChange={(e) => setFormVoiceEnabled(e.target.checked)}
              className="rounded"
            />
            Enable voice synthesis
          </label>

          {formVoiceEnabled && (
            <>
              {/* Audio sample upload */}
              <div>
                <label className="text-sm font-medium">Reference audio sample</label>
                <p className="text-xs text-muted-foreground mb-1">Upload 5-60s clear speech (WAV/MP3)</p>
                <div className="flex items-center gap-2">
                  <input
                    ref={voiceAudioRef}
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={handleVoiceSampleUpload}
                  />
                  <Button variant="outline" size="sm" onClick={() => voiceAudioRef.current?.click()}>
                    <Upload className="h-3.5 w-3.5 mr-1" />
                    {voiceSampleUrl ? 'Change sample' : 'Upload sample'}
                  </Button>
                  {voiceSampleUrl && (
                    <span className="text-xs text-green-600">✓ Uploaded</span>
                  )}
                </div>
              </div>

              {/* Clone button */}
              {voiceSampleUrl && (
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleVoiceClone}
                    disabled={voiceCloning}
                  >
                    <Mic className="h-3.5 w-3.5 mr-1" />
                    {voiceCloning ? 'Cloning...' : voiceSpeakerId ? 'Re-clone voice' : 'Clone voice'}
                  </Button>
                  {voiceSpeakerId && (
                    <span className="ml-2 text-xs text-green-600">✓ Cloned (speaker: {voiceSpeakerId})</span>
                  )}
                </div>
              )}

              {/* Voice parameters */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs">Speed: {formVoiceSpeed.toFixed(1)}</label>
                  <input
                    type="range"
                    min="0.5"
                    max="2.0"
                    step="0.1"
                    value={formVoiceSpeed}
                    onChange={(e) => setFormVoiceSpeed(parseFloat(e.target.value))}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="text-xs">Pitch: {formVoicePitch > 0 ? '+' : ''}{formVoicePitch}</label>
                  <input
                    type="range"
                    min="-12"
                    max="12"
                    step="1"
                    value={formVoicePitch}
                    onChange={(e) => setFormVoicePitch(parseInt(e.target.value))}
                    className="w-full"
                  />
                </div>
                <div className="col-span-2">
                  <label className="text-xs">Emotion strength: {formVoiceEmotion.toFixed(1)}</label>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.1"
                    value={formVoiceEmotion}
                    onChange={(e) => setFormVoiceEmotion(parseFloat(e.target.value))}
                    className="w-full"
                  />
                </div>
              </div>

              {/* Delete voice */}
              {voiceSampleUrl && (
                <div>
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={handleVoiceDelete}>
                    <Trash2 className="h-3.5 w-3.5 mr-1" />
                    Delete voice data
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
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
