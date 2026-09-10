import fs from 'fs'
import path from 'path'
import type { Context, Next } from 'hono'
import { getMimeType } from 'hono/utils/mime'

const clientDist = path.resolve('dist/client')

/**
 * Serve the production client build: /assets/* from dist/client/assets,
 * everything else falls back to index.html (SPA).
 *
 * Hand-rolled instead of @hono/node-server/serve-static — that subpath
 * module hangs `tsx watch` on Windows when stdout is a pipe (e.g. under
 * concurrently). See https://github.com/privatenumber/tsx/issues/623
 */
export const serveClient = async (c: Context, next: Next) => {
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next()

  let file = ''
  let rel = ''
  try {
    rel = decodeURIComponent(c.req.path).replace(/^\/+/, '') || 'index.html'
    const candidate = path.join(clientDist, rel)
    // Path traversal guard: resolved path must stay inside clientDist
    if (candidate.startsWith(clientDist + path.sep)) file = candidate
  } catch {
    file = ''
  }

  if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
    // Vite 产物带内容哈希：assets/* 可长缓存；其余（index.html 等）不得缓存，
    // 否则内置浏览器（钉钉/微信）会长期吃旧 HTML，新版本发布后无法生效。
    const isHashed = rel.startsWith('assets/')
    return c.body(fs.readFileSync(file), 200, {
      'Content-Type': getMimeType(file) ?? 'application/octet-stream',
      'Cache-Control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
  }

  // SPA fallback — index.html 永不缓存，保证发版即时生效
  const index = path.join(clientDist, 'index.html')
  if (fs.existsSync(index)) {
    return c.body(fs.readFileSync(index), 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    })
  }

  return next()
}
