import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// Static SPA, no backend. dist/ is what the Cloudflare Worker serves as assets.
//
// web-ifc fetches its own .wasm at runtime. import/ifc.ts resolves that path with
// `new URL(..., import.meta.url)` so Vite emits it as a hashed asset and it stays
// same-origin — the CSP has no external connect source, so a CDN default would be blocked.
export default defineConfig({
  // The About dialog shows the version the build actually produced. about-data.js
  // carries one baked at sync time as a fallback, and it goes stale the moment a
  // release is tagged; this is the one that is always right.
  define: { __APP_VERSION__: JSON.stringify(`v${pkg.version}`) },
  plugins: [react()],
  base: './',
  assetsInclude: ['**/*.wasm'],
  // Honour PORT so more than one dev server can run at once. Vite does not read it itself.
  server: { port: process.env.PORT ? Number(process.env.PORT) : undefined },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // three and web-ifc are both large. Rollup's default splitting handles them; an
    // explicit manualChunks map is not worth the config churn across Vite majors.
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
