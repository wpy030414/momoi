import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { WechatBindPanel } from './WechatBindPanel'
import { QqBindPanel } from './QqBindPanel'
import { Smartphone, MessageCircle } from 'lucide-react'

interface ImBindDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  convId: string
}

type Channel = 'select' | 'wechat' | 'qq'

/**
 * 「在 IM 上继续」对话框：先选渠道（微信 / QQ），再进入对应绑定面板。
 * 两渠道绑定完全正交 —— 一个会话可同时绑定微信与 QQ。
 */
export function ImBindDialog({ open, onOpenChange, convId }: ImBindDialogProps) {
  const { t } = useTranslation()
  const [channel, setChannel] = useState<Channel>('select')

  // 关闭时重置回选择页，下次打开从头开始
  useEffect(() => {
    if (!open) setChannel('select')
  }, [open])

  const title = channel === 'wechat'
    ? t('wechatBind.title')
    : channel === 'qq'
      ? t('qqBind.title')
      : t('imBind.title')

  const description = channel === 'wechat'
    ? undefined
    : channel === 'qq'
      ? undefined
      : t('imBind.description')

  const handleClose = () => onOpenChange(false)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {/* 渠道面板视图下左上角有返回按钮，标题右移避让 */}
        <DialogHeader className={channel !== 'select' ? 'pl-8' : undefined}>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {channel === 'select' && (
          <div className="flex flex-col gap-3 py-2">
            <button
              className="flex items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-accent/60"
              onClick={() => setChannel('wechat')}
            >
              <Smartphone className="h-8 w-8 shrink-0 text-green-600 dark:text-green-400" />
              <span className="flex flex-col">
                <span className="font-medium">{t('imBind.wechat')}</span>
                <span className="text-sm text-muted-foreground">{t('imBind.wechatDesc')}</span>
              </span>
            </button>
            <button
              className="flex items-center gap-3 rounded-lg border p-4 text-left transition-colors hover:bg-accent/60"
              onClick={() => setChannel('qq')}
            >
              <MessageCircle className="h-8 w-8 shrink-0 text-sky-500" />
              <span className="flex flex-col">
                <span className="font-medium">{t('imBind.qq')}</span>
                <span className="text-sm text-muted-foreground">{t('imBind.qqDesc')}</span>
              </span>
            </button>
          </div>
        )}

        {/* key 强制重挂载：切渠道等价于重新打开 dialog（微信重取二维码、QQ 重查状态） */}
        {channel === 'wechat' && (
          <WechatBindPanel key="wechat" convId={convId} onBack={() => setChannel('select')} onComplete={handleClose} />
        )}
        {channel === 'qq' && (
          <QqBindPanel key="qq" convId={convId} onBack={() => setChannel('select')} onComplete={handleClose} />
        )}
      </DialogContent>
    </Dialog>
  )
}
