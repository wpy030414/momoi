// 世界法则编辑器 —— 世界唯一的可变项。
//
// ⚠️ 地形规则的只读展示不只是 UI 上的「不给改」：真正的保证在服务端
//    （PATCH /api/worlds/:id 见到 terrain_prompt 会直接 400）。这里把它摆在
//    用户眼前，是为了让「哪一半可以改、哪一半不能」在创建时就可见。

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { Lock } from 'lucide-react'

interface LawsEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  terrainPrompt: string
  laws: string
  saving: boolean
  onSave: (laws: string) => Promise<void>
}

export function LawsEditor({ open, onOpenChange, terrainPrompt, laws, saving, onSave }: LawsEditorProps) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(laws)

  // 每次打开都对齐到服务端的当前值：避免上一次未保存的草稿在重开后残留
  useEffect(() => {
    if (open) setDraft(laws)
  }, [open, laws])

  const dirty = draft !== laws

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('world.laws')}</DialogTitle>
          <DialogDescription>{t('world.lawsHint')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* 地形规则：只读 */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Lock className="h-3 w-3" />
              {t('world.terrainRules')}
              <span className="text-muted-foreground/70">· {t('world.terrainImmutable')}</span>
            </div>
            <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm whitespace-pre-wrap max-h-32 overflow-y-auto">
              {terrainPrompt || '—'}
            </div>
          </div>

          {/* 法则：可编辑 */}
          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted-foreground">{t('world.laws')}</div>
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={5}
              placeholder={t('world.lawsPlaceholder')}
              disabled={saving}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={!dirty || saving}
            onClick={async () => {
              await onSave(draft)
            }}
          >
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
