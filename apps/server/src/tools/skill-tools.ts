// ============================================================
// Skill Tools — load_skill, list_skill_files
// ============================================================

import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { skillRegistry } from '../skills/registry.js'
import type { ToolModule, ToolResult } from './types.js'

const MAX_FILE_LENGTH = 50_000
const TEXT_EXTS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.xml', '.html', '.css', '.js', '.ts'])

/**
 * Resolve a relative path within a skill directory with traversal protection.
 */
function resolveSkillPath(skillDir: string, relPath: string): string {
  if (path.isAbsolute(relPath)) {
    throw new Error('Absolute paths not allowed')
  }
  const resolved = path.resolve(skillDir, relPath)
  if (resolved !== skillDir && !resolved.startsWith(skillDir + path.sep)) {
    throw new Error('Path traversal blocked')
  }
  return resolved
}

/**
 * Walk a directory and collect relative paths of text files.
 */
async function walkSkillFiles(skillDir: string): Promise<string[]> {
  const results: string[] = []

  const walk = async (dir: string): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase()
        if (TEXT_EXTS.has(ext)) {
          results.push(path.relative(skillDir, full))
        }
      }
    }
  }

  await walk(skillDir)
  return results.sort()
}

// ---- load_skill ----

const loadSkill: ToolModule = {
  definition: {
    name: 'load_skill',
    description: 'Load the full content of a skill file. Without `path`, loads the main SKILL.md. With `path`, loads a specific file within the skill directory (e.g. "references/api.md"). A file listing is always included so you know what else is available.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name (as listed in Available Skills)' },
        path: { type: 'string', description: 'Optional: relative path to a specific file within the skill directory (e.g. "references/guide.md"). Defaults to "SKILL.md".' },
      },
      required: ['name'],
    },
  },
  async execute(input): Promise<ToolResult> {
    const name = String(input.name)
    const relPath = String(input.path || 'SKILL.md')

    const skill = skillRegistry.get(name)
    if (!skill) {
      const available = skillRegistry.getAll().map((s) => s.manifest.name).join(', ')
      return {
        summary: `Skill "${name}" not found. Available: ${available || '(none)'}`,
        error: true,
      }
    }

    // List all files in the skill directory
    const files = await walkSkillFiles(skill.path)

    // Resolve and read the requested file
    let absPath: string
    try {
      absPath = resolveSkillPath(skill.path, relPath)
    } catch (err) {
      return { summary: (err as Error).message, error: true }
    }

    try {
      const content = await fsp.readFile(absPath, 'utf-8')
      const truncated = content.length > MAX_FILE_LENGTH
      const text = truncated
        ? content.slice(0, MAX_FILE_LENGTH) + `\n\n... (truncated, total ${content.length} chars)`
        : content

      return {
        summary: `Loaded "${relPath}" from skill "${name}" (${content.length} chars${truncated ? ', truncated' : ''})`,
        data: { name, file: relPath, content: text, files, truncated },
      }
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return {
          summary: `File "${relPath}" not found in skill "${name}". Available files: ${files.join(', ') || '(none)'}`,
          error: true,
        }
      }
      return { summary: `Error reading ${relPath}: ${err.message}`, error: true }
    }
  },
}

// ---- list_skill_files ----

const listSkillFiles: ToolModule = {
  definition: {
    name: 'list_skill_files',
    description: 'List all readable files within a skill directory. Use this to discover references, sub-skills, and other resources.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name (as listed in Available Skills)' },
      },
      required: ['name'],
    },
  },
  async execute(input): Promise<ToolResult> {
    const name = String(input.name)
    const skill = skillRegistry.get(name)

    if (!skill) {
      const available = skillRegistry.getAll().map((s) => s.manifest.name).join(', ')
      return {
        summary: `Skill "${name}" not found. Available: ${available || '(none)'}`,
        error: true,
      }
    }

    const files = await walkSkillFiles(skill.path)

    return {
      summary: `Skill "${name}" contains ${files.length} file(s): ${files.join(', ')}`,
      data: { name, files },
    }
  },
}

export const skillTools: ToolModule[] = [loadSkill, listSkillFiles]
