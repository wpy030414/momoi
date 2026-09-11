import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import dotenv from 'dotenv'

// Follow the backend port configured in .env (same default as src/server/config.ts)
dotenv.config()
const apiPort = process.env.PORT || '11408'

export default defineConfig({
  plugins: [react()],
  root: 'src/client',
  build: {
    outDir: '../../dist/client',
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
