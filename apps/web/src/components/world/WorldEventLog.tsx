// ============================================================
// WorldEventLog — 世界的事件日志
// ============================================================
// 世界不渲染聊天气泡，**事件日志就是它的表达**：上帝做了什么、每个 Agent 做了什么，
// 按回合分组。这也是 Agent 的「历史来源」—— 后端给每个 Agent 的简报正是从这张日志里取的。

import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorldEvent } from '@momoi/shared/types'
import { ChevronDown, ChevronUp, Footprints, MessageCircle, Skull, Scroll, Sparkles, BookOpen } from 'lucide-react'

interface WorldEventLogProps {
  events: WorldEvent[]
  actingName: string | null
  collapsed: boolean
  onToggleCollapsed: () => void
}

const KIND_ICON = {
  act: Sparkles,
  speak: MessageCircle,
  move: Footprints,
  die: Skull,
  law: BookOpen,
  narration: Scroll,
} as const

export function WorldEventLog({ events, actingName, collapsed, onToggleCollapsed }: WorldEventLogProps) {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)

  // 按回合分组（升序）
  const turns = useMemo(() => {
    const map = new Map<number, WorldEvent[]>()
    for (const e of events) {
      const list = map.get(e.turn)
      if (list) list.push(e)
      else map.set(e.turn, [e])
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0])
  }, [events])

  const lastId = events.length > 0 ? events[events.length - 1].id : 0
  // 自动滚到底：新事件到达时把视图带到末尾
  useEffect(() => {
    const el = scrollRef.current
    if (el && !collapsed) el.scrollTop = el.scrollHeight
  }, [lastId, collapsed, actingName])

  return (
    <div className="border-t bg-card/60 backdrop-blur shrink-0">
      <button
        onClick={onToggleCollapsed}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/40 transition-colors"
      >
        {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        <span>{t('world.log')}</span>
        <span className="text-muted-foreground/60">
          {turns.length > 0 ? t('world.turnCount', { n: turns[turns.length - 1][0] }) : ''}
        </span>
      </button>

      {!collapsed && (
        <div ref={scrollRef} className="h-[26vh] min-h-[140px] overflow-y-auto px-3 pb-2 space-y-2">
          {events.length === 0 && !actingName && (
            <p className="text-xs text-muted-foreground/70 py-3 text-center leading-relaxed">
              {t('world.logEmpty')}
            </p>
          )}

          {turns.map(([turn, list]) => (
            <div key={turn} className="space-y-1">
              <div className="flex items-center gap-2 pt-1">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                  {t('world.turn', { n: turn })}
                </span>
                <span className="flex-1 h-px bg-border" />
              </div>
              {list.map((e) => {
                const Icon = KIND_ICON[e.kind] ?? Sparkles
                const isGod = e.actor_kind === 'god'
                return (
                  <div key={e.id} className="flex gap-2 text-xs leading-relaxed">
                    <Icon
                      className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${
                        e.kind === 'die'
                          ? 'text-destructive'
                          : isGod
                            ? 'text-primary'
                            : 'text-muted-foreground'
                      }`}
                    />
                    <div className="min-w-0">
                      <span className={`font-medium ${isGod ? 'text-primary' : 'text-foreground/80'}`}>
                        {e.actor_name}
                      </span>
                      <span className="text-foreground/70"> · {e.content}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          ))}

          {actingName && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1">
              <span className="inline-flex gap-1">
                <span className="w-1 h-1 rounded-full bg-current animate-bounce [animation-delay:0ms]" />
                <span className="w-1 h-1 rounded-full bg-current animate-bounce [animation-delay:150ms]" />
                <span className="w-1 h-1 rounded-full bg-current animate-bounce [animation-delay:300ms]" />
              </span>
              {t('world.acting', { name: actingName })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
