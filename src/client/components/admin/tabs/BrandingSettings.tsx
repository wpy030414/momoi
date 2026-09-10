import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '../../ui/input'
import { Button } from '../../ui/button'
import { Switch } from '../../ui/switch'
import { api } from '../../../lib/api'
import { useToast } from '../../ui/toast'

export function BrandingSettings() {
  const { t } = useTranslation()
  const { toast } = useToast()
  const [config, setConfig] = useState<any>(null)
  const [saving, setSaving] = useState(false)
  const [question1, setQuestion1] = useState('')
  const [question2, setQuestion2] = useState('')
  const [question3, setQuestion3] = useState('')
  const faviconInputRef = useRef<HTMLInputElement>(null)
  const backgroundInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.getConfig().then((c) => {
      setConfig(c)
      const questions = c.recommended_questions || []
      setQuestion1(questions[0] || '')
      setQuestion2(questions[1] || '')
      setQuestion3(questions[2] || '')
    }).catch(console.error)
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      const questions = [question1.trim(), question2.trim(), question3.trim()].filter(Boolean)
      // Soft limit: each question must be ≤20 chars
      if (questions.some((q) => q.length > 20)) {
        toast({ title: t('settings.questionTooLong'), variant: 'error' })
        setSaving(false)
        return
      }
      await api.updateConfig({
        app_name: config.app_name,
        app_favicon: config.app_favicon,
        app_background: config.app_background,
        show_github: config.show_github,
        recommended_questions: questions,
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

  if (!config) return <div className="py-8 text-center text-muted-foreground">{t('common.loading')}</div>

  return (
    <div className="space-y-4 pt-4">
      <div>
        <label className="text-sm font-medium">{t('settings.appName')}</label>
        <Input
          value={config.app_name || ''}
          onChange={(e) => setConfig({ ...config, app_name: e.target.value })}
          className="mt-1"
          placeholder="Momoi"
        />
      </div>
      <div>
        <label className="text-sm font-medium">{t('settings.appFavicon')}</label>
        <div className="flex items-center gap-4 mt-1">
          {config.app_favicon ? (
            <img src={config.app_favicon} alt="favicon" className="h-8 w-8 rounded" />
          ) : (
            <div className="h-8 w-8 rounded bg-muted flex items-center justify-center text-xs">默认</div>
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
            <div className="h-12 w-12 rounded bg-muted flex items-center justify-center text-xs">无</div>
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
        <div className="space-y-2 mt-1">
          {([question1, question2, question3] as const).map((val, i) => (
            <div className="relative" key={i}>
              <Input
                value={val}
                onChange={(e) => {
                  const setter = [setQuestion1, setQuestion2, setQuestion3][i]
                  setter(e.target.value)
                }}
                placeholder={t('settings.questionPlaceholder', { n: i + 1 })}
                className="pr-12"
              />
              <span className={`absolute right-3 top-1/2 -translate-y-1/2 text-xs ${val.length > 20 ? 'text-destructive' : 'text-muted-foreground'}`}>
                {val.length}/20
              </span>
            </div>
          ))}
        </div>
      </div>
      <Button onClick={handleSave} disabled={saving}>{saving ? t('common.saving') : t('common.save')}</Button>
    </div>
  )
}