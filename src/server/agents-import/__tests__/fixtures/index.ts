import AdmZip from 'adm-zip'

// 全部为占位文本，不含任何真实人格内容。

export const PLACEHOLDER_PROMPT_ALPHA = 'PLACEHOLDER PROMPT ALPHA'
export const PLACEHOLDER_PROMPT_BETA = 'PLACEHOLDER PROMPT BETA'
export const PLACEHOLDER_PROMPT_GAMMA = 'PLACEHOLDER PROMPT GAMMA'
export const PLACEHOLDER_SKILL_BODY = 'PLACEHOLDER SKILL BODY'

/** 占位 PNG 头字节（仅用于验证扩展名 → MIME 映射） */
export const FAKE_PNG = Buffer.from('89504e470d0a1a0a', 'hex')

export const SKILL_MD = `---
name: placeholder-skill
description: 占位技能描述
---

${PLACEHOLDER_SKILL_BODY}
`

export const PLUGIN_BASE = {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  name: 'placeholder-plugin',
  version: '1.0.0',
  description: '占位描述',
  license: 'Proprietary',
}

export const ALPHA_PERSONA = {
  id: 'alpha',
  name: '占位人格甲',
  primary: 'skills/placeholder-skill/personas/alpha.md',
  avatar: 'skills/placeholder-skill/personas/alpha.png',
  levels: {
    default: ['skills/placeholder-skill/personas/alpha.md'],
    // 档位文件必须存在于包内（协议 §7 / aip validate 验证门）
    extended: ['skills/placeholder-skill/personas/alpha.md', 'skills/placeholder-skill/references/notes.txt'],
  },
}

export const BETA_PERSONA = {
  id: 'beta',
  name: '占位人格乙',
  primary: 'skills/placeholder-skill/personas/beta.md',
}

export function buildZip(files: Record<string, string | Buffer>): Buffer {
  const zip = new AdmZip()
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'))
  }
  return zip.toBuffer()
}

/** 构造含路径穿越条目的 zip（AdmZip.addFile 会规范化，故先写入再改写条目名） */
export function buildTraversalZip(): Buffer {
  const zip = new AdmZip()
  zip.addFile('agents/alpha.md', Buffer.from('---\nname: 占位人格\n---\n\nPLACEHOLDER', 'utf-8'))
  zip.getEntries()[0].entryName = '../../evil.md'
  return zip.toBuffer()
}

export function pluginJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...PLUGIN_BASE, ...overrides })
}

export function extensionManifest(personas: unknown[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    formatVersion: 1,
    namespace: 'xrl.momoi',
    host: 'placeholder-host',
    source: { skill: 'placeholder-skill' },
    personas,
    ...overrides,
  })
}

export interface ExtensionPackageOverrides {
  plugin?: Record<string, unknown>
  manifest?: Record<string, unknown>
  files?: Record<string, string | Buffer>
}

/** 扩展形态完整包：plugin.json + 扩展清单 + 源技能目录 + 双人格 + 头像 */
export function extensionPackage(overrides: ExtensionPackageOverrides = {}): Buffer {
  const personas = (overrides.manifest?.personas as unknown[] | undefined) ?? [ALPHA_PERSONA, BETA_PERSONA]
  return buildZip({
    'plugin.json': pluginJson({
      extensions: { 'xrl.momoi': { formatVersion: 1, manifest: './xrl.momoi/plugin.json' } },
      ...overrides.plugin,
    }),
    'xrl.momoi/plugin.json': extensionManifest(personas, overrides.manifest),
    'skills/placeholder-skill/SKILL.md': SKILL_MD,
    'skills/placeholder-skill/personas/alpha.md': PLACEHOLDER_PROMPT_ALPHA,
    'skills/placeholder-skill/personas/beta.md': PLACEHOLDER_PROMPT_BETA,
    'skills/placeholder-skill/personas/alpha.png': FAKE_PNG,
    'skills/placeholder-skill/references/notes.txt': 'placeholder notes',
    ...overrides.files,
  })
}

/** 通用形态包：仅 plugin.json + agents/*.md（无扩展清单） */
export function universalPackage(files: Record<string, string | Buffer> = {}): Buffer {
  return buildZip({
    'plugin.json': pluginJson(),
    'agents/gamma.md': `---
name: 占位人格丙
description: 占位描述
---

${PLACEHOLDER_PROMPT_GAMMA}
`,
    'agents/gamma.png': FAKE_PNG,
    ...files,
  })
}
