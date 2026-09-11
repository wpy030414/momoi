import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileText, FileImage, FileSpreadsheet, File, FileType } from 'lucide-react'

interface Attachment {
  url: string
  name: string
  size: number
  type: string
}

interface AttachmentCardProps {
  attachment: Attachment
}

function getFileIcon(type: string, name: string) {
  if (type.startsWith('image/')) return <FileImage className="h-5 w-5 text-blue-500" />
  if (type.startsWith('text/') || name.endsWith('.md')) return <FileText className="h-5 w-5 text-emerald-500" />
  if (name.match(/\.(xlsx|xls|csv)$/i)) return <FileSpreadsheet className="h-5 w-5 text-green-600" />
  if (name.match(/\.(pdf)$/i)) return <FileType className="h-5 w-5 text-red-500" />
  if (name.match(/\.(json|xml|yaml|yml)$/i)) return <FileText className="h-5 w-5 text-yellow-500" />
  return <File className="h-5 w-5 text-muted-foreground" />
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function downloadFile(url: string, name: string) {
  // External URLs (CDN, etc.): direct browser download via <a>
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.target = '_blank'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    return
  }

  // Workspace URL: fetch with cookie auth, then blob download
  const sep = url.includes('?') ? '&' : '?'
  const downloadUrl = `${url}${sep}name=${encodeURIComponent(name)}`
  const res = await fetch(downloadUrl)
  if (!res.ok) throw new Error(`Download failed: ${res.status}`)
  const blob = await res.blob()
  const blobUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = blobUrl
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(blobUrl)
}

export function AttachmentCard({ attachment }: AttachmentCardProps) {
  const { t } = useTranslation()
  const [error, setError] = useState('')

  const handleClick = async () => {
    setError('')
    try {
      await downloadFile(attachment.url, attachment.name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="max-w-[260px]">
      <button
        onClick={handleClick}
        className="inline-flex items-center gap-2.5 px-3 py-2 rounded-lg border bg-background/80 hover:bg-muted/50 transition-colors group/card w-full text-left"
        title={error || attachment.name}
      >
        <div className="flex-shrink-0">
          {getFileIcon(attachment.type, attachment.name)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium truncate">{attachment.name}</div>
          <div className="text-[10px] text-muted-foreground">{formatSize(attachment.size)}</div>
        </div>
        <Download className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground group-hover/card:text-foreground transition-colors" />
      </button>
      {error && (
        <div className="mt-1 px-2 py-1 rounded bg-destructive/10 text-destructive text-[10px] break-words">
          {t('chat.downloadFailed', { message: error })}
        </div>
      )}
    </div>
  )
}

interface AttachmentListProps {
  attachments: Attachment[]
}

export function AttachmentList({ attachments }: AttachmentListProps) {
  if (!attachments || attachments.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1.5 mb-2">
      {attachments.map((att, idx) => (
        <AttachmentCard key={idx} attachment={att} />
      ))}
    </div>
  )
}
