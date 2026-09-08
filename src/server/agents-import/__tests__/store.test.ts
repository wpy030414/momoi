import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashFileTree, parseAgentPackage } from '../parser.js'
import {
  IMPORT_TTL_MS,
  deleteStagedImport,
  getStagedImport,
  hashSkillDir,
  installSkillTree,
  resetImportStore,
  stageImport,
} from '../store.js'
import { extensionPackage } from './fixtures/index.js'

function parseFixture() {
  const result = parseAgentPackage(extensionPackage())
  if (!result.ok) throw new Error(`fixture should parse: ${result.error}`)
  return result.data
}

describe('import staging store', () => {
  beforeEach(() => resetImportStore())
  afterEach(() => resetImportStore())

  it('暂存 → 读取 → 删除', () => {
    const data = parseFixture()
    const id = stageImport(data, 1_000)

    const lookup = getStagedImport(id, 2_000)
    expect(lookup.state).toBe('ok')
    if (lookup.state !== 'ok') return
    expect(lookup.data.package.name).toBe('placeholder-plugin')

    deleteStagedImport(id)
    expect(getStagedImport(id, 2_000).state).toBe('missing')
  })

  it('TTL 24h：过期返回 expired，未知 id 返回 missing', () => {
    const id = stageImport(parseFixture(), 1_000)
    expect(getStagedImport(id, 1_000 + IMPORT_TTL_MS - 1).state).toBe('ok')
    expect(getStagedImport(id, 1_000 + IMPORT_TTL_MS).state).toBe('expired')
    expect(getStagedImport('never-staged', 1_000).state).toBe('missing')
  })
})

describe('installSkillTree', () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'momoi-skill-install-'))
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('写入文件树；默认不覆盖既有同名技能，显式 overwrite 才替换', () => {
    const files = parseFixture().skills[0].files

    const first = installSkillTree(root, 'placeholder-skill', files, false)
    expect(first).toEqual({ ok: true, outcome: 'installed' })
    expect(fs.existsSync(path.join(root, 'placeholder-skill', 'SKILL.md'))).toBe(true)

    const second = installSkillTree(root, 'placeholder-skill', files, false)
    expect(second).toEqual({ ok: false, error: 'skill is already installed' })

    const overwrite = installSkillTree(root, 'placeholder-skill', files, true)
    expect(overwrite).toEqual({ ok: true, outcome: 'overwritten' })
  })

  it('技能文件路径含 ":"（NTFS 备用数据流）被拒绝，不落盘', () => {
    const result = installSkillTree(
      root,
      'placeholder-skill',
      [{ path: 'personas/evil:ads.txt', data: Buffer.from('placeholder', 'utf-8') }],
      true,
    )
    expect(result).toEqual({ ok: false, error: expect.stringContaining('alternate data stream') })
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('恶意技能名被拒绝，且不在 skills 目录之外写入', () => {
    const files = parseFixture().skills[0].files
    for (const name of ['..', '../evil', 'a/b', 'A-Upper', 'con:name']) {
      const result = installSkillTree(root, name, files, true)
      expect(result.ok).toBe(false)
    }
    expect(fs.readdirSync(root)).toEqual([])
  })
})

describe('hashSkillDir', () => {
  it('与 zip 侧 hashFileTree 口径一致（同一文件树哈希相同）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momoi-skill-hash-'))
    try {
      const skill = parseFixture().skills[0]
      const written = installSkillTree(root, skill.name, skill.files, false)
      expect(written.ok).toBe(true)
      expect(hashSkillDir(path.join(root, skill.name))).toBe(skill.contentHash)
      expect(hashSkillDir(path.join(root, skill.name))).toBe(hashFileTree(skill.files))
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
