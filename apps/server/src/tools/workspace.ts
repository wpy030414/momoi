// ============================================================
// SandboxFS — Path-jailed filesystem for conversation workspaces
// ============================================================

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { repoRoot } from '../paths.js'

const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024 // 100 MB
const DEFAULT_MAX_FILES = 500
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024 // 20 MB

export class SandboxFS {
  private root: string
  private maxBytes: number
  private maxFiles: number
  private maxFileBytes: number

  constructor(conversationId: string) {
    this.root = path.resolve(repoRoot(), 'data', 'workspaces', conversationId)
    this.maxBytes = parseInt(process.env.WORKSPACE_MAX_BYTES || String(DEFAULT_MAX_BYTES), 10)
    this.maxFiles = parseInt(process.env.WORKSPACE_MAX_FILES || String(DEFAULT_MAX_FILES), 10)
    this.maxFileBytes = parseInt(process.env.WORKSPACE_MAX_FILE_BYTES || String(DEFAULT_MAX_FILE_BYTES), 10)
  }

  /** Ensure workspace directory exists (lazy creation) */
  ensureDir(): void {
    fs.mkdirSync(this.root, { recursive: true })
  }

  /** Get the absolute root path */
  getRoot(): string {
    return this.root
  }

  /**
   * Resolve a relative path within the sandbox.
   * Throws on path traversal, absolute paths, symlinks, and reserved names.
   */
  resolve(safePath: string): string {
    if (path.isAbsolute(safePath)) {
      throw new Error('Absolute paths not allowed')
    }

    // Block Windows reserved filenames
    const basename = path.basename(safePath).toUpperCase().split('.')[0]
    if (RESERVED_NAMES.has(basename)) {
      throw new Error(`Reserved filename blocked: ${safePath}`)
    }

    // Normalize and resolve
    const resolved = path.resolve(this.root, safePath)

    // Path traversal guard: resolved must start with root + separator (or equal root)
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) {
      throw new Error(`Path traversal blocked: ${safePath}`)
    }

    return resolved
  }

  /** Read file content as string or base64 */
  async readFile(relPath: string, encoding: 'utf-8' | 'base64' = 'utf-8'): Promise<string> {
    const absPath = this.resolve(relPath)
    await this.rejectSymlink(absPath)
    const buffer = await fsp.readFile(absPath)
    return encoding === 'base64' ? buffer.toString('base64') : buffer.toString('utf-8')
  }

  /** Read file as raw Buffer */
  async readFileRaw(relPath: string): Promise<Buffer> {
    const absPath = this.resolve(relPath)
    await this.rejectSymlink(absPath)
    return fsp.readFile(absPath)
  }

  /** Write content to a file (creates parent dirs as needed) */
  async writeFile(relPath: string, content: string | Buffer, encoding: 'utf-8' | 'base64' = 'utf-8'): Promise<void> {
    const absPath = this.resolve(relPath)
    await this.rejectSymlink(path.dirname(absPath))
    await this.ensureParentDir(absPath)

    const buffer = typeof content === 'string'
      ? (encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf-8'))
      : content

    // Enforce single file size limit
    if (buffer.length > this.maxFileBytes) {
      throw new Error(`File too large: ${buffer.length} bytes exceeds ${this.maxFileBytes} byte limit`)
    }

    // Enforce workspace limits
    await this.enforceLimits(buffer.length, absPath)

    await fsp.writeFile(absPath, buffer)
  }

  /** List files and directories */
  async listDir(relPath = '', recursive = false): Promise<Array<{ name: string; type: 'file' | 'directory'; size: number }>> {
    const absPath = relPath ? this.resolve(relPath) : this.root
    await this.rejectSymlink(absPath)

    const stat = await fsp.stat(absPath)
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${relPath}`)
    }

    const results: Array<{ name: string; type: 'file' | 'directory'; size: number }> = []
    await this.walkDir(absPath, results, recursive)
    return results
  }

  /** Delete a file or empty directory */
  async deletePath(relPath: string): Promise<void> {
    const absPath = this.resolve(relPath)
    await this.rejectSymlink(absPath)

    const stat = await fsp.stat(absPath)
    if (stat.isDirectory()) {
      await fsp.rm(absPath, { recursive: true, force: true })
    } else {
      await fsp.unlink(absPath)
    }
  }

  /** Get file/directory stats */
  async stat(relPath: string): Promise<fs.Stats> {
    const absPath = this.resolve(relPath)
    await this.rejectSymlink(absPath)
    return fsp.stat(absPath)
  }

  /** Copy a file from an external absolute path into the workspace */
  async copyIn(srcAbsPath: string, destRelPath: string): Promise<void> {
    const srcBuffer = await fsp.readFile(srcAbsPath)
    await this.writeFile(destRelPath, srcBuffer)
  }

  /** Check if a file exists in the workspace */
  async exists(relPath: string): Promise<boolean> {
    try {
      const absPath = this.resolve(relPath)
      await fsp.access(absPath)
      return true
    } catch {
      return false
    }
  }

  // ---- Private helpers ----

  private async walkDir(
    dir: string,
    results: Array<{ name: string; type: 'file' | 'directory'; size: number }>,
    recursive: boolean,
  ): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const relName = path.relative(this.root, path.join(dir, entry.name))
      if (entry.isDirectory()) {
        results.push({ name: relName + '/', type: 'directory', size: 0 })
        if (recursive) {
          await this.walkDir(path.join(dir, entry.name), results, true)
        }
      } else if (entry.isFile()) {
        const st = await fsp.stat(path.join(dir, entry.name))
        results.push({ name: relName, type: 'file', size: st.size })
      }
    }
  }

  private async rejectSymlink(absPath: string): Promise<void> {
    try {
      const stat = await fsp.lstat(absPath)
      if (stat.isSymbolicLink()) {
        throw new Error('Symlinks not allowed')
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
    }
  }

  private async enforceLimits(incomingBytes: number, incomingAbsPath: string): Promise<void> {
    let totalBytes = 0
    let totalFiles = 0
    await this.countUsage(this.root, incomingAbsPath, (bytes, files) => {
      totalBytes = bytes
      totalFiles = files
    })

    if (totalBytes + incomingBytes > this.maxBytes) {
      throw new Error(`Workspace size limit exceeded: ${(totalBytes + incomingBytes) / 1024 / 1024}MB > ${this.maxBytes / 1024 / 1024}MB`)
    }

    // Only count new file if it doesn't already exist
    const isNew = !(await fsp.access(incomingAbsPath).then(() => true).catch(() => false))
    if (isNew && totalFiles + 1 > this.maxFiles) {
      throw new Error(`Workspace file count limit exceeded: ${totalFiles + 1} > ${this.maxFiles}`)
    }
  }

  private async countUsage(
    dir: string,
    excludePath: string,
    callback: (bytes: number, files: number) => void,
  ): Promise<void> {
    let totalBytes = 0
    let totalFiles = 0

    const walk = async (d: string): Promise<void> => {
      let entries: fs.Dirent[]
      try {
        entries = await fsp.readdir(d, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(d, entry.name)
        if (full === excludePath) continue // skip the file being written (will be overwritten)
        if (entry.isDirectory()) {
          await walk(full)
        } else if (entry.isFile()) {
          try {
            const st = await fsp.stat(full)
            totalBytes += st.size
            totalFiles++
          } catch {
            // skip inaccessible files
          }
        }
      }
    }

    await walk(dir)
    callback(totalBytes, totalFiles)
  }

  private async ensureParentDir(absPath: string): Promise<void> {
    const parent = path.dirname(absPath)
    await fsp.mkdir(parent, { recursive: true })
  }
}
