import { BookOpen, ChevronDown, FileText, Folder, Image as ImageIcon, MessageSquare } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/**
 * Introduction page 4 mock — a workspace folder holding related conversations
 * (tree-guided indentation, mirroring the real Sidebar) with its shared file
 * strip, next to the in-app document viewer that opens those files.
 * Semantic tokens only.
 */
export function MockWorkspace() {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3">
      {/* Workspace card: folder header + indented conversations + shared files */}
      <div className="w-[150px] h-[170px] rounded-lg border border-border bg-card overflow-hidden shadow-sm flex flex-col">
        {/* Folder header */}
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border">
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <Folder className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
          <span className="text-[9px] font-medium leading-none truncate">{t('intro.mock.workspaceName')}</span>
        </div>

        {/* Member conversations — tree guide line, same idiom as the sidebar */}
        <div className="flex-1 px-2 py-2 space-y-1.5 min-h-0">
          <div className="ml-[7px] border-l border-border/60 pl-1.5 space-y-1.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-center gap-1.5">
                <MessageSquare className="h-2.5 w-2.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span
                  className={`h-1.5 rounded bg-muted-foreground/40 ${
                    i === 0 ? 'w-full' : i === 1 ? 'w-4/5' : 'w-3/5'
                  }`}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Shared file strip */}
        <div className="flex items-center gap-1 px-2 py-1.5 border-t border-border">
          <span className="flex items-center gap-1 min-w-0 rounded bg-muted px-1 py-0.5 text-[8px] leading-none">
            <FileText className="h-2.5 w-2.5 shrink-0 text-primary" aria-hidden="true" />
            <span className="truncate">{t('intro.mock.docName')}</span>
          </span>
          <span className="flex items-center gap-1 min-w-0 rounded bg-muted px-1 py-0.5 text-[8px] leading-none">
            <ImageIcon className="h-2.5 w-2.5 shrink-0 text-primary" aria-hidden="true" />
            <span className="truncate">{t('intro.mock.imageName')}</span>
          </span>
        </div>
      </div>

      {/* Document viewer */}
      <div className="w-[104px] h-[150px] rounded-lg border border-border bg-card p-2 shadow-sm shrink-0 flex flex-col">
        <div className="flex items-center gap-1 mb-2">
          <BookOpen className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
          <span className="text-[8px] font-medium leading-none truncate">{t('intro.mock.docViewerTitle')}</span>
        </div>
        <div className="space-y-1.5">
          {['w-full', 'w-11/12', 'w-full', 'w-4/5', 'w-2/3'].map((w, i) => (
            <span key={i} className={`block h-1.5 rounded bg-muted-foreground/25 ${w}`} />
          ))}
        </div>
      </div>
    </div>
  )
}
