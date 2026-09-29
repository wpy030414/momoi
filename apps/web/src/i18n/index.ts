import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { isApiError } from '../lib/apiError'

// Load the default locale eagerly (zh-CN is the most common for this app).
// en and ja are loaded on demand when the user switches language,
// saving ~47 KB raw (~14 KB gzip) from the initial bundle.
import zhCN from './zh-CN.json'

// Statically-enumerated lazy loaders (one chunk per locale).
// import.meta.glob is analyzable by Vite, unlike `import(`./${lng}.json`)`
// which vite:dynamic-import-vars cannot resolve for the importing file's own
// directory. zh-CN is excluded — it is already bundled eagerly above.
const localeLoaders = import.meta.glob(['./*.json', '!./zh-CN.json'])

i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
  },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: {
    escapeValue: false,
  },
})

// Preload trigger: called from the language switcher before changeLanguage
// Also handles the initial-load case where a saved locale differs from zh-CN.
export async function ensureLocale(lng: string): Promise<void> {
  if (lng === 'zh-CN') return // already bundled eagerly
  if (!i18n.hasResourceBundle(lng, 'translation')) {
    const loader = localeLoaders[`./${lng}.json`]
    if (loader) {
      const mod = (await loader()) as { default?: Record<string, unknown> }
      i18n.addResourceBundle(lng, 'translation', (mod as any).default ?? mod)
    }
  }
}

export default i18n

// ---- error translator (errT) ----

/**
 * 将 ApiError（或裸 Error）本地化为用户文案。
 *
 * code 即契约：直接查 errors.<CODE>（params 供 {{param}} 插值）；
 * 未知 code（比本地注册表新/旧、或非 JSON 兜底）回退到 errors.__unknown。
 * 取代旧 st() 的英文句子反向匹配——中文后端消息与动态消息不再漏翻。
 */
export function errT(e: unknown): string {
  if (!isApiError(e)) return e instanceof Error ? e.message : String(e)
  const key = `errors.${e.code}`
  if (i18n.exists(key)) return i18n.t(key, e.params ?? {})
  return i18n.t('errors.__unknown', { code: e.code })
}