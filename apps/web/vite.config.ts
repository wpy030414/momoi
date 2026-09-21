import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import dotenv from 'dotenv'
import { readdirSync, statSync, readFileSync, writeFileSync } from 'fs'
import { gzipSync, brotliCompressSync, constants as zlibConstants } from 'zlib'

// Read .env from the repo root (up two levels from apps/web/)
dotenv.config({ path: path.resolve(import.meta.dirname, '../../.env') })
const apiPort = process.env.PORT || '11408'

// Inline gzip + brotli pre-compression.  Hand-rolled instead of
// vite-plugin-compression so both formats are produced in a single dir walk
// (the library's module-level mtimeCache is shared across instances, so two
// plugin instances silently skip whichever runs second).
const EXT_RE = /\.(js|mjs|json|css|html)$/i
function compressionPlugin(options?: { threshold?: number }): Plugin {
  const threshold = options?.threshold ?? 1500
  return {
    name: 'vite:compression',
    apply: 'build',
    enforce: 'post',
    closeBundle() {
      const outDir = path.resolve(import.meta.dirname, '../server/dist/client')
      if (!statSync(outDir, { throwIfNoEntry: false })?.isDirectory()) return
      walk(outDir)
      function walk(dir: string) {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) { walk(full); continue }
          if (!EXT_RE.test(entry.name)) continue
          const buf = readFileSync(full)
          if (buf.length < threshold) continue
          writeFileSync(full + '.gz', gzipSync(buf, { level: zlibConstants.Z_DEFAULT_COMPRESSION }))
          writeFileSync(full + '.br', brotliCompressSync(buf, {
            params: {
              [zlibConstants.BROTLI_PARAM_QUALITY]: zlibConstants.BROTLI_DEFAULT_QUALITY,
            },
          }))
        }
      }
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    compressionPlugin({ threshold: 1024 }),
  ],
  build: {
    outDir: '../server/dist/client',
    emptyOutDir: true,
    // 老内核兼容：钉钉 Android 内置浏览器 < Chrome 104，不认识 Media Queries L4
    // 的范围语法（width>=768px）。默认目标会把 (min-width:768px) 压缩成范围语法，
    // 老内核会丢弃整条 @media —— 侧边栏等所有响应式样式会静默失效。
    // 锁定较老的 CSS 目标，强制输出 (min-width: 768px) 的传统写法。
    cssTarget: 'chrome79',
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          // React 核心：体积不大但缓存价值高，业务代码变动时不受影响
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'vendor-react'
          }
          // Radix UI 组件集：稳定、频繁引用、跨版本变更少
          if (id.includes('node_modules/@radix-ui/')) {
            return 'vendor-radix'
          }
          // 图标库：导入分散在 27 个文件中，统一分块避免分散到各业务 chunk
          if (id.includes('node_modules/lucide-react/')) {
            return 'vendor-icons'
          }
          // 国际化：仅语言切换时下载，不影响首屏
          if (id.includes('node_modules/i18next/') || id.includes('node_modules/react-i18next/')) {
            return 'vendor-i18n'
          }
          // 其余 node_modules 交给 Rolldown 默认拆分策略
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
})