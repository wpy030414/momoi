import { defineConfig } from 'vitest/config'

// 独立的 vitest 配置：vite.config.ts 的 root 指向 src/client（前端构建），
// 若由它接管，vitest 只会扫描 src/client，服务端测试无法被发现。
export default defineConfig({
  test: {
    root: '.',
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
  },
})
