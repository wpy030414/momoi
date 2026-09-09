import fs from 'fs'
import path from 'path'
import type { SkillManifest, InstalledSkill } from '../../shared/types.js'

const SKILLS_DIR = path.resolve('skills')

interface Frontmatter {
  name: string
  description: string
  version?: string
}

function parseFrontmatter(content: string): { frontmatter: Frontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) {
    return { frontmatter: { name: 'unknown', description: '' }, body: content }
  }

  const yamlStr = match[1]
  const body = match[2].trim()

  // YAML 解析：支持扁平 key: value，以及折叠/字面块标量（description: > 多行正文）
  const frontmatter: Record<string, string> = {}
  let currentKey: string | null = null
  let multiline: 'fold' | 'literal' | null = null

  for (const raw of yamlStr.split('\n')) {
    const m = raw.match(/^([\w-]+):\s*(.*)$/)
    if (m) {
      // 新 key
      currentKey = m[1]
      const trimmed = m[2].trim()
      if (trimmed.startsWith('>')) {
        multiline = 'fold' // 折叠：后续缩进行用空格连接
        frontmatter[currentKey] = ''
      } else if (trimmed.startsWith('|')) {
        multiline = 'literal' // 字面块：保留换行
        frontmatter[currentKey] = ''
      } else {
        multiline = null
        frontmatter[currentKey] = trimmed.replace(/^['"]|['"]$/g, '')
      }
      continue
    }
    // 折叠/字面块的续行
    if (currentKey && multiline) {
      const text = raw.trim()
      if (!text) continue
      frontmatter[currentKey] +=
        (frontmatter[currentKey] ? (multiline === 'fold' ? ' ' : '\n') : '') + text
    }
  }

  return {
    frontmatter: {
      name: frontmatter.name || 'unknown',
      description: frontmatter.description || '',
      version: frontmatter.version,
    },
    body,
  }
}

function loadSkill(skillDir: string): InstalledSkill | null {
  const skillPath = path.join(skillDir, 'SKILL.md')
  if (!fs.existsSync(skillPath)) return null

  try {
    const raw = fs.readFileSync(skillPath, 'utf-8')
    const { frontmatter, body } = parseFrontmatter(raw)

    return {
      manifest: {
        name: frontmatter.name,
        description: frontmatter.description,
        version: frontmatter.version,
      },
      content: body,
      path: skillDir,
    }
  } catch (err) {
    console.error(`Failed to load skill from ${skillDir}:`, err)
    return null
  }
}

function scanSkillsDir(): InstalledSkill[] {
  if (!fs.existsSync(SKILLS_DIR)) {
    fs.mkdirSync(SKILLS_DIR, { recursive: true })
    return []
  }

  const skills: InstalledSkill[] = []

  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    // 若本目录含 SKILL.md，登记为技能；无论是否登记，都继续下钻子目录，
    // 以便聚合技能（如 yida-skills 下的 openyida）的嵌套子技能（yida-login 等）也收进来。
    const hasOwnSkill = entries.some((e) => e.isFile() && e.name === 'SKILL.md')
    if (hasOwnSkill) {
      const skill = loadSkill(dir)
      if (skill) skills.push(skill)
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      walk(path.join(dir, entry.name))
    }
  }

  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    walk(path.join(SKILLS_DIR, entry.name))
  }
  return skills
}

class SkillRegistryClass {
  private skills: Map<string, InstalledSkill> = new Map()

  constructor() {
    this.refresh()
  }

  refresh(): void {
    this.skills.clear()
    for (const skill of scanSkillsDir()) {
      this.skills.set(skill.manifest.name, skill)
    }
  }

  get(name: string): InstalledSkill | undefined {
    return this.skills.get(name)
  }

  getAll(): InstalledSkill[] {
    return [...this.skills.values()]
  }

  remove(name: string): boolean {
    return this.skills.delete(name)
  }
}

export const skillRegistry = new SkillRegistryClass()
