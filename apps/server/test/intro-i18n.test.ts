/**
 * intro.i18n 三语一致性测试
 *
 * 使用引导（OOBE）的文案完全走 `intro.*`，三语 locale 必须结构平行——
 * 少一个键，某个语言下就会直接渲染出 `intro.pages.world.title` 这种键名。
 * web 侧无测试 runner，借 server 的 vitest 直读 locale JSON 把关
 * （与 error-registry-i18n.test.ts 同一模式）。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const I18N_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'web', 'src', 'i18n')
const LOCALES = ['zh-CN', 'en', 'ja'] as const

/** 引导页目顺序（与 IntroductionDialog 的 PAGES 一致；增删页时更新此基线） */
const PAGE_KEYS = [
  'welcome', 'chat', 'world', 'workspace', 'memory', 'voice', 'im', 'companion', 'finale',
]

function loadIntro(locale: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(I18N_DIR, `${locale}.json`), 'utf8'))
  const intro = (raw as Record<string, unknown>).intro
  expect(typeof intro, `${locale} 缺少 intro 段`).toBe('object')
  return intro as Record<string, unknown>
}

/** 递归展平成 `a.b.c` 键路径集合 */
function keyPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix]
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    keyPaths(v, prefix ? `${prefix}.${k}` : k),
  )
}

const PLACEHOLDERS = (tpl: string): string[] =>
  [...tpl.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()

describe('intro 段 ↔ 三语 locale 一致性', () => {
  it('页目基线符合预期（增删引导页时更新 PAGE_KEYS）', () => {
    for (const locale of LOCALES) {
      const pages = loadIntro(locale).pages as Record<string, unknown>
      expect(Object.keys(pages), `${locale} 页目与基线不符`).toEqual(PAGE_KEYS)
    }
  })

  it('三语 intro 子树键集合完全相同', () => {
    const [base, ...rest] = LOCALES.map((l) => keyPaths(loadIntro(l)).sort())
    for (let i = 0; i < rest.length; i++) {
      expect(rest[i], `${LOCALES[i + 1]} 与 ${LOCALES[0]} 的 intro 键不一致`).toEqual(base)
    }
  })

  it('每页 title / body 均非空', () => {
    for (const locale of LOCALES) {
      const pages = loadIntro(locale).pages as Record<string, { title: string; body: string }>
      for (const key of PAGE_KEYS) {
        expect(pages[key]?.title?.length, `${locale} ${key}.title 为空`).toBeGreaterThan(0)
        expect(pages[key]?.body?.length, `${locale} ${key}.body 为空`).toBeGreaterThan(0)
      }
    }
  })

  it('各语言同一键的 {{占位符}} 一致（防插值丢参）', () => {
    const [baseLocale, ...others] = LOCALES
    const base = loadIntro(baseLocale)
    for (const locale of others) {
      const intro = loadIntro(locale)
      for (const path of keyPaths(base)) {
        const pick = (o: Record<string, unknown>) =>
          path.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], o)
        const a = pick(base)
        const b = pick(intro)
        if (typeof a === 'string' && typeof b === 'string') {
          expect(PLACEHOLDERS(b), `${locale} 的 intro.${path} 占位符不一致`).toEqual(PLACEHOLDERS(a))
        }
      }
    }
  })
})
