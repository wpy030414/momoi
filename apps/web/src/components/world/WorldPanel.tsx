// ============================================================
// WorldPanel — 世界模拟的主视图（取代该会话的消息气泡区）
// ============================================================
// 挂在 App.tsx 主区三元链上，与 ChatPanel 同级而非其分支：世界需要自己的 chrome
// （事件日志、上帝行动条、法则入口、世界信息），而 ChatPanel 的二十余个属性在世界
// 模式下无一有意义。
//
// 布局（自上而下）：三维沙盘（或二维降级地图）→ 事件日志 → 上帝行动条。
// 沙盘占满剩余空间，日志可折叠，行动条固定在底部。
//
// 两层懒加载，让不开世界的用户零成本：
//   1) useWorld 懒加载本组件外壳
//   2) 本组件在**模块作用域**懒加载 WorldCanvas（three 那个 chunk）
// 探测在懒加载模块之外求值，故无 WebGL2 的设备**根本不会请求 three**。

import { lazy, Suspense, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorldEntity, WorldEvent, WorldState } from '@momoi/shared/types'
import { Button } from '../ui/button'
import { Loading } from '../ui/spinner'
import { Globe, Info, X } from 'lucide-react'
import { detectWebGL } from '../../lib/webgl'
import { WorldFallback } from './WorldFallback'
import { WorldEventLog } from './WorldEventLog'
import { GodActionBar } from './GodActionBar'
import { LawsEditor } from './LawsEditor'
import type { WorldAgentBrief } from '../../hooks/useWorld'

// ⚠️ 模块作用域，不能在组件内 —— 组件内 lazy() 每次渲染都会重建 lazy 类型
const LazyWorldCanvas = lazy(() =>
  import('./WorldCanvas').then((m) => ({ default: m.WorldCanvas })),
)

interface WorldPanelProps {
  worldState: WorldState | null
  worldEntities: WorldEntity[]
  worldEvents: WorldEvent[]
  worldAgents: WorldAgentBrief[]
  loading: boolean
  error: string | null
  acting: boolean
  actingName: string | null
  savingLaws: boolean
  onSaveLaws: (laws: string) => Promise<void>
  onAct: (content: string) => void
}

export function WorldPanel({
  worldState,
  worldEntities,
  worldEvents,
  worldAgents,
  loading,
  error,
  acting,
  actingName,
  savingLaws,
  onSaveLaws,
  onAct,
}: WorldPanelProps) {
  const { t } = useTranslation()
  const [lawsOpen, setLawsOpen] = useState(false)
  const [infoOpen, setInfoOpen] = useState(true)
  const [logCollapsed, setLogCollapsed] = useState(false)
  const [contextLost, setContextLost] = useState(false)

  // 探测结果在模块内缓存，多次渲染不重复分配 GL 上下文
  const gl = useMemo(() => detectWebGL(), [])
  const degraded = gl === 'software' || contextLost

  const spec = worldState?.terrain_spec ?? null
  const ready = worldState?.status === 'ready' && !!spec

  let body: React.ReactNode
  if (loading && !worldState) {
    body = <CenterNote title={t('common.loading')} />
  } else if (error && !worldState) {
    body = <CenterNote title={t('world.failed')} detail={error} />
  } else if (worldState?.status === 'failed') {
    // failed 必须排在「地形未就绪」之前 —— 失败态本来就没有 spec，
    // 若先判 !spec 会把一个失败的坍界永远显示成「正在成形」
    body = <CenterNote title={t('world.failed')} detail={worldState.status_error || t('world.failedHint')} />
  } else if (!worldState || worldState.status === 'generating' || !spec) {
    body = <Generating />
  } else if (gl === 'none' || degraded) {
    // 二维降级：实时性更好、无 GPU 依赖，且它本身就有用（那是一张地图）
    body = <WorldFallback spec={spec} entities={worldEntities} agents={worldAgents} />
  } else {
    body = (
      <Suspense fallback={<CenterNote title={t('common.loading')} />}>
        <LazyWorldCanvas
          spec={spec}
          entities={worldEntities}
          agents={worldAgents}
          quality={gl}
          onContextLost={() => setContextLost(true)}
        />
      </Suspense>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      {/* 沙盘区：填满剩余空间，顶部留出 60px 顶栏 */}
      <div className="flex-1 min-h-0 relative mt-[60px]">{body}</div>

      {/* 世界信息卡（可折叠）—— 悬浮在右上 */}
      {ready && (
        <div className="absolute top-[68px] right-3 z-20 max-w-xs">
          {infoOpen ? (
            <div className="rounded-lg border bg-card/95 backdrop-blur px-3 py-2.5 shadow-lg text-sm space-y-1.5">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-primary shrink-0" />
                <span className="font-medium flex-1">{t('world.info')}</span>
                <button onClick={() => setInfoOpen(false)} className="rounded p-0.5 hover:bg-muted">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{spec?.summary}</p>
              {spec?.generated_by === 'fallback' && (
                <p className="text-xs text-amber-600 dark:text-amber-500">{t('world.fallbackNotice')}</p>
              )}
              {worldAgents.length > 0 && (
                <p className="text-xs text-muted-foreground/70">
                  {t('world.agentsInWorld')}：{worldAgents.map((a) => a.name).join('、')}
                </p>
              )}
              <Button size="sm" variant="outline" className="w-full mt-1" onClick={() => setLawsOpen(true)}>
                {t('world.laws')}
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="shadow-lg" onClick={() => setInfoOpen(true)}>
              <Info className="h-4 w-4 mr-1.5" />
              {t('world.info')}
            </Button>
          )}
        </div>
      )}

      {/* 降级提示：非阻断，浮在沙盘下缘 */}
      {ready && gl === 'none' && (
        <div className="absolute bottom-[calc(26vh+52px)] left-1/2 -translate-x-1/2 z-20 rounded-full border bg-card/95 backdrop-blur px-4 py-1.5 text-xs text-muted-foreground shadow">
          {t('world.noWebgl')}
        </div>
      )}
      {ready && gl === 'software' && !contextLost && (
        <div className="absolute bottom-[calc(26vh+52px)] left-1/2 -translate-x-1/2 z-20 rounded-full border bg-card/95 backdrop-blur px-4 py-1.5 text-xs text-muted-foreground shadow">
          {t('world.degraded')}
        </div>
      )}

      {/* 回合失败 / 拉取错误的行内提示（世界已就绪时） */}
      {ready && error && (
        <div className="absolute top-[68px] left-3 z-20 max-w-sm rounded-lg border border-destructive/40 bg-card/95 backdrop-blur px-3 py-2 text-xs text-destructive shadow">
          {error}
        </div>
      )}

      {/* 事件日志 + 上帝行动条：世界就绪后常驻 */}
      {ready && (
        <>
          <WorldEventLog
            events={worldEvents}
            actingName={actingName}
            collapsed={logCollapsed}
            onToggleCollapsed={() => setLogCollapsed((v) => !v)}
          />
          <GodActionBar disabled={worldState?.status !== 'ready'} acting={acting} onSubmit={onAct} />
        </>
      )}

      {spec && (
        <LawsEditor
          open={lawsOpen}
          onOpenChange={setLawsOpen}
          terrainPrompt={worldState?.terrain_prompt ?? ''}
          laws={worldState?.laws ?? ''}
          saving={savingLaws}
          onSave={async (laws) => {
            await onSaveLaws(laws)
            setLawsOpen(false)
          }}
        />
      )}
    </div>
  )
}

function CenterNote({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      {detail && <p className="text-xs text-muted-foreground max-w-sm">{detail}</p>}
    </div>
  )
}

function Generating() {
  const { t } = useTranslation()
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
      <Loading />
      <p className="text-sm font-medium">{t('world.generating')}</p>
      <p className="text-xs text-muted-foreground">{t('world.generatingHint')}</p>
    </div>
  )
}
