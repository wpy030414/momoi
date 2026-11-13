import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '../../ui/input'
import { Button } from '../../ui/button'
import { Switch } from '../../ui/switch'
import { Loading } from '../../ui/spinner'
import { api } from '../../../lib/api'
import { useAutoSave } from '../../../hooks/useAutoSave'
import { useToast } from '../../ui/toast'

/** 首页推荐问题条数（空对话展示） */
const RECOMMENDED_QUESTION_COUNT = 3
/** 聊天常用追问条数上限（非空对话输入框上方气泡） */
const FOLLOWUP_QUESTION_COUNT = 5
/** 每条问题的软性长度上限 */
const QUESTION_MAX_LENGTH = 20

export function ExperienceSettings() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [config, setConfig] = useState<any>(null)
  const [questions, setQuestions] = useState<string[]>(() => Array(RECOMMENDED_QUESTION_COUNT).fill(''))
  const [followups, setFollowups] = useState<string[]>(() => Array(FOLLOWUP_QUESTION_COUNT).fill(''))
  const faviconInputRef = useRef<HTMLInputElement>(null)
  const backgroundInputRef = useRef<HTMLInputElement>(null)

  // 自动保存读最新状态（闭包捕获会拿到旧值）
  const configRef = useRef<any>(null)
  configRef.current = config
  const questionsRef = useRef<string[]>(questions)
  questionsRef.current = questions
  const followupsRef = useRef<string[]>(followups)
  followupsRef.current = followups

  /**
   * 改完即存（见 hooks/useAutoSave.ts）。
   * 校验放在提交前：任何一项超长都拒绝提交并提示，不写入半截数据。
   */
  const autoSave = useAutoSave({
    save: async () => {
      if (!configRef.current) return
      const rq = questionsRef.current.map((q) => q.trim()).filter(Boolean)
      const fq = followupsRef.current.map((q) => q.trim()).filter(Boolean)
      // 软限制：每条问题 ≤ 20 字。超长则整次不提交（同一份 config 原子写入）
      if (rq.some((q) => q.length > QUESTION_MAX_LENGTH)) throw new Error('QUESTION_TOO_LONG')
      if (fq.some((q) => q.length > QUESTION_MAX_LENGTH)) throw new Error('FOLLOWUP_TOO_LONG')

      const c = configRef.current
      await api.updateConfig({
        app_name: c.app_name,
        app_favicon: c.app_favicon,
        app_background: c.app_background,
        show_github: c.show_github,
        recommended_questions: rq,
        followup_questions: fq,
      })
    },
    onError: (err: unknown) => {
      const msg = (err as Error)?.message
      if (msg === 'QUESTION_TOO_LONG') toast({ title: t('settings.questionTooLong'), variant: 'error' })
      else if (msg === 'FOLLOWUP_TOO_LONG') toast({ title: t('settings.followupTooLong'), variant: 'error' })
      else console.error(err)
    },
  })

  useEffect(() => {
    api.getConfig().then((c) => {
      setConfig(c)
      const rq = c.recommended_questions || []
      setQuestions((prev) => prev.map((_, i) => rq[i] || ''))
      const fq = c.followup_questions || []
      setFollowups((prev) => prev.map((_, i) => fq[i] || ''))
    }).catch(console.error)
  }, [])

  const handleFaviconChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setConfig((prev: any) => prev ? { ...prev, app_favicon: reader.result as string } : prev)
      autoSave.saveSoon()
    }
    reader.readAsDataURL(file)
  }

  const handleBackgroundChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setConfig((prev: any) => prev ? { ...prev, app_background: reader.result as string } : prev)
      autoSave.saveSoon()
    }
    reader.readAsDataURL(file)
  }

  /** 通用问题输入组：带长度计数器，超长标红；失焦时提交（校验在 save 内） */
  const renderQuestionInputs = (values: string[], setValues: (v: string[]) => void, placeholderKey: string) => (
    <div className="space-y-2 mt-1">
      {values.map((val, i) => (
        <div className="relative" key={i}>
          <Input
            value={val}
            onChange={(e) => {
              const next = [...values]
              next[i] = e.target.value
              setValues(next)
              autoSave.markDirty()
            }}
            onBlur={() => autoSave.saveSoon()}
            placeholder={t(placeholderKey, { n: i + 1 })}
            className="pr-12"
          />
          <span className={`absolute right-3 top-1/2 -translate-y-1/2 text-xs ${val.length > QUESTION_MAX_LENGTH ? 'text-destructive' : 'text-muted-foreground'}`}>
            {val.length}/{QUESTION_MAX_LENGTH}
          </span>
        </div>
      ))}
    </div>
  )

  if (!config) return <Loading className="py-16" />

  return (
    <div className="space-y-4 pt-4">
      <div>
        <label className="text-sm font-medium">{t('settings.appName')}</label>
        <Input
          value={config.app_name || ''}
          onChange={(e) => { setConfig((prev: any) => prev ? { ...prev, app_name: e.target.value } : prev); autoSave.markDirty() }}
          onBlur={() => autoSave.saveSoon()}
          className="mt-1"
          placeholder={t('settings.appNamePlaceholder')}
        />
      </div>
      <div>
        <label className="text-sm font-medium">{t('settings.appFavicon')}</label>
        <div className="flex items-center gap-4 mt-1">
          {config.app_favicon ? (
            <img src={config.app_favicon} alt={t('settings.altFaviconPreview')} className="h-8 w-8 rounded" />
          ) : (
            <div className="h-8 w-8 rounded bg-muted flex items-center justify-center text-xs">{t('settings.placeholderDefaultFavicon')}</div>
          )}
          <input ref={faviconInputRef} type="file" accept="image/*" className="hidden" onChange={handleFaviconChange} />
          <Button variant="outline" size="sm" onClick={() => faviconInputRef.current?.click()}>
            {t('settings.uploadFavicon')}
          </Button>
          {config.app_favicon && (
            <Button variant="ghost" size="sm" onClick={() => { setConfig((prev: any) => prev ? { ...prev, app_favicon: '' } : prev); autoSave.saveSoon() }}>
              {t('common.remove')}
            </Button>
          )}
        </div>
      </div>
      <div>
        <label className="text-sm font-medium">{t('settings.appBackground')}</label>
        <div className="flex items-center gap-4 mt-1">
          {config.app_background ? (
            <div className="h-12 w-12 rounded border" style={{ backgroundImage: `url(${config.app_background})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
          ) : (
            <div className="h-12 w-12 rounded bg-muted flex items-center justify-center text-xs">{t('settings.placeholderNoBackground')}</div>
          )}
          <input ref={backgroundInputRef} type="file" accept="image/*" className="hidden" onChange={handleBackgroundChange} />
          <Button variant="outline" size="sm" onClick={() => backgroundInputRef.current?.click()}>
            {t('settings.uploadBackground')}
          </Button>
          {config.app_background && (
            <Button variant="ghost" size="sm" onClick={() => { setConfig((prev: any) => prev ? { ...prev, app_background: '' } : prev); autoSave.saveSoon() }}>
              {t('common.remove')}
            </Button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium">{t('settings.showGithub')}</label>
        <Switch checked={config.show_github !== false} onCheckedChange={(v) => { setConfig((prev: any) => prev ? { ...prev, show_github: v } : prev); autoSave.saveNow() }} />
      </div>
      <div>
        <label className="text-sm font-medium">{t('settings.recommendedQuestions')}</label>
        {renderQuestionInputs(questions, setQuestions, 'settings.questionPlaceholder')}
      </div>
      <div>
        <label className="text-sm font-medium">{t('settings.followupQuestions')}</label>
        {renderQuestionInputs(followups, setFollowups, 'settings.followupPlaceholder')}
      </div>
    </div>
  )
}
