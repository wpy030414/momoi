import { Hono } from 'hono'
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve docs/ relative to this file's location.
//   dev  (tsx):  import.meta.url → src/server/routes/docs.ts  →  ../../../docs = <root>/docs
//   prod (tsup): import.meta.url → dist/index.js              →  ../docs     = <root>/dist/docs
// We try both candidates and pick the first that exists.
const _filename = fileURLToPath(import.meta.url)
const _dirname = dirname(_filename)

function resolveDocsDir(): string {
  const candidates = [
    resolve(_dirname, '..', '..', '..', 'docs'), // dev:  src/server/routes → root/docs
    resolve(_dirname, 'docs'),                   // prod: dist/             → dist/docs
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  // Fallback: prefer cwd-based (preserves old behaviour as last resort)
  return join(process.cwd(), 'docs')
}

const docsDir = resolveDocsDir()

interface DocEntry {
  title: string
  path: string
  group: string
}

async function listDocsRecursive(dir: string, base: string, group: string): Promise<DocEntry[]> {
  const entries: DocEntry[] = []
  let items: string[]
  try {
    items = await readdir(dir)
  } catch {
    return entries
  }
  for (const name of items) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    const relPath = relative(base, full).replace(/\\/g, '/')
    const st = await stat(full)
    if (st.isDirectory()) {
      entries.push(...await listDocsRecursive(full, base, name))
    } else if (st.isFile() && name.endsWith('.md')) {
      const content = await readFile(full, 'utf-8')
      // Extract title from first H1 heading
      const titleMatch = content.match(/^#\s+(.+)/m)
      const title = titleMatch ? titleMatch[1] : name.replace(/\.md$/, '')
      entries.push({ title, path: relPath, group })
    }
  }
  return entries
}

export const docsRoute = new Hono()

// GET /api/docs — list all docs (metadata only)
docsRoute.get('/', async (c) => {
  const entries = await listDocsRecursive(docsDir, docsDir, '')
  return c.json(entries)
})

// GET /api/docs/:path{.md}? — serve a single doc file
docsRoute.get('/:path{.+}', async (c) => {
  const docPath = c.req.param('path')
  // Security: prevent directory traversal
  const safePath = join(docsDir, docPath).replace(/\\/g, '/')
  if (!safePath.startsWith(docsDir.replace(/\\/g, '/'))) {
    return c.json({ error: 'Invalid path' }, 403)
  }
  try {
    const content = await readFile(safePath, 'utf-8')
    return c.json({ content, path: docPath })
  } catch {
    return c.json({ error: 'Not found' }, 404)
  }
})