import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../ui/button'
import { api } from '../../../lib/api'

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
    <div className="pt-4">
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
                            <div className="text-center text-muted-foreground py-4">{t('common.loading')}</div>
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