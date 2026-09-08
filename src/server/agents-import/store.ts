import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { sanitizeSkillName } from '../lib/zip.js'
import { hashFileTree } from './parser.js'
import type { ParsedPackage, SkillFileEntry } from './types.js'

/** 待确认导入的暂存有效期：24 小时（进程重启即失效） */
export const IMPORT_TTL_MS = 24 * 60 * 60 * 1000
/** 过期 id 墓碑上限，用于区分 404（从未存在）与 410（已过期） */
const MAX_EXPIRED_TOMBSTONES = 200
/** 暂存条目数上限：反复上传不得无界累积 */
export const MAX_STAGED_IMPORTS = 16
/** 暂存总字节上限（含头像 dataURL 与技能文件） */
export const MAX_STAGED_BYTES = 256 * 1024 * 1024
/** 定时清理间隔：不依赖下一次请求触发 prune */
const STAGING_PRUNE_INTERVAL_MS = 60 * 60 * 1000

/** 暂存超限（路由映射为 413） */
export class ImportStageLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportStageLimitError'
  }
}

interface StagedImport {
  data: ParsedPackage
  /** 估算占用字节，用于暂存总量上限 */
  bytes: number
  createdAt: number
}

const stagedImports = new Map<string, StagedImport>()
const expiredIds = new Set<string>()

export type StagedLookup = { state: 'ok'; data: ParsedPackage } | { state: 'expired' } | { state: 'missing' }

/** 估算一次暂存占用的字节数（字符串按 UTF-8 字节，技能文件按 Buffer 长度） */
export function estimateStagedBytes(data: ParsedPackage): number {
  let bytes = 0
  for (const candidate of data.candidates) {
    bytes += Buffer.byteLength(candidate.name, 'utf-8')
    bytes += Buffer.byteLength(candidate.systemPrompt, 'utf-8')
    bytes += candidate.avatar?.length ?? 0
  }
  for (const skill of data.skills) {
    bytes += Buffer.byteLength(skill.name, 'utf-8')
    bytes += Buffer.byteLength(skill.description, 'utf-8')
    for (const file of skill.files) {
      bytes += Buffer.byteLength(file.path, 'utf-8') + file.data.length
    }
  }
  return bytes
}

function totalStagedBytes(): number {
  let total = 0
  for (const entry of stagedImports.values()) total += entry.bytes
  return total
}

/** 超限抛 ImportStageLimitError（路由映射 413），不静默丢弃既有暂存 */
export function stageImport(data: ParsedPackage, now = Date.now()): string {
  pruneExpiredImports(now)
  if (stagedImports.size >= MAX_STAGED_IMPORTS) {
    throw new ImportStageLimitError(
      `Too many pending imports (max ${MAX_STAGED_IMPORTS}); wait for earlier imports to expire`,
    )
  }
  const bytes = estimateStagedBytes(data)
  if (totalStagedBytes() + bytes > MAX_STAGED_BYTES) {
    throw new ImportStageLimitError(`Pending import data exceeds the staging limit (${MAX_STAGED_BYTES} bytes)`)
  }
  const importId = randomUUID()
  stagedImports.set(importId, { data, bytes, createdAt: now })
  return importId
}

export function getStagedImport(importId: string, now = Date.now()): StagedLookup {
  pruneExpiredImports(now)
  const entry = stagedImports.get(importId)
  if (entry) return { state: 'ok', data: entry.data }
  return expiredIds.has(importId) ? { state: 'expired' } : { state: 'missing' }
}

export function deleteStagedImport(importId: string): void {
  stagedImports.delete(importId)
}

export function pruneExpiredImports(now = Date.now()): number {
  let removed = 0
  for (const [id, entry] of stagedImports) {
    if (now - entry.createdAt >= IMPORT_TTL_MS) {
      stagedImports.delete(id)
      expiredIds.add(id)
      removed++
    }
  }
  while (expiredIds.size > MAX_EXPIRED_TOMBSTONES) {
    const oldest = expiredIds.values().next().value
    if (oldest === undefined) break
    expiredIds.delete(oldest)
  }
  return removed
}

// 定时清理过期暂存：即使没有后续请求也会释放内存；unref 不阻止进程退出
const stagingPruneTimer: unknown = setInterval(() => pruneExpiredImports(), STAGING_PRUNE_INTERVAL_MS)
if (stagingPruneTimer && typeof (stagingPruneTimer as { unref?: () => void }).unref === 'function') {
  ;(stagingPruneTimer as { unref: () => void }).unref()
}

/** 仅供测试：清空暂存与墓碑 */
export function resetImportStore(): void {
  stagedImports.clear()
  expiredIds.clear()
}

/** 已装技能目录的文件树哈希；跳过 macOS 垃圾文件，与 zip 侧 hashFileTree 口径一致 */
export function hashSkillDir(dir: string): string {
  const entries: SkillFileEntry[] = []

  const walk = (current: string, rel: string): void => {
    let dirents: fs.Dirent[]
    try {
      dirents = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const dirent of dirents) {
      if (dirent.name === '__MACOSX' || dirent.name === '.DS_Store') continue
      const abs = path.join(current, dirent.name)
      const relPath = rel ? `${rel}/${dirent.name}` : dirent.name
      if (dirent.isDirectory()) {
        walk(abs, relPath)
      } else if (dirent.isFile()) {
        entries.push({ path: relPath, data: fs.readFileSync(abs) })
      }
    }
  }

  walk(dir, '')
  return hashFileTree(entries)
}

export type SkillInstallResult = { ok: true; outcome: 'installed' | 'overwritten' } | { ok: false; error: string }

/**
 * 把暂存的技能文件树写入 `<skillsRoot>/<name>`。
 * 先写临时目录再原子替换目标目录，避免覆盖失败时丢失既有技能；
 * 名称与每个文件路径都做包含性校验，禁止写出 skills/ 之外。
 */
export function installSkillTree(
  skillsRoot: string,
  name: string,
  files: SkillFileEntry[],
  overwrite: boolean,
): SkillInstallResult {
  const sanitized = sanitizeSkillName(name)
  if (!sanitized.ok) return { ok: false, error: sanitized.error }

  const root = path.resolve(skillsRoot)
  const dest = path.resolve(root, sanitized.name)
  if (dest === root || !dest.startsWith(root + path.sep)) {
    return { ok: false, error: 'skill path escapes the skills directory' }
  }

  const existed = fs.existsSync(dest)
  if (existed && !overwrite) return { ok: false, error: 'skill is already installed' }

  const tmpDir = path.resolve(root, `import-tmp-${randomUUID()}`)
  try {
    fs.mkdirSync(tmpDir, { recursive: true })
    for (const file of files) {
      // ':' 覆盖盘符与 NTFS 备用数据流（file:stream），与 sanitizeSkillName 语义一致
      if (file.path.includes(':')) {
        throw new Error(`skill file path contains ":" (alternate data stream): ${file.path}`)
      }
      const target = path.resolve(tmpDir, file.path)
      if (!target.startsWith(tmpDir + path.sep)) {
        throw new Error(`skill file path escapes the skill directory: ${file.path}`)
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, file.data)
    }
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true })
    fs.renameSync(tmpDir, dest)
  } catch (err) {
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true })
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  return { ok: true, outcome: existed ? 'overwritten' : 'installed' }
}
