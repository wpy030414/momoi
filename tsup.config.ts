import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/server/index.ts'],
  format: ['esm'],
  clean: true,
  outDir: 'dist',
  // sql.js: WASM file stays in node_modules; sql.js locates it at runtime.
  // pg: optionalDependency — only loaded when DATABASE_URL is configured.
  // ws: pure-JS with optional native addons — stays external like the others.
  external: ['sql.js', 'pg', 'ws'],
})