import { defineConfig } from 'vite-plus'

// vp pack（tsdown）承接原 tsup 配置。pack 块就是构建设置入口，不再另建 tsup.config.ts。
export default defineConfig({
  pack: {
    entry: ['src/index.ts'],
    format: ['esm'],
    clean: true,
    outDir: 'dist',
    platform: 'node',
    dts: false,
    // tsdown 的 ESM 默认产物是 .mjs；固定为 .js，与 start 脚本（node dist/index.js）一致
    outExtensions: () => ({ js: '.js' }),
    deps: {
      // pg / ws 保持外部（可选依赖 / 可选原生插件）
      neverBundle: ['pg', 'ws'],
      // @momoi/shared 强制内联，使 dist/ 自包含；其余依赖从 node_modules 运行时解析
      alwaysBundle: ['@momoi/shared/**'],
    },
  },
})
