// NewWorkflowDialog —— 侧边栏「新工作流」统一入口：先选**模式**，再填内容。
//   · 群组会话：至少 2 个 Agent（与既有群聊一致，走草稿态，首条消息时才落库）
//   · 世界模拟：至少 1 个 Agent + 法则（可选）——同步落库即就绪。
//     世界不需要描述：Agent 的人设本身就是身份，法则就是约束，
//     额外描述反而稀释法则。
//
// 选择跨模式共享：选完 3 个 Agent 再切模式仍保留，只是阈值变了。
// 提交失败保持对话框打开并保留已输入的内容 —— 因一次瞬时 500 丢掉
// 用户刚写的内容是不可接受的。

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Loading } from '../ui/spinner'
import { Folder } from 'lucide-react'
import { AgentPickerList, type AgentBrief } from './AgentPickerList'
import { errT } from '../../i18n'
import type { Workspace } from '@momoi/shared/types'

export type WorkflowMode = 'group' | 'world'

const GROUP_MIN_AGENTS = 2
const WORLD_MIN_AGENTS = 1
const LAWS_LIMIT = 2000

export interface WorldDraft {
  laws: string
}

interface NewWorkflowDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agents: AgentBrief[]
  agentsLoading: boolean
  workspaces: Workspace[]
  /** workspaceId：目标工作区（创建时锁定，之后不可移动）；null = 未分组 */
  onConfirmGroup: (agentIds: string[], workspaceId: string | null) => Promise<void>
  onConfirmWorld: (agentIds: string[], draft: WorldDraft, workspaceId: string | null) => Promise<void>
}

export function NewWorkflowDialog({
  open,
  onOpenChange,
  agents,
  agentsLoading,
  workspaces,
  onConfirmGroup,
  onConfirmWorld,
}: NewWorkflowDialogProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<WorkflowMode>('group')
  const [selected, setSelected] = useState<string[]>([])
  const [laws, setLaws] = useState('')
  const [wsId, setWsId] = useState<string>('')  // '' = 未分组
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const reset = () => {
    setMode('group')
    setSelected([])
    setLaws('')
    setWsId('')
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
  const canSubmit = enoughAgents && !submitting

  const hint = !enoughAgents
    ? t(mode === 'group' ? 'workflow.groupHint' : 'workflow.worldHint')
    : ''

  const submit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError('')
    try {
      const workspaceId = wsId || null
      if (mode === 'group') {
        await onConfirmGroup(selected, workspaceId)
      } else {
        await onConfirmWorld(selected, { laws: laws.trim() }, workspaceId)
      }
      reset()
      onOpenChange(false)
    } catch (err) {
      setError(errT(err) || t('workflow.failed'))
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
            {/* 目标工作区（创建时锁定，之后不可移动） */}
            {workspaces.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium flex items-center gap-1.5">
                  <Folder className="h-3.5 w-3.5" />
                  {t('sidebar.workspace')}
                </div>
                <Select value={wsId || 'ungrouped'} onValueChange={(v) => setWsId(v === 'ungrouped' ? '' : v)} disabled={submitting}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ungrouped">{t('sidebar.ungrouped')}</SelectItem>
                    {workspaces.map((ws) => (
                      <SelectItem key={ws.id} value={ws.id}>{ws.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <div className="text-sm font-medium">{t('workflow.selectAgents')}</div>
              <AgentPickerList agents={agents} selected={selected} onToggle={toggle} disabled={submitting} />
            </div>

            {mode === 'world' && (
              <div className="space-y-2">
                <div className="text-sm font-medium">{t('workflow.worldLaws')}</div>
                <Textarea
                  value={laws}
                  onChange={(e) => setLaws(e.target.value)}
                  rows={4}
                  maxLength={LAWS_LIMIT}
                  disabled={submitting}
                  placeholder={t('workflow.lawsPlaceholder')}
                />
                <p className="text-xs text-muted-foreground leading-relaxed">{t('workflow.worldLawsHint')}</p>
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