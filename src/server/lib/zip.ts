import fs from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'

/**
 * Zip slip protection: true when any entry name contains a traversal segment.
 * Extracted from the skill upload endpoint (behavior unchanged).
 */
export function hasZipSlip(zip: AdmZip): boolean {
  for (const entry of zip.getEntries()) {
    if (entry.entryName.includes('..')) return true
  }
  return false
}

/**
 * Unsafe file name segment: `:` (Windows drive prefix or NTFS alternate data
 * stream, e.g. `evil.txt:payload`) or a control character. Mirrors the
 * corresponding rejections in `sanitizeSkillName` so skill upload, package
 * import and directory install share one predicate.
 */
export function hasUnsafeFileName(name: string): boolean {
  return name.includes(':') || hasControlChars(name)
}

/**
 * First unsafe zip entry name — traversal (`..`), alternate data stream (`:`)
 * or control characters — or null when every entry is safe. Callers that
 * extract the whole archive (skill upload) must reject the package before
 * writing anything to disk.
 */
export function findUnsafeZipEntry(zip: AdmZip): string | null {
  for (const entry of zip.getEntries()) {
    if (entry.entryName.includes('..') || hasUnsafeFileName(entry.entryName)) return entry.entryName
  }
  return null
}

/** Determine if a zip has a single wrapper directory */
export function resolveZipRoot(zip: AdmZip): { wrapperDir: string | null } {
  const entries = zip
    .getEntries()
    .filter((e) => !e.entryName.startsWith('__MACOSX') && !e.entryName.endsWith('.DS_Store'))
  if (entries.length === 0) return { wrapperDir: null }

  const topDirs = new Set<string>()
  let hasRootFile = false

  for (const entry of entries) {
    const parts = entry.entryName.split('/')
    if (parts.length <= 1) {
      hasRootFile = true
      break
    }
    topDirs.add(parts[0])
  }

  if (hasRootFile || topDirs.size !== 1) return { wrapperDir: null }
  return { wrapperDir: [...topDirs][0] }
}

/** Remove __MACOSX directories and .DS_Store files */
export function cleanMacOSArtifacts(dir: string): void {
  const macosDir = path.join(dir, '__MACOSX')
  if (fs.existsSync(macosDir)) {
    fs.rmSync(macosDir, { recursive: true })
  }

  function removeDSStore(d: string) {
    const dsStore = path.join(d, '.DS_Store')
    if (fs.existsSync(dsStore)) fs.unlinkSync(dsStore)
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.isDirectory()) removeDSStore(path.join(d, entry.name))
    }
  }
  removeDSStore(dir)
}

/** Agent Skills name: lowercase letters, digits and hyphens only */
const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/

/** True when the value contains a control character (C0 range or DEL) */
function hasControlChars(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export type SanitizeSkillNameResult = { ok: true; name: string } | { ok: false; error: string }

/**
 * Validate a skill name before it is resolved as a directory under `skills/`.
 * Accepts only `[a-z0-9-]+`; every other input is rejected with an error
 * instead of being silently rewritten. Rejects traversal segments, path
 * separators, absolute paths, control characters and Windows colon
 * (alternate data stream) syntax.
 */
export function sanitizeSkillName(name: string): SanitizeSkillNameResult {
  if (name.length === 0) {
    return { ok: false, error: 'name is required' }
  }
  if (hasControlChars(name)) {
    return { ok: false, error: 'name contains control characters' }
  }
  if (name.includes('..')) {
    return { ok: false, error: 'name contains a path traversal segment ("..")' }
  }
  if (name.includes('/') || name.includes('\\')) {
    return { ok: false, error: 'name contains a path separator' }
  }
  if (path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) {
    return { ok: false, error: 'name must not be an absolute path' }
  }
  if (name.includes(':')) {
    return { ok: false, error: 'name contains ":" (alternate data stream)' }
  }
  if (!SKILL_NAME_PATTERN.test(name)) {
    return { ok: false, error: 'name must match [a-z0-9-]+' }
  }
  return { ok: true, name }
}
