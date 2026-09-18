// ============================================================
// Built-in File Tools — read_file, write_file, list_files, delete_file
// ============================================================

import type { ToolModule, ToolResult } from './types.js'

const MAX_READ_LENGTH = 50_000

// ---- read_file ----
const readFile: ToolModule = {
  definition: {
    name: 'read_file',
    description: 'Read the contents of a file in the conversation workspace. Returns file content as text for text files, or base64 for binary files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        encoding: { type: 'string', description: "Encoding: 'utf-8' (default) or 'base64'" },
      },
      required: ['path'],
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const relPath = String(input.path)
    const encoding = input.encoding === 'base64' ? 'base64' : 'utf-8'

    try {
      const stat = await ctx.workspace.stat(relPath)
      if (stat.isDirectory()) {
        return { summary: `Error: ${relPath} is a directory, not a file`, error: true }
      }

      const content = await ctx.workspace.readFile(relPath, encoding)
      if (encoding === 'base64') {
        return {
          summary: `Read binary file ${relPath} (${stat.size} bytes) as base64`,
          data: { path: relPath, size: stat.size, encoding: 'base64', content: content.slice(0, MAX_READ_LENGTH) },
        }
      }

      const truncated = content.length > MAX_READ_LENGTH
      const text = truncated ? content.slice(0, MAX_READ_LENGTH) + `\n... (truncated, total ${content.length} chars)` : content
      return {
        summary: `Read ${relPath} (${content.length} chars${truncated ? ', truncated' : ''})`,
        data: { path: relPath, size: stat.size, content: text, truncated },
      }
    } catch (err) {
      return { summary: `Error reading ${relPath}: ${(err as Error).message}`, error: true }
    }
  },
}

// ---- write_file ----
const writeFile: ToolModule = {
  definition: {
    name: 'write_file',
    description: 'Write content to a file in the conversation workspace. Creates parent directories as needed.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace root' },
        content: { type: 'string', description: 'File content (text string or base64 for binary)' },
        encoding: { type: 'string', description: "'utf-8' (default) or 'base64'" },
      },
      required: ['path', 'content'],
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const relPath = String(input.path)
    const content = String(input.content)
    const encoding = input.encoding === 'base64' ? 'base64' : 'utf-8'

    try {
      await ctx.workspace.writeFile(relPath, content, encoding)
      const stat = await ctx.workspace.stat(relPath)
      return {
        summary: `Wrote ${stat.size} bytes to ${relPath}`,
        data: { path: relPath, size: stat.size },
      }
    } catch (err) {
      return { summary: `Error writing ${relPath}: ${(err as Error).message}`, error: true }
    }
  },
}

// ---- list_files ----
const listFiles: ToolModule = {
  definition: {
    name: 'list_files',
    description: 'List files and directories in the conversation workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to workspace root (default: root)' },
        recursive: { type: 'boolean', description: 'List recursively (default: false)' },
      },
      required: [],
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const relPath = String(input.path || '')
    const recursive = input.recursive === true

    try {
      const entries = await ctx.workspace.listDir(relPath, recursive)
      const lines = entries.map((e) => {
        if (e.type === 'directory') return `${e.name}/`
        return `${e.name}  (${formatSize(e.size)})`
      })
      return {
        summary: `Listed ${entries.length} entries in ${relPath || 'workspace root'}`,
        data: { path: relPath || '/', entries, listing: lines.join('\n') },
      }
    } catch (err) {
      return { summary: `Error listing ${relPath || 'root'}: ${(err as Error).message}`, error: true }
    }
  },
}

// ---- delete_file ----
const deleteFile: ToolModule = {
  definition: {
    name: 'delete_file',
    description: 'Delete a file or directory from the conversation workspace.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory path relative to workspace root' },
      },
      required: ['path'],
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const relPath = String(input.path)

    try {
      await ctx.workspace.deletePath(relPath)
      return { summary: `Deleted ${relPath}` }
    } catch (err) {
      return { summary: `Error deleting ${relPath}: ${(err as Error).message}`, error: true }
    }
  },
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export const fileTools: ToolModule[] = [readFile, writeFile, listFiles, deleteFile]
