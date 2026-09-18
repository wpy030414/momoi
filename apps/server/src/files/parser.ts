import fs from 'fs'
import path from 'path'
import * as XLSX from 'xlsx'
import * as pdfParse from 'pdf-parse'

export interface ParsedAttachment {
  kind: 'text' | 'image' | 'binary'
  name: string
  content: string
  base64?: string
  mimeType?: string
}

const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.json', '.log', '.xml', '.yaml', '.yml'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])
const MAX_TEXT_LENGTH = 50_000 // Truncate very large text content

export async function parseAttachment(
  filepath: string,
  name: string,
  mimeType: string,
): Promise<ParsedAttachment> {
  const ext = path.extname(filepath).toLowerCase()

  // --- Images → base64 ---
  if (ext && IMAGE_EXTS.has(ext) || mimeType.startsWith('image/')) {
    const buffer = fs.readFileSync(filepath)
    const mime = mimeType || guessImageMime(ext)
    const base64 = `data:${mime};base64,${buffer.toString('base64')}`
    return { kind: 'image', name, content: `![${name}](${base64})`, base64, mimeType: mime }
  }

  // --- Excel (.xlsx, .xls) ---
  if (ext === '.xlsx' || ext === '.xls') {
    try {
      const buffer = fs.readFileSync(filepath)
      const workbook = XLSX.read(buffer, { type: 'buffer' })
      const parts: string[] = []
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName]
        const csv = XLSX.utils.sheet_to_csv(sheet)
        parts.push(`## Sheet: ${sheetName}\n${csv}`)
      }
      const content = parts.join('\n\n')
      return { kind: 'text', name, content: truncate(content, MAX_TEXT_LENGTH) }
    } catch (err) {
      return { kind: 'text', name, content: `[无法解析 Excel 文件: ${(err as Error).message}]` }
    }
  }

  // --- PDF ---
  if (ext === '.pdf') {
    try {
      const buffer = fs.readFileSync(filepath)
      const parser = new pdfParse.PDFParse({ data: new Uint8Array(buffer) })
      const result = await parser.getText()
      await parser.destroy()
      return { kind: 'text', name, content: truncate(result.text, MAX_TEXT_LENGTH) }
    } catch (err) {
      return { kind: 'text', name, content: `[无法解析 PDF 文件: ${(err as Error).message}]` }
    }
  }

  // --- Plain text files ---
  if (ext && TEXT_EXTS.has(ext) || mimeType.startsWith('text/')) {
    try {
      const text = fs.readFileSync(filepath, 'utf-8')
      return { kind: 'text', name, content: truncate(text, MAX_TEXT_LENGTH) }
    } catch (err) {
      return { kind: 'text', name, content: `[无法读取文本文件: ${(err as Error).message}]` }
    }
  }

  // --- Binary / unknown ---
  const size = fs.statSync(filepath).size
  return {
    kind: 'binary',
    name,
    content: `[文件: ${name}, 大小: ${(size / 1024).toFixed(1)} KB, 类型: ${mimeType || '未知'}]`,
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + `\n\n... (内容已截断，共 ${text.length} 字符)`
}

function guessImageMime(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
  }
  return map[ext] || 'image/png'
}
