/**
 * 注册表 ↔ i18n 一致性测试
 *
 * 错误码契约要求：每个 ErrCode 在三语 locale 的 errors 段都有对应键
 * （前端 errT 按 errors.<code> 直查），en 模板的 {{param}} 占位符与
 * ERR_REGISTRY 声明的 params 名单一致。web 无测试 runner，借 server 的
 * vitest 直读 locale JSON 把关。
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

import { ERR_REGISTRY, ErrCode } from '@momoi/shared/errors'

const I18N_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'web', 'src', 'i18n')
const LOCALES = ['zh-CN', 'en', 'ja'] as const

type ErrorsSection = Record<string, string>

function loadErrorsSection(locale: string): ErrorsSection {
  const raw = JSON.parse(readFileSync(join(I18N_DIR, `${locale}.json`), 'utf8'))
  const errors = (raw as Record<string, unknown>).errors
  expect(typeof errors).toBe('object')
  return errors as ErrorsSection
}

const CODES = Object.values(ErrCode)
const PLACEHOLDERS = (tpl: string): string[] =>
  [...tpl.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort()

describe('ErrCode 注册表 ↔ 三语 locale 一致性', () => {
  it('注册表码数符合预期（增删码时更新此基线）', () => {
    expect(CODES.length).toBe(150)
  })

  for (const locale of LOCALES) {
    it(`${locale}：每个 ErrCode 都有 errors.<code> 键`, () => {
      const errors = loadErrorsSection(locale)
      for (const code of CODES) {
        expect(errors, `${locale} 缺少 errors.${code}`).toHaveProperty(code)
        expect(typeof errors[code]).toBe('string')
        expect((errors[code] as string).length).toBeGreaterThan(0)
      }
    })

    it(`${locale}：errors 段无注册表之外的键（防拼写错键；__unknown 豁免）`, () => {
      const errors = loadErrorsSection(locale)
      const codeSet = new Set<string>(CODES)
      for (const key of Object.keys(errors)) {
        if (key === '__unknown') continue
        expect(codeSet.has(key), `${locale} 多出未知键 errors.${key}`).toBe(true)
      }
    })
  }

  it('en 模板 {{param}} 占位符与 ERR_REGISTRY params 名单完全一致', () => {
    const errors = loadErrorsSection('en')
    for (const code of CODES) {
      const declared = [...(ERR_REGISTRY[code].params ?? [])].sort()
      expect(PLACEHOLDERS(errors[code]!), `${code} 模板占位符与注册表不符`).toEqual(declared)
    }
  })

  it('兜底键 __unknown 存在于三语且仅插值 code', () => {
    for (const locale of LOCALES) {
      const errors = loadErrorsSection(locale)
      expect(errors).toHaveProperty('__unknown')
      expect(PLACEHOLDERS(errors.__unknown!)).toEqual(['code'])
    }
  })
})
