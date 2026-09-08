// ============================================================
// Document Tools — read_document, write_document
// Read:  DOCX, DOC, PPTX, XLSX, XLS, PDF, CSV
// Write: DOCX, PPTX, XLSX
// ============================================================

import path from 'path'
import * as XLSX from 'xlsx'
import * as pdfParse from 'pdf-parse'
import * as mammoth from 'mammoth'
import * as AdmZip from 'adm-zip'
import * as docx from 'docx'
import * as PptxGenJS from 'pptxgenjs'
import ExcelJS from 'exceljs'
import WordExtractor from 'word-extractor'
import type { ToolModule, ToolResult, ToolArtifact } from './types.js'

const MAX_TEXT_LENGTH = 50_000

function guessMime(ext: string): string {
  const map: Record<string, string> = {
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.csv': 'text/csv',
    '.pdf': 'application/pdf',
  }
  return map[ext] || 'application/octet-stream'
}

function makeArtifact(conversationId: string, filename: string, displayName: string, ext: string): ToolArtifact {
  return {
    filename,
    displayName,
    mimeType: guessMime(ext),
    downloadUrl: `/api/workspace/${conversationId}/file/${encodeURIComponent(filename)}`,
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  return text.slice(0, maxLen) + `\n\n... (truncated, total ${text.length} chars)`
}

// ---- Read helpers ----

async function readDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer })
  return truncate(result.value, MAX_TEXT_LENGTH)
}

async function readDoc(buffer: Buffer): Promise<string> {
  const extractor = new WordExtractor()
  const doc = await extractor.extract(buffer)
  return truncate(doc.getBody(), MAX_TEXT_LENGTH)
}

function readCsv(buffer: Buffer): string {
  return truncate(buffer.toString('utf-8'), MAX_TEXT_LENGTH)
}

async function readPptx(buffer: Buffer): Promise<string> {
  const zip = new AdmZip.default(buffer)
  const entries = zip.getEntries()
  const slides: string[] = []

  // Sort slide entries by number: ppt/slides/slide1.xml, slide2.xml, ...
  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName))
    .sort((a, b) => {
      const numA = parseInt(a.entryName.match(/slide(\d+)/)?.[1] || '0')
      const numB = parseInt(b.entryName.match(/slide(\d+)/)?.[1] || '0')
      return numA - numB
    })

  for (const entry of slideEntries) {
    const xml = entry.getData().toString('utf-8')
    // Extract text content from <a:t> tags
    const textParts: string[] = []
    const regex = /<a:t>([^<]*)<\/a:t>/g
    let match
    while ((match = regex.exec(xml)) !== null) {
      if (match[1].trim()) textParts.push(match[1])
    }
    const slideNum = entry.entryName.match(/slide(\d+)/)?.[1] || '?'
    slides.push(`## Slide ${slideNum}\n${textParts.join('\n')}`)
  }

  return truncate(slides.join('\n\n'), MAX_TEXT_LENGTH)
}

async function readXlsx(buffer: Buffer): Promise<string> {
  const workbook = XLSX.read(buffer, { type: 'buffer' })
  const parts: string[] = []
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const csv = XLSX.utils.sheet_to_csv(sheet)
    parts.push(`## Sheet: ${sheetName}\n${csv}`)
  }
  return truncate(parts.join('\n\n'), MAX_TEXT_LENGTH)
}

async function readPdf(buffer: Buffer): Promise<string> {
  const parser = new pdfParse.PDFParse({ data: new Uint8Array(buffer) })
  const result = await parser.getText()
  await parser.destroy()
  return truncate(result.text, MAX_TEXT_LENGTH)
}

// ---- Write helpers ----

async function writeDocx(content: any): Promise<Buffer> {
  const children: (docx.Paragraph | docx.Table)[] = []

  if (content.title) {
    children.push(new docx.Paragraph({
      text: content.title,
      heading: docx.HeadingLevel.TITLE,
    }))
  }

  if (content.sections && Array.isArray(content.sections)) {
    for (const section of content.sections) {
      if (section.heading) {
        children.push(new docx.Paragraph({
          text: section.heading,
          heading: docx.HeadingLevel.HEADING_1,
        }))
      }
      if (section.paragraphs && Array.isArray(section.paragraphs)) {
        for (const para of section.paragraphs) {
          children.push(new docx.Paragraph({ text: String(para) }))
        }
      }
      if (section.body) {
        // Simple body text (split by newlines into paragraphs)
        const lines = String(section.body).split('\n').filter(Boolean)
        for (const line of lines) {
          children.push(new docx.Paragraph({ text: line }))
        }
      }
      if (section.table && section.table.headers && section.table.rows) {
        const headerRow = new docx.TableRow({
          children: section.table.headers.map((h: string) => new docx.TableCell({
            children: [new docx.Paragraph({
              children: [new docx.TextRun({ text: String(h), bold: true })],
            })],
          })),
          tableHeader: true,
        })
        const dataRows = section.table.rows.map((row: any[]) =>
          new docx.TableRow({
            children: row.map((cell: any) => new docx.TableCell({
              children: [new docx.Paragraph({ text: String(cell) })],
            })),
          })
        )
        children.push(new docx.Table({
          rows: [headerRow, ...dataRows],
          width: { size: 100, type: docx.WidthType.PERCENTAGE },
        }))
      }
    }
  }

  // If no structured content, just add the raw content as paragraphs
  if (children.length === 0 && typeof content === 'string') {
    for (const line of content.split('\n').filter(Boolean)) {
      children.push(new docx.Paragraph({ text: line }))
    }
  }

  const doc = new docx.Document({
    sections: [{ children }],
  })

  return docx.Packer.toBuffer(doc)
}

async function writePptx(content: any): Promise<Buffer> {
  const pptx = new PptxGenJS.default()

  if (content.title) {
    // Title slide
    const slide = pptx.addSlide()
    slide.addText(content.title, {
      x: 0.5, y: 2, w: 9, h: 2,
      fontSize: 36, bold: true, align: 'center',
    })
  }

  if (content.slides && Array.isArray(content.slides)) {
    for (const slideData of content.slides) {
      const slide = pptx.addSlide()

      if (slideData.title) {
        slide.addText(slideData.title, {
          x: 0.5, y: 0.3, w: 9, h: 0.8,
          fontSize: 24, bold: true,
        })
      }

      if (slideData.bullets && Array.isArray(slideData.bullets)) {
        const textRows = slideData.bullets.map((b: string) => ({
          text: String(b),
          options: { bullet: true, fontSize: 18 },
        }))
        slide.addText(textRows, {
          x: 0.8, y: 1.3, w: 8.4, h: 4.5,
          valign: 'top',
        })
      }

      if (slideData.body) {
        slide.addText(String(slideData.body), {
          x: 0.8, y: 1.3, w: 8.4, h: 4.5,
          fontSize: 16, valign: 'top',
        })
      }

      if (slideData.notes) {
        slide.addNotes(String(slideData.notes))
      }
    }
  }

  const output = await pptx.write({ outputType: 'nodebuffer' })
  return Buffer.from(output as unknown as ArrayBuffer)
}

async function writeXlsx(content: any): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()

  if (content.sheets && Array.isArray(content.sheets)) {
    for (const sheetData of content.sheets) {
      const ws = workbook.addWorksheet(sheetData.name || 'Sheet1')

      if (sheetData.headers && Array.isArray(sheetData.headers)) {
        const headerRow = ws.addRow(sheetData.headers)
        headerRow.font = { bold: true }
      }

      if (sheetData.rows && Array.isArray(sheetData.rows)) {
        for (const row of sheetData.rows) {
          ws.addRow(row)
        }
      }
    }
  } else if (typeof content === 'string') {
    // Fallback: write raw text to a single sheet
    const ws = workbook.addWorksheet('Sheet1')
    for (const line of content.split('\n')) {
      ws.addRow([line])
    }
  }

  if (workbook.worksheets.length === 0) {
    workbook.addWorksheet('Sheet1')
  }

  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer)
}

// ---- Tool definitions ----

const readDocument: ToolModule = {
  definition: {
    name: 'read_document',
    description: 'Read an office document (DOCX, DOC, PPTX, XLSX, XLS, PDF, CSV) from the workspace. Returns structured text content extracted from the document.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Document file path relative to workspace root' },
      },
      required: ['path'],
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const relPath = String(input.path)
    const ext = path.extname(relPath).toLowerCase()

    try {
      const buffer = await ctx.workspace.readFileRaw(relPath)
      let text: string

      switch (ext) {
        case '.docx':
          text = await readDocx(buffer)
          break
        case '.doc':
          text = await readDoc(buffer)
          break
        case '.pptx':
          text = await readPptx(buffer)
          break
        case '.xlsx':
        case '.xls':
          text = await readXlsx(buffer)
          break
        case '.pdf':
          text = await readPdf(buffer)
          break
        case '.csv':
          text = readCsv(buffer)
          break
        default:
          return { summary: `Unsupported document format: ${ext}. Supported: .docx, .doc, .pptx, .xlsx, .xls, .pdf, .csv`, error: true }
      }

      return {
        summary: `Read document ${relPath} (${text.length} chars)`,
        data: { path: relPath, format: ext.slice(1), content: text },
      }
    } catch (err) {
      return { summary: `Error reading document ${relPath}: ${(err as Error).message}`, error: true }
    }
  },
}

const writeDocument: ToolModule = {
  definition: {
    name: 'write_document',
    description: 'Create an office document (DOCX, PPTX, XLSX) in the workspace. Provide structured content as JSON and the tool generates a real binary document.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output file path (extension determines format: .docx, .pptx, .xlsx)' },
        content: { type: 'string', description: 'JSON string with document structure. DOCX: { title, sections: [{ heading, paragraphs, body, table: { headers, rows } }] }. PPTX: { title, slides: [{ title, bullets, body, notes }] }. XLSX: { sheets: [{ name, headers, rows }] }.' },
      },
      required: ['path', 'content'],
    },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const relPath = String(input.path)
    const ext = path.extname(relPath).toLowerCase()

    // Parse content JSON
    let content: any
    try {
      content = typeof input.content === 'string' ? JSON.parse(input.content) : input.content
    } catch {
      return { summary: 'Invalid content JSON', error: true }
    }

    try {
      let buffer: Buffer
      let displayName: string

      switch (ext) {
        case '.docx':
          buffer = await writeDocx(content)
          displayName = path.basename(relPath)
          break
        case '.pptx':
          buffer = await writePptx(content)
          displayName = path.basename(relPath)
          break
        case '.xlsx':
          buffer = await writeXlsx(content)
          displayName = path.basename(relPath)
          break
        default:
          return { summary: `Unsupported document format: ${ext}. Supported: .docx, .pptx, .xlsx`, error: true }
      }

      // Write binary to workspace
      await ctx.workspace.writeFile(relPath, buffer)

      const artifact = makeArtifact(ctx.conversationId, relPath, displayName, ext)

      return {
        summary: `Created document ${relPath} (${buffer.length} bytes, ${ext.slice(1).toUpperCase()})`,
        artifacts: [artifact],
        data: { path: relPath, size: buffer.length, format: ext.slice(1) },
      }
    } catch (err) {
      return { summary: `Error writing document ${relPath}: ${(err as Error).message}`, error: true }
    }
  },
}

export const documentTools: ToolModule[] = [readDocument, writeDocument]
