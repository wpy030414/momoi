import { useTranslation } from 'react-i18next'
import { ArrowLeft, Bot, Globe, Palette, Server, Puzzle, BarChart3 } from 'lucide-react'
import { Button } from '../ui/button'
import { ScrollArea } from '../ui/scroll-area'

interface AdminSidebarProps {
  activeTab: string
  onTabChange: (tab: string) => void
  onBack: () => void
}

const TABS = [
  { value: 'agent', labelKey: 'settings.tabAgent', Icon: Bot },
  { value: 'gateway', labelKey: 'settings.tabGateway', Icon: Globe },
  { value: 'branding', labelKey: 'settings.tabBranding', Icon: Palette },
  { value: 'mcp', labelKey: 'settings.tabMcp', Icon: Server },
  { value: 'skills', labelKey: 'settings.tabSkills', Icon: Puzzle },
  { value: 'stats', labelKey: 'settings.tabStats', Icon: BarChart3 },
] as const

export function AdminSidebar({ activeTab, onTabChange, onBack }: AdminSidebarProps) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col h-full w-72 bg-card border-r">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 border-b shrink-0" style={{ height: '60px' }}>
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors shrink-0"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h2 className="text-sm font-semibold truncate">{t('settings.title')}</h2>
      </div>

      {/* Tab list */}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-0.5">
          {TABS.map(({ value, labelKey, Icon }) => (
            <Button
              key={value}
              variant="ghost"
              size="sm"
              className={`w-full justify-start gap-2.5 h-9 px-3 text-sm font-normal ${
                activeTab === value
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => onTabChange(value)}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {t(labelKey)}
            </Button>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}