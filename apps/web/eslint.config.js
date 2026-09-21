import parser from '@typescript-eslint/parser'
import reactHooks from 'eslint-plugin-react-hooks'

/**
 * Minimal React-hooks-focused ESLint config.
 *
 * Goal: catch Rules-of-Hooks violations at lint time. The login/logout
 * white-screen bug (bde107b) was exactly this — hooks placed after
 * conditional early returns — and only crashed at runtime, unmounting the
 * whole tree (now softened by the root ErrorBoundary from f5f0c86).
 *
 * Only two rules are enabled on purpose. The plugin v7
 * `configs.flat['recommended-latest']` preset turns on 16 additional
 * compiler-era rules (purity / immutability / static-components / …) which
 * would flood this codebase today; opt in gradually instead.
 */
export default [
  {
    ignores: ['dist/**'],
  },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // Hook 调用必须无条件、顺序稳定 —— 违反即崩（整树卸载）
      'react-hooks/rules-of-hooks': 'error',
      // 依赖数组缺失 —— 提示性警告，按需修复
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
]
