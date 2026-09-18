import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  clean: true,
  outDir: 'dist',
  // sql.js / pg / ws stay external (native WASM / optional / optional native addons).
  // @momoi/shared is forced inlined so apps/server/dist/ is self-contained.
  external: ['sql.js', 'pg', 'ws'],
  noExternal: ['@momoi/shared'],
})