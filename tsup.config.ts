import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/server/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
  // sql.js: WASM file stays in node_modules; sql.js locates it at runtime.
// pg / mysql2: optionalDependencies — only loaded when DATABASE_URL is configured.
external: ['sql.js', 'pg', 'mysql2'],
})