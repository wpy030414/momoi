import { createHash } from 'crypto'
import AdmZip from 'adm-zip'
import { hasUnsafeFileName, hasZipSlip, resolveZipRoot, sanitizeSkillName } from '../lib/zip.js'
import { DEFAULT_AGENT_MODEL, NEUTRAL_AGENT_ID, NEUTRAL_AGENT_NAME } from '../../shared/constants.js'
import type { Agent, AgentOrigin } from '../../shared/types.js'
import type {
  AipPackageInfo,
  CommitDecisions,
  CommitPlan,
  ConflictReport,
  InstalledSkillHash,
  ParseResult,
  ParsedPackage,
  PersonaCandidate,
  PersonaConflictEntry,
  PersonaPlanItem,
  SkillCandidate,
  SkillConflictEntry,
  SkillFileEntry,
  SkillPlanItem,
} from './types.js'

const PERSONA_ID_PATTERN = /^[a-z0-9-]+$/
const MAX_AVATAR_BYTES = 5 * 1024 * 1024
const EXTENSION_NAMESPACE = 'xrl.momoi'
const EXTENSION_MANIFEST = 'xrl.momoi/plugin.json'

// ---- 资源预算（zip 是不可信输入，解压前先用元数据设限） ----

/** 条目数上限（EOCD 声明值超限时在构造 AdmZip 之前即拒绝） */
const MAX_ZIP_ENTRIES = 10_000
/** 单条目解压后字节上限 */
const MAX_ENTRY_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
/** 整包解压后字节上限 */
const MAX_TOTAL_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
/** 整包压缩比上限（解压后 / 压缩后） */
const MAX_COMPRESSION_RATIO = 100
/** 单包 persona 数量上限（头像暂存放大防护） */
const MAX_PERSONAS = 500
/** 单包头像原始字节总量上限（按引用去重后累计） */
const MAX_PACKAGE_AVATAR_BYTES = 32 * 1024 * 1024

/** 保留显示名比对用的归一化：大小写、全半角、内部空白差异一律视为等价 */
function normalizeDisplayName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase()
}

const RESERVED_NEUTRAL_DISPLAY_NAME = normalizeDisplayName(NEUTRAL_AGENT_NAME)

/** 显示名是否撞上宿主保留的中立 Agent 名（归一化后比较） */
function isReservedNeutralName(name: string): boolean {
  return normalizeDisplayName(name) === RESERVED_NEUTRAL_DISPLAY_NAME
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
}

// ---- 基础工具 ----

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function normalizeEntryName(name: string): string {
  return name.replace(/\\/g, '/')
}

/** 去掉 ./ 前缀后的插件根相对路径 */
function normalizePackagePath(ref: string): string {
  return normalizeEntryName(ref).replace(/^\.\//, '')
}

/** 引用是否位于插件根内（不含 .. / 绝对路径 / 盘符 / 控制字符） */
function isInsidePackageRoot(ref: string): boolean {
  if (typeof ref !== 'string' || ref.length === 0) return false
  if (hasControlChars(ref)) return false
  const normalized = normalizePackagePath(ref)
  if (normalized.startsWith('/')) return false
  if (/^[a-zA-Z]:/.test(normalized)) return false
  const segments = normalized.split('/')
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}

/** 解析包内引用；越界或不存在返回 null */
function resolvePackagePath(files: Map<string, Buffer>, ref: string): Buffer | null {
  if (!isInsidePackageRoot(ref)) return null
  return files.get(normalizePackagePath(ref)) ?? null
}

/** EOCD 签名与固定长度：仅靠中心目录元数据即可在解压前拿到条目数 */
const EOCD_SIGNATURE = 0x06054b50
const EOCD_MIN_LENGTH = 22
const EOCD_MAX_COMMENT_LENGTH = 0xffff

/**
 * 从原始字节中读 EOCD 声明的中心目录条目数（不构造 AdmZip，避免大条目数包的目录解析开销）。
 * 校验注释长度与文件尾对齐，排除压缩数据里的签名误命中；非标准/zip64 结构返回 null 由调用方兜底。
 */
function readDeclaredEntryCount(buffer: Buffer): number | null {
  if (buffer.length < EOCD_MIN_LENGTH) return null
  const start = Math.max(0, buffer.length - EOCD_MIN_LENGTH - EOCD_MAX_COMMENT_LENGTH)
  for (let i = buffer.length - EOCD_MIN_LENGTH; i >= start; i--) {
    if (buffer.readUInt32LE(i) !== EOCD_SIGNATURE) continue
    const commentLength = buffer.readUInt16LE(i + 20)
    if (i + EOCD_MIN_LENGTH + commentLength !== buffer.length) continue
    return buffer.readUInt16LE(i + 10)
  }
  return null
}

/**
 * 解压前的资源预算检查：条目数、单条/整包解压后大小、压缩比。
 * adm-zip 0.6 的 inflate 以中心目录声明的 size 为输出上限（STORED 条目按实际数据长度分配），
 * 因此用元数据设限即可约束真实解压量，无需先 getData。
 */
function checkZipBudget(zip: AdmZip): string | null {
  const entries = zip.getEntries()
  if (entries.length > MAX_ZIP_ENTRIES) {
    return `Zip has too many entries (${entries.length} > ${MAX_ZIP_ENTRIES})`
  }

  let totalUncompressed = 0
  let totalCompressed = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const size = entry.header.size
    if (size > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      return `Zip entry "${entry.entryName}" exceeds the uncompressed size limit (${MAX_ENTRY_UNCOMPRESSED_BYTES} bytes)`
    }
    totalUncompressed += size
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      return `Zip uncompressed size exceeds the limit (${MAX_TOTAL_UNCOMPRESSED_BYTES} bytes)`
    }
    totalCompressed += entry.header.compressedSize
  }

  if (totalCompressed > 0 && totalUncompressed / totalCompressed > MAX_COMPRESSION_RATIO) {
    return `Zip compression ratio exceeds the limit (${MAX_COMPRESSION_RATIO}:1)`
  }
  return null
}

/** 解包为「插件根相对路径 → 内容」映射（跳过目录与 macOS 垃圾文件） */
function buildFileMap(zip: AdmZip, wrapperDir: string | null): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  const prefix = wrapperDir ? `${wrapperDir}/` : ''
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    let name = normalizeEntryName(entry.entryName)
    if (name.startsWith('__MACOSX') || name.endsWith('.DS_Store')) continue
    if (prefix) {
      if (!name.startsWith(prefix)) continue
      name = name.slice(prefix.length)
    }
    if (!name) continue
    files.set(name, entry.getData())
  }
  return files
}

interface Frontmatter {
  name: string
  description: string
}

/** 极简 YAML 前置元数据解析：扁平 key + 折叠/字面块标量，未知键忽略 */
function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { frontmatter: { name: '', description: '' }, body: raw }

  const fields: Record<string, string> = {}
  let currentKey: string | null = null
  let multiline: 'fold' | 'literal' | null = null

  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([\w-]+):\s*(.*)$/)
    if (m) {
      currentKey = m[1]
      const value = m[2].trim()
      if (value.startsWith('>') || value.startsWith('|')) {
        multiline = value.startsWith('>') ? 'fold' : 'literal'
        fields[currentKey] = ''
      } else {
        multiline = null
        fields[currentKey] = value.replace(/^['"]|['"]$/g, '')
      }
      continue
    }
    if (currentKey && multiline) {
      const text = line.trim()
      if (!text) continue
      fields[currentKey] += (fields[currentKey] ? (multiline === 'fold' ? ' ' : '\n') : '') + text
    }
  }

  return {
    frontmatter: { name: fields.name ?? '', description: fields.description ?? '' },
    body: match[2],
  }
}

/** 单包头像预算：按引用路径去重缓存 dataURL，并累计唯一头像的原始字节 */
interface AvatarBudget {
  cache: Map<string, string | null>
  bytes: number
}

function createAvatarBudget(): AvatarBudget {
  return { cache: new Map(), bytes: 0 }
}

/**
 * 头像文件 → dataURL；缺失/超 5MB/未知格式/超出包级头像预算记 warning 并返回 undefined。
 * 同一引用路径只解码一份，多个 persona 共享头像时复用同一字符串，避免暂存放大。
 */
function readAvatar(
  files: Map<string, Buffer>,
  ref: string,
  warnings: string[],
  label: string,
  budget: AvatarBudget,
): string | undefined {
  const key = normalizePackagePath(ref)
  const cached = budget.cache.get(key)
  if (cached !== undefined) return cached ?? undefined

  const skip = (message: string): undefined => {
    warnings.push(`${label}: ${message}`)
    budget.cache.set(key, null)
    return undefined
  }

  const data = resolvePackagePath(files, ref)
  if (!data) return skip(`avatar file not found or outside the plugin root (${ref})`)
  if (data.length > MAX_AVATAR_BYTES) return skip('avatar exceeds 5MB and was skipped')
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase()
  const mime = IMAGE_MIME[ext]
  if (!mime) return skip(`unsupported avatar format (${ref})`)
  if (budget.bytes + data.length > MAX_PACKAGE_AVATAR_BYTES) {
    return skip(`package avatar budget (${MAX_PACKAGE_AVATAR_BYTES} bytes) exceeded and the avatar was skipped`)
  }

  budget.bytes += data.length
  const dataUrl = `data:${mime};base64,${data.toString('base64')}`
  budget.cache.set(key, dataUrl)
  return dataUrl
}

// ---- 扩展清单发现 ----

type ManifestLookup = { ref: string | null } | { error: string }

function findExtensionManifest(plugin: Record<string, unknown>, files: Map<string, Buffer>): ManifestLookup {
  const extensions = isPlainObject(plugin.extensions) ? plugin.extensions : undefined
  const extValue = extensions?.[EXTENSION_NAMESPACE]

  if (extValue !== undefined) {
    if (!isPlainObject(extValue)) {
      return { error: 'Invalid plugin.json: extensions["xrl.momoi"] must be an object' }
    }
    const declared = extValue.manifest
    if (declared !== undefined && typeof declared !== 'string') {
      return { error: 'Invalid plugin.json: extension manifest must be a string' }
    }
    const ref = declared ?? EXTENSION_MANIFEST
    if (!isInsidePackageRoot(ref)) {
      return { error: 'Extension manifest path escapes the plugin root' }
    }
    const normalized = normalizePackagePath(ref)
    if (!files.has(normalized)) {
      return { error: `Extension manifest not found: ${normalized}` }
    }
    return { ref: normalized }
  }

  if (files.has(EXTENSION_MANIFEST)) return { ref: EXTENSION_MANIFEST }
  return { ref: null }
}

/** 扩展形态：清单校验（formatVersion/namespace/personas）+ 逐 persona 提取 */
function parseExtensionForm(
  files: Map<string, Buffer>,
  manifestRef: string,
  packageInfo: AipPackageInfo,
  warnings: string[],
  errors: string[],
): ParseResult {
  const manifestRaw = files.get(manifestRef)
  if (!manifestRaw) return { ok: false, error: `Extension manifest not found: ${manifestRef}` }

  let manifest: unknown
  try {
    manifest = JSON.parse(manifestRaw.toString('utf-8'))
  } catch {
    return { ok: false, error: 'Invalid extension manifest: not valid JSON' }
  }
  if (!isPlainObject(manifest)) {
    return { ok: false, error: 'Invalid extension manifest: expected a JSON object' }
  }
  if (manifest.formatVersion !== 1) {
    return { ok: false, error: `Unsupported manifest formatVersion: ${String(manifest.formatVersion)}` }
  }
  if (manifest.namespace !== EXTENSION_NAMESPACE) {
    return { ok: false, error: `Invalid extension manifest: namespace must be "${EXTENSION_NAMESPACE}"` }
  }
  if (!Array.isArray(manifest.personas)) {
    return { ok: false, error: 'Invalid extension manifest: personas must be an array' }
  }
  if (typeof manifest.host === 'string' && manifest.host) packageInfo.host = manifest.host
  if (manifest.personas.length > MAX_PERSONAS) {
    return { ok: false, error: `Package declares too many personas (${manifest.personas.length} > ${MAX_PERSONAS})` }
  }

  const candidates: PersonaCandidate[] = []
  const seenIds = new Set<string>()
  const avatarBudget = createAvatarBudget()

  for (const [index, raw] of manifest.personas.entries()) {
    const label = `personas[${index}]`
    if (!isPlainObject(raw)) {
      errors.push(`${label}: must be an object`)
      continue
    }
    const id = typeof raw.id === 'string' ? raw.id : ''
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!PERSONA_ID_PATTERN.test(id)) {
      errors.push(`${label}: id "${id}" must match [a-z0-9-]+`)
      continue
    }
    if (seenIds.has(id)) {
      errors.push(`Persona "${id}": duplicate id`)
      continue
    }
    if (!name) {
      errors.push(`Persona "${id}": name is required`)
      continue
    }
    if (id === NEUTRAL_AGENT_ID || isReservedNeutralName(name)) {
      errors.push(`Persona "${id}": collides with the reserved neutral agent`)
      continue
    }
    if (typeof raw.primary !== 'string' || raw.primary.length === 0) {
      errors.push(`Persona "${id}": primary is required`)
      continue
    }
    const primary = resolvePackagePath(files, raw.primary)
    if (!primary) {
      errors.push(`Persona "${id}": primary file not found or outside the plugin root (${raw.primary})`)
      continue
    }
    seenIds.add(id)

    const avatar =
      typeof raw.avatar === 'string' && raw.avatar
        ? readAvatar(files, raw.avatar, warnings, `Persona "${id}"`, avatarBudget)
        : undefined
    const levelCount = isPlainObject(raw.levels) ? Object.keys(raw.levels).length : 1
    const systemPrompt = primary.toString('utf-8').trim()

    candidates.push({
      id,
      name,
      primaryFile: normalizePackagePath(raw.primary),
      primaryBytes: primary.length,
      systemPrompt,
      avatar,
      levelCount,
    })

    // 共存形态：同一 id 的通用层文件正文须与清单 primary 一致
    const universal = files.get(`agents/${id}.md`)
    if (universal) {
      const { body } = parseFrontmatter(universal.toString('utf-8'))
      if (body.trim() !== systemPrompt) {
        warnings.push(`Persona "${id}": agents/${id}.md differs from the manifest primary`)
      }
    }
  }

  return {
    ok: true,
    data: { package: packageInfo, candidates, skills: discoverSkills(files, errors), warnings, errors },
  }
}

// ---- 通用层发现（agents/*.md） ----

function findUniversalAvatar(files: Map<string, Buffer>, id: string): string | undefined {
  for (const ext of Object.keys(IMAGE_MIME)) {
    const ref = `agents/${id}.${ext}`
    if (files.has(ref)) return ref
  }
  return undefined
}

function parseUniversalForm(
  files: Map<string, Buffer>,
  packageInfo: AipPackageInfo,
  warnings: string[],
  errors: string[],
): ParseResult {
  const ids = [...files.keys()]
    .map((path) => path.match(/^agents\/([^/]+)\.md$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => match[1])
    .sort()

  if (ids.length === 0) return { ok: false, error: 'Not an agent import package' }
  if (ids.length > MAX_PERSONAS) {
    return { ok: false, error: `Package declares too many personas (${ids.length} > ${MAX_PERSONAS})` }
  }

  const candidates: PersonaCandidate[] = []
  const seenIds = new Set<string>()
  const avatarBudget = createAvatarBudget()

  for (const id of ids) {
    const label = `agents/${id}.md`
    if (!PERSONA_ID_PATTERN.test(id)) {
      errors.push(`${label}: id must match [a-z0-9-]+`)
      continue
    }
    if (seenIds.has(id)) continue
    const raw = files.get(label)
    if (!raw) continue

    const { frontmatter, body } = parseFrontmatter(raw.toString('utf-8'))
    const name = frontmatter.name.trim()
    if (!name) {
      errors.push(`${label}: frontmatter name is required`)
      continue
    }
    if (id === NEUTRAL_AGENT_ID || isReservedNeutralName(name)) {
      errors.push(`Persona "${id}": collides with the reserved neutral agent`)
      continue
    }
    seenIds.add(id)

    const avatarRef = findUniversalAvatar(files, id)
    candidates.push({
      id,
      name,
      primaryFile: label,
      primaryBytes: raw.length,
      systemPrompt: body.trim(),
      avatar: avatarRef ? readAvatar(files, avatarRef, warnings, `Persona "${id}"`, avatarBudget) : undefined,
      levelCount: 1,
    })
  }

  return {
    ok: true,
    data: { package: packageInfo, candidates, skills: discoverSkills(files, errors), warnings, errors },
  }
}

// ---- 技能发现 ----

function discoverSkills(files: Map<string, Buffer>, errors: string[]): SkillCandidate[] {
  const dirs = new Set<string>()
  for (const path of files.keys()) {
    const match = path.match(/^skills\/([^/]+)\/SKILL\.md$/)
    if (match) dirs.add(match[1])
  }

  const skills: SkillCandidate[] = []
  const seenNames = new Set<string>()

  for (const dir of [...dirs].sort()) {
    const skillMd = files.get(`skills/${dir}/SKILL.md`)
    if (!skillMd) continue

    const { frontmatter } = parseFrontmatter(skillMd.toString('utf-8'))
    const rawName = frontmatter.name.trim()
    if (!rawName) {
      errors.push(`skills/${dir}: SKILL.md frontmatter name is required`)
      continue
    }
    const sanitized = sanitizeSkillName(rawName)
    if (!sanitized.ok) {
      errors.push(`skills/${dir}: ${sanitized.error}`)
      continue
    }
    if (seenNames.has(sanitized.name)) {
      errors.push(`skills/${dir}: duplicate skill name "${sanitized.name}"`)
      continue
    }
    seenNames.add(sanitized.name)

    const prefix = `skills/${dir}/`
    const entries: SkillFileEntry[] = []
    let unsafe = false
    for (const [path, data] of files) {
      if (!path.startsWith(prefix)) continue
      const rel = path.slice(prefix.length)
      if (!rel || rel.startsWith('__MACOSX') || rel.endsWith('.DS_Store')) continue
      const segments = rel.split('/')
      // 控制字符与 ':'（盘符 / NTFS 备用数据流）由共享谓词判定，与 sanitizeSkillName 语义一致
      if (hasUnsafeFileName(rel) || segments.some((s) => s === '' || s === '.' || s === '..')) {
        errors.push(`skills/${dir}: unsafe file path "${rel}" was skipped`)
        unsafe = true
        continue
      }
      entries.push({ path: rel, data })
    }
    if (unsafe && entries.length === 0) continue

    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    skills.push({
      name: sanitized.name,
      description: frontmatter.description.trim(),
      files: entries,
      contentHash: hashFileTree(entries),
    })
  }

  return skills
}

/** 文件树哈希：排序后按 路径 + 长度 + 内容 累计 sha256 */
export function hashFileTree(entries: SkillFileEntry[]): string {
  const hash = createHash('sha256')
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const entry of sorted) {
    const path = entry.path.replace(/\\/g, '/')
    hash.update(`path:${path}\n`)
    hash.update(`size:${entry.data.length}\n`)
    hash.update(entry.data)
    hash.update('\n')
  }
  return hash.digest('hex')
}

// ---- 入口 ----

/**
 * 解析 AIP 包（纯函数，无 DB/文件系统依赖）。
 * 包级致命失败返回 ok:false（路由映射 400）；单条 persona/技能失败记入 errors，不影响其余。
 */
export function parseAgentPackage(buffer: Buffer): ParseResult {
  // 条目数在构造 AdmZip 之前先看 EOCD 声明值：超大条目数包不触发中心目录解析
  const declaredEntryCount = readDeclaredEntryCount(buffer)
  if (declaredEntryCount !== null && declaredEntryCount > MAX_ZIP_ENTRIES) {
    return { ok: false, error: `Zip has too many entries (${declaredEntryCount} > ${MAX_ZIP_ENTRIES})` }
  }

  let zip: AdmZip
  try {
    zip = new AdmZip(buffer)
    if (zip.getEntries().length === 0) return { ok: false, error: 'Not an agent import package' }
  } catch {
    return { ok: false, error: 'Not a valid zip archive' }
  }

  // 解压前的资源预算：任何 getData() 之前先拒绝解压炸弹
  const budgetError = checkZipBudget(zip)
  if (budgetError) return { ok: false, error: budgetError }

  if (hasZipSlip(zip)) return { ok: false, error: 'Invalid zip: path traversal detected' }

  const { wrapperDir } = resolveZipRoot(zip)
  const files = buildFileMap(zip, wrapperDir)

  const pluginRaw = files.get('plugin.json')
  if (!pluginRaw) return { ok: false, error: 'Not an agent import package' }

  let plugin: unknown
  try {
    plugin = JSON.parse(pluginRaw.toString('utf-8'))
  } catch {
    return { ok: false, error: 'Invalid plugin.json: not valid JSON' }
  }
  if (!isPlainObject(plugin)) {
    return { ok: false, error: 'Invalid plugin.json: expected a JSON object' }
  }
  if (typeof plugin.name !== 'string' || !plugin.name.trim()) {
    return { ok: false, error: 'Invalid plugin.json: name is required' }
  }
  if (plugin.version !== undefined && typeof plugin.version !== 'string') {
    return { ok: false, error: 'Invalid plugin.json: version must be a string' }
  }
  if (plugin.extensions !== undefined && !isPlainObject(plugin.extensions)) {
    return { ok: false, error: 'Invalid plugin.json: extensions must be an object' }
  }

  const packageInfo: AipPackageInfo = {
    name: plugin.name.trim(),
    version: typeof plugin.version === 'string' ? plugin.version : '',
  }

  const warnings: string[] = []
  const errors: string[] = []
  const manifest = findExtensionManifest(plugin, files)
  if ('error' in manifest) return { ok: false, error: manifest.error }

  if (manifest.ref) {
    return parseExtensionForm(files, manifest.ref, packageInfo, warnings, errors)
  }
  return parseUniversalForm(files, packageInfo, warnings, errors)
}

// ---- 冲突比对 ----

/** origin 是否指向同一个包内 persona（协议溯源字段，仅导入路径写入） */
function isSameOrigin(origin: AgentOrigin | null | undefined, packageName: string, personaId: string): boolean {
  return !!origin && origin.protocol === 'aip' && origin.package?.name === packageName && origin.personaId === personaId
}

/**
 * 与现库比对（纯函数）：
 * - 人格先按 origin（package.name + personaId）匹配，未命中再按显示名精确匹配 agents.name；
 *   同源命中即使显示名已变也视为同源更新
 * - 中立 Agent 不参与比对，也不可被覆盖
 * - 技能按 frontmatter name 匹配已装技能，文件树哈希判定内容一致
 */
export function computeConflicts(
  data: ParsedPackage,
  existingAgents: Agent[],
  installedSkills: InstalledSkillHash[],
): ConflictReport {
  const comparable = existingAgents.filter((agent) => agent.role !== 'neutral' && agent.id !== NEUTRAL_AGENT_ID)

  const personas: PersonaConflictEntry[] = data.candidates.map((candidate) => {
    const match =
      comparable.find((agent) => isSameOrigin(agent.origin, data.package.name, candidate.id)) ??
      comparable.find((agent) => agent.name === candidate.name)
    if (!match) return { candidate }
    return {
      candidate,
      conflict: {
        agentId: match.id,
        agentName: match.name,
        sameOrigin: isSameOrigin(match.origin, data.package.name, candidate.id),
      },
    }
  })

  const skills: SkillConflictEntry[] = data.skills.map((candidate) => {
    const match = installedSkills.find((skill) => skill.name === candidate.name)
    return {
      candidate,
      conflict: {
        installed: !!match,
        contentIdentical: !!match && match.contentHash === candidate.contentHash,
      },
    }
  })

  return { personas, skills }
}

// ---- 决议映射 ----

export function buildOrigin(
  pkg: AipPackageInfo,
  personaId: string,
  importedAt = Math.floor(Date.now() / 1000),
): AgentOrigin {
  return { protocol: 'aip', package: { name: pkg.name, version: pkg.version }, personaId, importedAt }
}

/**
 * 实例默认模型：首个非中立 Agent 的 model；无此 Agent 或其 model 为空时取 DEFAULT_AGENT_MODEL。
 * 空 model 会触发运行时回退（pi-adapter 同时替换系统提示词），导入落库前必须填入默认值。
 */
export function resolveDefaultModel(existingAgents: Agent[]): string {
  const first = existingAgents.find((agent) => agent.role !== 'neutral' && agent.id !== NEUTRAL_AGENT_ID)
  return first?.model || DEFAULT_AGENT_MODEL
}

/**
 * 把 commit 请求映射为可执行计划（纯函数）。
 * 未列出的候选默认 skip；无冲突传 overwrite、非法 action 返回 requestError（路由映射 400）。
 * 空 model 填入 defaultModel（调用方传 resolveDefaultModel 结果），避免运行时回退替换系统提示词。
 */
export function planCommit(
  data: ParsedPackage,
  decisions: CommitDecisions,
  report: ConflictReport,
  defaultModel: string = DEFAULT_AGENT_MODEL,
): CommitPlan {
  const errors: string[] = []
  const personas: PersonaPlanItem[] = []
  const skills: SkillPlanItem[] = []

  const personaById = new Map(data.candidates.map((candidate) => [candidate.id, candidate]))
  const skillByName = new Map(data.skills.map((skill) => [skill.name, skill]))
  const conflictById = new Map(report.personas.map((entry) => [entry.candidate.id, entry.conflict]))
  const conflictByName = new Map(report.skills.map((entry) => [entry.candidate.name, entry.conflict]))

  const requestError = (message: string): CommitPlan => ({ personas, skills, errors, requestError: message })

  const decidedPersonas = new Set<string>()
  for (const decision of Array.isArray(decisions.personas) ? decisions.personas : []) {
    if (!isPlainObject(decision) || typeof decision.id !== 'string') {
      errors.push('Invalid persona decision')
      continue
    }
    if (decision.action !== 'create' && decision.action !== 'overwrite' && decision.action !== 'skip') {
      return requestError(`Invalid action "${String(decision.action)}" for persona "${decision.id}"`)
    }
    if (decidedPersonas.has(decision.id)) {
      errors.push(`Duplicate decision for persona "${decision.id}"`)
      continue
    }
    decidedPersonas.add(decision.id)

    const candidate = personaById.get(decision.id)
    if (!candidate) {
      errors.push(`Unknown persona "${decision.id}"`)
      continue
    }
    const conflict = conflictById.get(decision.id)
    if (decision.action === 'overwrite' && !conflict) {
      return requestError(`Persona "${decision.id}" has no conflict to overwrite`)
    }
    const name = typeof decision.name === 'string' && decision.name.trim() ? decision.name.trim() : candidate.name
    // 决议里的 name 覆盖包内声明，落库前必须再校验保留名（协议 §11.2：导入不得创建/覆盖中立 Agent）
    if (decision.action !== 'skip' && isReservedNeutralName(name)) {
      return requestError(`Persona "${decision.id}": name "${name}" collides with the reserved neutral agent`)
    }
    const requestedModel = typeof decision.model === 'string' ? decision.model.trim() : ''
    personas.push({
      kind: decision.action,
      candidate,
      name,
      // skip 不落库；create/overwrite 的空 model 填实例默认（否则运行时回退会替换系统提示词）
      model: decision.action === 'skip' ? '' : requestedModel || defaultModel,
      origin: buildOrigin(data.package, candidate.id),
      targetAgentId: conflict?.agentId,
    })
  }
  for (const candidate of data.candidates) {
    if (decidedPersonas.has(candidate.id)) continue
    personas.push({
      kind: 'skip',
      candidate,
      name: candidate.name,
      model: '',
      origin: buildOrigin(data.package, candidate.id),
    })
  }

  const decidedSkills = new Set<string>()
  for (const decision of Array.isArray(decisions.skills) ? decisions.skills : []) {
    if (!isPlainObject(decision) || typeof decision.name !== 'string') {
      errors.push('Invalid skill decision')
      continue
    }
    if (decision.action !== 'install' && decision.action !== 'skip') {
      return requestError(`Invalid action "${String(decision.action)}" for skill "${decision.name}"`)
    }
    if (decidedSkills.has(decision.name)) {
      errors.push(`Duplicate decision for skill "${decision.name}"`)
      continue
    }
    decidedSkills.add(decision.name)

    const candidate = skillByName.get(decision.name)
    if (!candidate) {
      errors.push(`Unknown skill "${decision.name}"`)
      continue
    }
    const conflict = conflictByName.get(decision.name)
    let kind: SkillPlanItem['kind'] = 'skip'
    if (decision.action === 'install') {
      if (!conflict?.installed) kind = 'install'
      else if (conflict.contentIdentical) kind = 'skip'
      else kind = 'overwrite'
    }
    skills.push({ kind, candidate })
  }
  for (const candidate of data.skills) {
    if (decidedSkills.has(candidate.name)) continue
    skills.push({ kind: 'skip', candidate })
  }

  return { personas, skills, errors }
}
