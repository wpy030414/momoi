import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '../../ui/input'
import { Button } from '../../ui/button'
import { Switch } from '../../ui/switch'
import { Loading } from '../../ui/spinner'
import { api } from '../../../lib/api'
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
  const [saving, setSaving] = useState(false)
  const [questions, setQuestions] = useState<string[]>(() => Array(RECOMMENDED_QUESTION_COUNT).fill(''))
  const [followups, setFollowups] = useState<string[]>(() => Array(FOLLOWUP_QUESTION_COUNT).fill(''))
  const faviconInputRef = useRef<HTMLInputElement>(null)
  const backgroundInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.getConfig().then((c) => {
      setConfig(c)
      const rq = c.recommended_questions || []
      setQuestions((prev) => prev.map((_, i) => rq[i] || ''))
      const fq = c.followup_questions || []
      setFollowups((prev) => prev.map((_, i) => fq[i] || ''))
    }).catch(console.error)
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      const rq = questions.map((q) => q.trim()).filter(Boolean)
      const fq = followups.map((q) => q.trim()).filter(Boolean)
      // Soft limit: each question must be ≤20 chars
      if (rq.some((q) => q.length > QUESTION_MAX_LENGTH)) {
        toast({ title: t('settings.questionTooLong'), variant: 'error' })
        setSaving(false)
        return
      }
      if (fq.some((q) => q.length > QUESTION_MAX_LENGTH)) {
        toast({ title: t('settings.followupTooLong'), variant: 'error' })
        setSaving(false)
        return
      }
      await api.updateConfig({
        app_name: config.app_name,
        app_favicon: config.app_favicon,
        app_background: config.app_background,
        show_github: config.show_github,
        recommended_questions: rq,
        followup_questions: fq,
      })
      toast({ title: t('settings.toastSaved'), variant: 'success' })
    } catch (err) {
      console.error(err)
    }
    setSaving(false)
  }

  const handleFaviconChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setConfig({ ...config, app_favicon: reader.result as string })
    }
    reader.readAsDataURL(file)
  }

  const handleBackgroundChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      setConfig({ ...config, app_background: reader.result as string })
    }
    reader.readAsDataURL(file)
  }

  /** 通用问题输入组：带长度计数器，超长标红 */
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
            }}
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
          onChange={(e) => setConfig({ ...config, app_name: e.target.value })}
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
            <Button variant="ghost" size="sm" onClick={() => setConfig({ ...config, app_favicon: '' })}>
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
            <Button variant="ghost" size="sm" onClick={() => setConfig({ ...config, app_background: '' })}>
              {t('common.remove')}
            </Button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium">{t('settings.showGithub')}</label>
        <Switch checked={config.show_github !== false} onCheckedChange={(v) => setConfig({ ...config, show_github: v })} />
      </div>
      <div>
        <label className="text-sm font-medium">{t('settings.recommendedQuestions')}</label>
        {renderQuestionInputs(questions, setQuestions, 'settings.questionPlaceholder')}
      </div>
      <div>
        <label className="text-sm font-medium">{t('settings.followupQuestions')}</label>
        {renderQuestionInputs(followups, setFollowups, 'settings.followupPlaceholder')}
      </div>
      <Button onClick={handleSave} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</Button>
    </div>
  )
}
