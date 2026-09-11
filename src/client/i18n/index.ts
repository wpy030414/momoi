import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import zhCN from './zh-CN.json'
import en from './en.json'

i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: zhCN },
    en: { translation: en },
  },
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  interpolation: {
    escapeValue: false,
  },
})

export default i18n

// ---- server-side message translator (st) ----

/**
 * Translate a server-side message (error, tool result, etc.) through the
 * serverSide.* i18n namespace.
 *
 * Works by building a reverse map from the English locale values back to their
 * dotted keys (e.g. "Cannot ban yourself" → "serverSide.admin.cannotBanYourself").
 * Then `st(msg)` looks up the key and calls `t(key, params)` in the current locale.
 *
 * If no mapping is found the original English message is returned as-is.
 */
export function st(msg: string): string {
  if (typeof window === 'undefined') return msg
  try {
    if (!_reverseMap) _reverseMap = buildReverseMap()

    // Try exact match
    const key = _reverseMap.get(msg)
    if (key) {
      const translated = i18n.t(key)
      if (translated !== key) return translated
    }

    // Try pattern keys (contain {{...}} interpolation markers)
    if (_patternKeys) {
      for (const [pattern, key] of _patternKeys) {
        const m = msg.match(pattern)
        if (m) {
          const params: Record<string, string> = {}
          const idxMap = _patternParamNames!.get(key)
          for (let i = 1; i < m.length; i++) {
            const name = idxMap?.get(i - 1)
            if (name) params[name] = m[i]
          }
          if (i18n.language === 'zh-CN') {
            return i18n.t(key, params)
          }
          // For English, interpolate the raw pattern template
          const enTpl = i18n.t(key, { lng: 'en' })
          return enTpl.replace(/\{\{(\w+)\}\}/g, (_: string, name: string) => params[name] ?? `{{${name}}}`)
        }
      }
    }
    return msg
  } catch {
    return msg
  }
}

// ---- internal helpers ----

let _reverseMap: Map<string, string> | null = null
let _patternKeys: Array<[RegExp, string]> | null = null
let _patternParamNames: Map<string, Map<number, string>> | null = null

function buildReverseMap(): Map<string, string> {
  const map = new Map<string, string>()
  _patternKeys = []
  _patternParamNames = new Map()
  const raw = i18n.getDataByLanguage('en')
  const serverSide = raw?.translation?.serverSide
  if (!serverSide) return map
  walkServerSide(serverSide, 'serverSide', map)
  return map
}

function walkServerSide(obj: any, prefix: string, map: Map<string, string>) {
  for (const k of Object.keys(obj)) {
    const v = obj[k]
    if (typeof v === 'string') {
      const key = `${prefix}.${k}`
      map.set(v, key)
      if (v.includes('{{')) {
        const paramNames = [...v.matchAll(/\{\{(\w+)\}\}/g)].map(m => m[1])
        const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const regex = new RegExp('^' + escaped.replace(/\\\{\\\{(\w+)\\\}\\\}/g, '(.+)') + '$')
        _patternKeys!.push([regex, key])
        const idxMap = new Map<number, string>()
        paramNames.forEach((name, i) => idxMap.set(i, name))
        _patternParamNames!.set(key, idxMap)
      }
    } else if (typeof v === 'object' && v !== null) {
      walkServerSide(v, `${prefix}.${k}`, map)
    }
  }
}