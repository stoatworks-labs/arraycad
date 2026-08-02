import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Static SPA, no backend. dist/ is what the Cloudflare Worker serves as assets.
//
// web-ifc fetches its own .wasm at runtime. import/ifc.ts resolves that path with
// `new URL(..., import.meta.url)` so Vite emits it as a hashed asset and it stays
// same-origin — the CSP has no external connect source, so a CDN default would be blocked.
export default defineConfig({
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
