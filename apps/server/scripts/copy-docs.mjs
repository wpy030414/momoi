// Copy docs/ from repo root into dist/ for production serving.
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..', '..', '..')
const src = resolve(repoRoot, 'docs')
const dest = resolve(__dirname, '..', 'dist', 'docs')

if (existsSync(src)) {
  mkdirSync(dirname(dest), { recursive: true })
  cpSync(src, dest, { recursive: true })
  console.log(`[copy-docs] ${src} → ${dest}`)
}