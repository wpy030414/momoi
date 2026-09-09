import { describe, expect, it } from 'vitest'
import AdmZip from 'adm-zip'
import { findUnsafeZipEntry, hasUnsafeFileName, hasZipSlip } from './zip.js'

/** 构造条目名原样保留的 zip（addFile 会规范化部分名字，故写入后改写条目名） */
function zipWithNames(names: string[]): AdmZip {
  const zip = new AdmZip()
  for (const name of names) zip.addFile(name, Buffer.from('placeholder', 'utf-8'))
  zip.getEntries().forEach((entry, index) => {
    entry.entryName = names[index]
  })
  return zip
}

describe('hasUnsafeFileName', () => {
  it('拒绝 ":"（盘符 / NTFS 备用数据流）与控制字符，放行普通文件名', () => {
    expect(hasUnsafeFileName('evil:ads.txt')).toBe(true)
    expect(hasUnsafeFileName('dir/evil:ads.txt')).toBe(true)
    expect(hasUnsafeFileName('C:/windows')).toBe(true)
    expect(hasUnsafeFileName('evil\u0000.txt')).toBe(true)
    expect(hasUnsafeFileName('notes.md')).toBe(false)
    expect(hasUnsafeFileName('dir/sub/notes.md')).toBe(false)
  })
})

describe('findUnsafeZipEntry', () => {
  it('返回首个不安全条目名：":"（ADS）', () => {
    expect(findUnsafeZipEntry(zipWithNames(['SKILL.md', 'evil:ads.txt']))).toBe('evil:ads.txt')
  })

  it('返回首个不安全条目名：路径穿越', () => {
    expect(findUnsafeZipEntry(zipWithNames(['agents/alpha.md', '../../evil.md']))).toBe('../../evil.md')
  })

  it('返回首个不安全条目名：控制字符', () => {
    expect(findUnsafeZipEntry(zipWithNames(['evil\u0007.txt']))).toBe('evil\u0007.txt')
  })

  it('全部条目安全时返回 null', () => {
    expect(findUnsafeZipEntry(zipWithNames(['SKILL.md', 'references/notes.txt']))).toBeNull()
  })

  it('与 hasZipSlip 的分工：hasZipSlip 只管穿越，":" 由 findUnsafeZipEntry 覆盖', () => {
    expect(hasZipSlip(zipWithNames(['evil:ads.txt']))).toBe(false)
    expect(findUnsafeZipEntry(zipWithNames(['evil:ads.txt']))).toBe('evil:ads.txt')
  })
})
