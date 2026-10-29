import { defineConfig } from 'vite-plus'

// workspace 级 fmt / lint 配置；各子包执行 vp check 时向上读取本文件。
export default defineConfig({
  fmt: {
    semi: false,
    singleQuote: true,
    // 既有代码按 prettier 风格书写，首次接入 oxfmt 不做全仓重排
    ignorePatterns: ['**/node_modules/**', '**/dist/**', 'docs/**', 'skills/**', 'data/**'],
  },
  lint: {
    // 必须显式排除，否则 vp lint 会扫描 node_modules
    ignorePatterns: ['**/node_modules/**', '**/dist/**', '**/public/**', 'docs/**', 'skills/**', 'data/**'],
    // 类型感知暂不启用：首次接入，先保证基础规则零错误，再逐步收紧
    options: { typeAware: false, typeCheck: false },
  },
})
