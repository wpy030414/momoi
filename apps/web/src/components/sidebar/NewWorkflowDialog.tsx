// ============================================================
// NewWorkflowDialog — 侧边栏「新工作流」的统一入口
// ============================================================
// 取代 App.tsx 里原本内联的「新建群聊」弹窗：先选**模式**，再选 Agent。
//   · 群组会话：至少 2 个 Agent（与既有行为一致，走草稿态，首条消息时才落库）
//   · 世界模拟：至少 1 个 Agent + 必填的世界提示词（创生时立即落库并生成地形）
//
// 选择跨模式共享：选完 3 个 Agent 再切模式仍保留，只是阈值变了 —— 便宜且符合直觉。

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { Loading } from '../ui/spinner'
import { AgentPickerList } from './AgentPickerList'

export type WorkflowMode = 'group' | 'world'

const GROUP_MIN_AGENTS = 2
const WORLD_MIN_AGENTS = 1
const PROMPT_SOFT_LIMIT = 500

interface NewWorkflowDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agents: Array<{ id: string; name: string; avatar: string }>
  agentsLoading: boolean
  onConfirmGroup: (agentIds: string[]) => Promise<void>
  onConfirmWorld: (agentIds: string[], prompt: string) => Promise<void>
}

export function NewWorkflowDialog({
  open,
  onOpenChange,
  agents,
  agentsLoading,
  onConfirmGroup,
  onConfirmWorld,
}: NewWorkflowDialogProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<WorkflowMode>('group')
  const [selected, setSelected] = useState<string[]>([])
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const reset = () => {
    setMode('group')
    setSelected([])
    setPrompt('')
    setSubmitting(false)
    setError('')
  }

  const close = (next: boolean) => {
    if (submitting) return
    if (!next) reset()
    onOpenChange(next)
  }

  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const minAgents = mode === 'group' ? GROUP_MIN_AGENTS : WORLD_MIN_AGENTS
  const enoughAgents = selected.length >= minAgents
  const promptOk = mode === 'group' || prompt.trim().length > 0
  const canSubmit = enoughAgents && promptOk && !submitting

  const hint = !enoughAgents
    ? t(mode === 'group' ? 'workflow.groupHint' : 'workflow.worldHint')
    : !promptOk
      ? t('workflow.worldPromptRequired')
      : ''

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError('')
    try {
      if (mode === 'group') await onConfirmGroup(selected)
      else await onConfirmWorld(selected, prompt.trim())
      reset()
      onOpenChange(false)
    } catch (err) {
      // 保持对话框打开、保留已输入的提示词 —— 因一次瞬时 500 而丢掉用户刚写的
      // 三百字世界描述是不可接受的
      setError((err as Error).message || t('workflow.failed'))
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('workflow.title')}</DialogTitle>
        </DialogHeader>

        {/* 模式选择 */}
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
          {(['group', 'world'] as WorkflowMode[]).map((m) => (
            <button
              key={m}
              type="button"
              disabled={submitting}
              onClick={() => setMode(m)}
              className={`rounded-md py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                mode === m ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(m === 'group' ? 'workflow.modeGroup' : 'workflow.modeWorld')}
            </button>
          ))}
        </div>

        {agentsLoading ? (
          <Loading className="py-8" />
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="text-sm font-medium">{t('workflow.selectAgents')}</div>
              <AgentPickerList agents={agents} selected={selected} onToggle={toggle} disabled={submitting} />
            </div>

            {mode === 'world' && (
              <div className="space-y-2">
                <div className="text-sm font-medium">{t('workflow.worldPrompt')}</div>
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={5}
                  maxLength={PROMPT_SOFT_LIMIT}
                  disabled={submitting}
                  placeholder={t('workflow.worldPromptPlaceholder')}
                />
                <p className="text-xs text-muted-foreground leading-relaxed">{t('workflow.worldPromptHint')}</p>
              </div>
            )}
          </div>
        )}

        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" className="flex-1" onClick={() => close(false)} disabled={submitting}>
            {t('common.cancel')}
          </Button>
          <Button className="flex-1" disabled={!canSubmit} onClick={submit}>
            {submitting
              ? t(mode === 'world' ? 'workflow.creating' : 'common.loading')
              : t(mode === 'group' ? 'common.confirm' : 'workflow.createWorld')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
