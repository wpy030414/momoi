import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Spinner } from '../ui/spinner'
import { MessageSquare, MessagesSquare, Map, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api'
import type { ConversationSearchResult } from '@momoi/shared/types'

/** 文本按命中词切分为高亮片段（大小写不敏感）。空 q 原样返回单段。 */
export function splitHighlight(text: string, q: string): Array<{ text: string; hit: boolean }> {
  if (!q) return [{ text, hit: false }]
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  const parts: Array<{ text: string; hit: boolean }> = []
  let from = 0
  let idx = lower.indexOf(needle, from)
  while (idx !== -1) {
    if (idx > from) parts.push({ text: text.slice(from, idx), hit: false })
    parts.push({ text: text.slice(idx, idx + needle.length), hit: true })
    from = idx + needle.length
    idx = lower.indexOf(needle, from)
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false })
  return parts
}

function Highlighted({ text, q }: { text: string; q: string }) {
  const parts = splitHighlight(text, q)
  return (
    <>
      {parts.map((p, i) =>
        p.hit
          ? <span key={i} className="text-primary font-medium">{p.text}</span>
          : <span key={i}>{p.text}</span>,
      )}
    </>
  )
}

interface ConversationSearchDialogProps {
  open: boolean
  onClose: () => void
  onSelect: (convId: string) => void
}

/** 会话搜索：标题 + 消息内容（后端 LIKE），300ms 防抖 + 请求序号丢弃乱序响应 */
export function ConversationSearchDialog({ open, onClose, onSelect }: ConversationSearchDialogProps) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [results, setResults] = useState<ConversationSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const seqRef = useRef(0)

  // 输入 → 300ms 防抖
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q.trim()), 300)
    return () => clearTimeout(timer)
  }, [q])

  // 防抖值 → 后端搜索（序号守卫丢弃乱序响应）
  useEffect(() => {
    if (!open) return
    if (!debouncedQ) {
      seqRef.current++
      setResults([])
      setLoading(false)
      return
    }
    const seq = ++seqRef.current
    setLoading(true)
    api.searchConversations(debouncedQ)
      .then((res) => {
        if (seq !== seqRef.current) return // 过期响应
        setResults(res.results)
      })
      .catch((err) => {
        if (seq !== seqRef.current) return
        console.error('Failed to search conversations:', err)
        setResults([])
      })
      .finally(() => {
        if (seq === seqRef.current) setLoading(false)
      })
  }, [debouncedQ, open])

  // 关闭时清空（下次打开是干净状态）
  useEffect(() => {
    if (!open) {
      setQ('')
      setDebouncedQ('')
      setResults([])
      setLoading(false)
      seqRef.current++
    }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md p-0 gap-0 overflow-hidden">
        <DialogHeader className="p-4 pb-2">
          <DialogTitle className="text-base">{t('sidebar.searchConversations')}</DialogTitle>
        </DialogHeader>
        <div className="px-4 pb-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              autoFocus
              className="pl-8"
              placeholder={t('sidebar.searchPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>
        <div className="max-h-80 overflow-y-auto border-t px-2 py-2 space-y-0.5">
          {loading && (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Spinner />
            </div>
          )}
          {!loading && debouncedQ && results.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">{t('sidebar.searchNoResults')}</p>
          )}
          {!loading && !debouncedQ && (
            <p className="text-xs text-muted-foreground/70 text-center py-6">{t('sidebar.searchPlaceholder')}</p>
          )}
          {!loading && results.map((r) => (
            <button
              key={r.conversation.id}
              className="w-full flex items-start gap-2 px-2 py-2 rounded-md text-left hover:bg-accent/50 transition-colors cursor-pointer"
              onClick={() => { onSelect(r.conversation.id); onClose() }}
            >
              <span className="flex-shrink-0 mt-0.5 text-muted-foreground">
                {r.conversation.type === 'world' ? (
                  <Map className="h-4 w-4" />
                ) : r.conversation.type === 'group' ? (
                  <MessagesSquare className="h-4 w-4" />
                ) : (
                  <MessageSquare className="h-4 w-4" />
                )}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm truncate">
                  <Highlighted text={r.conversation.title === 'New Chat' ? t('sidebar.newChat') : r.conversation.title} q={debouncedQ} />
                </span>
                {r.matched === 'content' && r.snippet && (
                  <span className="block text-xs text-muted-foreground truncate">
                    <Highlighted text={r.snippet} q={debouncedQ} />
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
