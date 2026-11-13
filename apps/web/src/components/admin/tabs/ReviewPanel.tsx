import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button'
import { Loading } from '../../ui/spinner'
import { api } from '../../../lib/api'

/** token 数 → MTok 用量显示（1e6 token = 1 MTok）。已用量需 2 位小数保精度。 */
function tokensToMtok(tokens: number): string {
  return (tokens / 1e6).toFixed(2)
}

const COST_RANGE_DAYS = 7

/**
 * 成本看板（审查 Tab 顶部）：近 7 天用量，按用户与按天两个维度。
 * 数据来自 usage_ledger（周额度账本），与额度拦截同一口径。
 */
function CostBoard() {
  const { t } = useTranslation()
  const [board, setBoard] = useState<import('@momoi/shared/types').AdminCostBoard | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.getAdminCostBoard(COST_RANGE_DAYS)
      .then(setBoard)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Loading />
  if (!board || board.total_tokens === 0) {
    return (
      <div className="rounded-md border p-4">
        <h3 className="text-sm font-semibold mb-1">{t('settings.costBoard')}</h3>
        <p className="text-muted-foreground text-sm">{t('settings.costNoData')}</p>
      </div>
    )
  }

  const maxDay = Math.max(...board.by_day.map((d) => d.tokens), 1)

  return (
    <div className="rounded-md border p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold">{t('settings.costBoard')}</h3>
        <span className="text-xs text-muted-foreground">{t('settings.costBoardRange', { days: board.days })}</span>
      </div>
      <div className="mb-4">
        <span className="text-xs text-muted-foreground">{t('settings.costBoardTotal')}</span>
        <span className="ml-2 text-lg font-semibold">{tokensToMtok(board.total_tokens)}</span>
        <span className="ml-1 text-xs text-muted-foreground">MTok</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* 按天：简易条形图 */}
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-2">{t('settings.costByDay')}</div>
          <div className="space-y-1">
            {board.by_day.map((d) => (
              <div key={d.date} className="flex items-center gap-2 text-xs">
                <span className="w-20 shrink-0 text-muted-foreground">{d.date.slice(5)}</span>
                <div className="flex-1 h-2 rounded bg-muted overflow-hidden">
                  <div className="h-full bg-primary" style={{ width: `${(d.tokens / maxDay) * 100}%` }} />
                </div>
                <span className="w-16 text-right tabular-nums">{tokensToMtok(d.tokens)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 按用户 */}
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-2">{t('settings.costByUser')}</div>
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {board.by_user.map((u) => (
              <div key={u.username} className="flex items-center justify-between text-xs">
                <span className="truncate">{u.username}</span>
                <span className="tabular-nums ml-2 shrink-0">{tokensToMtok(u.tokens)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function ReviewPanel() {
  const { t } = useTranslation()
  const [conversations, setConversations] = useState<any[]>([])
  const [currentPage, setCurrentPage] = useState(1)
  const [expandedConvId, setExpandedConvId] = useState<string | null>(null)
  const [expandedConv, setExpandedConv] = useState<{ type?: string; agent_id?: string | null } | null>(null)
  const [expandedMessages, setExpandedMessages] = useState<any[]>([])
  const [loadingMessages, setLoadingMessages] = useState(false)
  const [agentNames, setAgentNames] = useState<Map<string, string>>(new Map())
  const pageSize = 10

  useEffect(() => {
    api.getAdminConversations().then((r) => setConversations(r.conversations)).catch(console.error)
    api.listAdminAgents().then((r) => {
      const map = new Map<string, string>()
      r.agents.forEach((a) => map.set(a.id, a.name))
      setAgentNames(map)
    }).catch(console.error)
  }, [])

  const formatTime = (ts: number) => {
    if (!ts) return t('common.notAvailable')
    return new Date(ts * 1000).toLocaleString()
  }

  const roleLabel = (msg: any) => {
    if (msg.role === 'user') return t('settings.reviewRoleUser')
    if (msg.role === 'system') return t('settings.reviewRoleSystem')
    if (msg.role === 'tool') return t('settings.reviewRoleTool')
    if (msg.agent_id && agentNames.has(msg.agent_id)) return agentNames.get(msg.agent_id)!
    if (expandedConv?.type === 'direct' && expandedConv.agent_id && agentNames.has(expandedConv.agent_id)) {
      return agentNames.get(expandedConv.agent_id)!
    }
    return t('settings.reviewRoleAssistant')
  }

  const handleRowClick = async (convId: string) => {
    if (expandedConvId === convId) {
      setExpandedConvId(null)
      setExpandedMessages([])
      setExpandedConv(null)
      return
    }
    setExpandedConvId(convId)
    setLoadingMessages(true)
    try {
      const data = await api.getAdminConversationMessages(convId)
      setExpandedMessages(data.messages)
      setExpandedConv(data.conversation)
    } catch (err) {
      console.error(err)
      setExpandedMessages([])
      setExpandedConv(null)
    }
    setLoadingMessages(false)
  }

  const totalPages = Math.ceil(conversations.length / pageSize)
  const startIndex = (currentPage - 1) * pageSize
  const endIndex = startIndex + pageSize
  const paginatedConversations = conversations.slice(startIndex, endIndex)

  return (
    <div className="pt-4 space-y-6">
      <CostBoard />
      {conversations.length === 0 ? (
        <p className="text-muted-foreground">{t('settings.statsNoConversations')}</p>
      ) : (
        <>
          <div className="rounded-md border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">{t('settings.statsUser')}</th>
                  <th className="text-left px-3 py-2 font-medium">{t('settings.statsTitle')}</th>
                  <th className="text-right px-3 py-2 font-medium">{t('settings.statsMessages')}</th>
                  <th className="text-left px-3 py-2 font-medium">{t('settings.statsUpdated')}</th>
                </tr>
              </thead>
              <tbody>
                {paginatedConversations.map((conv) => (
                  <React.Fragment key={conv.id}>
                    <tr
                      className={`border-t cursor-pointer hover:bg-muted/30 transition-colors ${expandedConvId === conv.id ? 'bg-muted/50' : ''}`}
                      onClick={() => handleRowClick(conv.id)}
                    >
                      <td className="px-3 py-2">{conv.user_id || t('common.notAvailable')}</td>
                      <td className="px-3 py-2 truncate max-w-[200px]">{conv.title}</td>
                      <td className="px-3 py-2 text-right">{conv.message_count}</td>
                      <td className="px-3 py-2 text-muted-foreground">{formatTime(conv.updated_at)}</td>
                    </tr>
                    {expandedConvId === conv.id && (
                      <tr>
                        <td colSpan={4} className="px-3 py-4 bg-muted/20">
                          {loadingMessages ? (
                            <Loading className="py-4" size="sm" />
                          ) : expandedMessages.length === 0 ? (
                            <p className="text-center text-muted-foreground py-4">{t('settings.reviewNoMessages')}</p>
                          ) : (
                            <div className="space-y-3 max-h-[400px] overflow-y-auto">
                              {expandedMessages.map((msg) => (
                                <div key={msg.id} className="rounded-md border bg-background p-3">
                                  <div className="flex items-center justify-between mb-2">
                                    <span className="text-xs font-medium text-muted-foreground">{roleLabel(msg)}</span>
                                    <span className="text-xs text-muted-foreground">{formatTime(msg.created_at)}</span>
                                  </div>
                                  <div className="text-sm whitespace-pre-wrap break-words">{msg.content || t('settings.reviewEmptyMessage')}</div>
                                  {msg.thinking && (
                                    <details className="mt-2">
                                      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">{t('chat.thinking')}</summary>
                                      <div className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">{msg.thinking}</div>
                                    </details>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <p className="text-sm text-muted-foreground">
                {startIndex + 1}-{Math.min(endIndex, conversations.length)} / {conversations.length}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={currentPage === 1} onClick={() => { setCurrentPage(currentPage - 1); setExpandedConvId(null) }}>
                  {t('settings.statsPrevPage')}
                </Button>
                <span className="flex items-center px-3 text-sm">{currentPage} / {totalPages}</span>
                <Button variant="outline" size="sm" disabled={currentPage === totalPages} onClick={() => { setCurrentPage(currentPage + 1); setExpandedConvId(null) }}>
                  {t('settings.statsNextPage')}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}