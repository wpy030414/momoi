import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | undefined

/**
 * Nearest ancestor directory containing pnpm-workspace.yaml — the repo root.
 *
 *   dev  (tsx):  apps/server/src/paths.ts  wobbles up to <root>
 *   prod (node): apps/server/dist/index.js wobbles up to <root>
 *
 * When deployed as a bare dist/ tarball (no workspace marker), falls back to
 * `process.cwd()` so behaviour matches the pre-monorepo code.
 */
export function repoRoot(): string {
  if (cached !== undefined) return cached
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return (cached = dir)
    const parent = dirname(dir)
    if (parent === dir) return (cached = process.cwd())
    dir = parent
  }
}