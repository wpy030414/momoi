import fs from 'fs'
import os from 'os'
import path from 'path'
import AdmZip from 'adm-zip'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// 上传端点只落盘 skills/，不碰数据库：mock 掉 db 连接，测试目录才可完整清理
// （libsql 的文件句柄在 Windows 上要到进程退出才释放）
vi.mock('../../db.js', () => ({ db: {} as never }))

// 真实路由 + 临时 cwd：上传端点按 path.resolve('skills') 落盘，必须在临时目录里跑
const originalCwd = process.cwd()
let workDir = ''
let adminRoute: (typeof import('../../routes/admin.js'))['adminRoute']
let skillRegistry: (typeof import('../../skills/loader.js'))['skillRegistry']
let token = ''

function buildZip(entries: Record<string, string>): Buffer {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content, 'utf-8'))
  }
  return zip.toBuffer()
}

async function uploadZip(zip: Buffer) {
  const form = new FormData()
  form.append('file', new File([new Uint8Array(zip)], 'skill.zip', { type: 'application/zip' }))
  const res = await adminRoute.request('/skills/upload', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  })
  return { status: res.status, body: (await res.json()) as { error?: string; success?: boolean } }
}

async function upload(entries: Record<string, string>) {
  return uploadZip(buildZip(entries))
}

function skillsDir(): string {
  return path.join(workDir, 'skills')
}

/** 上传失败后遗留的临时目录 */
function uploadTmpResidue(): string[] {
  return fs.existsSync(skillsDir()) ? fs.readdirSync(skillsDir()).filter((n) => n.startsWith('__upload_tmp_')) : []
}

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momoi-upload-route-'))
  process.chdir(workDir)
  const admin = await import('../../routes/admin.js')
  const auth = await import('../../auth.js')
  const loader = await import('../../skills/loader.js')
  adminRoute = admin.adminRoute
  skillRegistry = loader.skillRegistry
  token = (await auth.signAdminToken()).token
})

afterAll(() => {
  process.chdir(originalCwd)
  fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

describe('POST /skills/upload — zip 条目安全', () => {
  it('含 ":"（NTFS 备用数据流）的条目 → 400，解压前整包拒绝且不落盘', async () => {
    const res = await upload({
      'SKILL.md': '---\nname: ads-probe\ndescription: probe\n---\n\nbody',
      'evil:ads.txt': 'ADS PAYLOAD',
    })

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('unsafe entry name')
    expect(res.body.error).toContain('evil:ads.txt')
    // 未解压：目标技能目录与 ADS 均不存在
    expect(fs.existsSync(path.join(skillsDir(), 'ads-probe'))).toBe(false)
    expect(uploadTmpResidue()).toEqual([])
  })

  it('路径穿越条目 → 400（原有语义不变）', async () => {
    const zip = new AdmZip()
    zip.addFile('SKILL.md', Buffer.from('---\nname: slip-probe\n---\n\nbody', 'utf-8'))
    zip.getEntries()[0].entryName = '../../evil.md'

    const res = await uploadZip(zip.toBuffer())

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('path traversal')
  })

  it('正常上传 → 200 并安装技能', async () => {
    const res = await upload({ 'SKILL.md': '---\nname: ok-skill\ndescription: ok\n---\n\nbody' })

    expect(res.status).toBe(200)
    expect(fs.existsSync(path.join(skillsDir(), 'ok-skill', 'SKILL.md'))).toBe(true)
    expect(uploadTmpResidue()).toEqual([])
  })
})

describe('POST /skills/upload — 失败路径不残留临时目录', () => {
  it('缺 SKILL.md / 缺 frontmatter / 缺 name / 非法 name → 400 且无 __upload_tmp_* 残留', async () => {
    const cases: Array<[string, Record<string, string>, string]> = [
      ['缺 SKILL.md', { 'readme.txt': 'no skill here' }, 'No valid SKILL.md'],
      ['缺 frontmatter', { 'SKILL.md': 'no frontmatter at all' }, 'missing frontmatter'],
      ['缺 name', { 'SKILL.md': '---\ndescription: probe\n---\n\nbody' }, 'name is required'],
      ['非法 name', { 'SKILL.md': '---\nname: Bad Name\n---\n\nbody' }, 'name must match'],
    ]

    for (const [label, entries, expected] of cases) {
      const res = await upload(entries)
      expect(res.status, label).toBe(400)
      expect(res.body.error, label).toContain(expected)
      expect(uploadTmpResidue(), label).toEqual([])
    }
  })
})

describe('skillRegistry.refresh — 临时目录不注册为技能', () => {
  it('残留的 __upload_tmp_* / import_tmp_* 不会产生 unknown 或临时技能，且合法同名技能不受影响', () => {
    const uploadTmp = path.join(skillsDir(), '__upload_tmp_leftover')
    const installTmp = path.join(skillsDir(), 'import_tmp_leftover')
    const valid = path.join(skillsDir(), 'valid-skill')
    // 名字里含 "import-tmp" 的合法技能：前缀用下划线，故不可能被临时目录过滤误伤
    const lookalike = path.join(skillsDir(), 'import-tmp-demo')
    for (const dir of [uploadTmp, installTmp, valid, lookalike]) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(uploadTmp, 'SKILL.md'), '---\ndescription: nameless\n---\n\nbody')
    fs.writeFileSync(path.join(installTmp, 'SKILL.md'), '---\nname: tmp-skill\n---\n\nbody')
    fs.writeFileSync(path.join(valid, 'SKILL.md'), '---\nname: valid-skill\n---\n\nbody')
    fs.writeFileSync(path.join(lookalike, 'SKILL.md'), '---\nname: import-tmp-demo\n---\n\nbody')

    skillRegistry.refresh()
    const names = skillRegistry.getAll().map((skill) => skill.manifest.name)

    expect(names).toContain('valid-skill')
    expect(names).toContain('import-tmp-demo')
    expect(names).not.toContain('unknown')
    expect(names).not.toContain('tmp-skill')

    for (const dir of [uploadTmp, installTmp, valid, lookalike]) fs.rmSync(dir, { recursive: true, force: true })
    skillRegistry.refresh()
  })
})

describe('DELETE /skills/:name — 路径参数净化', () => {
  it('URL 编码的 ../ 不能删除 skills/ 之外的目录', async () => {
    const victim = path.join(workDir, 'victim')
    fs.mkdirSync(victim, { recursive: true })
    fs.writeFileSync(path.join(victim, 'KEEP.txt'), 'keep')

    const res = await adminRoute.request('/skills/%2E%2E%2Fvictim', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })

    expect(res.status).toBe(400)
    expect(fs.existsSync(path.join(victim, 'KEEP.txt'))).toBe(true)
  })
})
