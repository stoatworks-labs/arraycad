# CLAUDE.md — Venue Forge

Command reference. For the model, the invariants and the traps, read
[AGENTS.md](AGENTS.md) first.

## Commands

```bash
npm install
npm run dev          # vite dev server
npm test             # vitest — 102 tests
npm run test:watch
npm run build        # tsc -b && vite build -> dist/
npm run preview      # serve the built dist/ (does NOT apply _headers)
npm run serve:dist   # serve dist/ WITH _headers applied — use this to check the CSP
npx tsc -b           # typecheck only
```

## Deploy

Static-assets Worker, not Cloudflare Pages.

```bash
cf-run npx wrangler deploy
```

Or connect the repo in the Cloudflare dashboard: build `npm ci && npm run build`,
deploy `npx wrangler deploy`.

## Ground rules

- **The plane-type labels are inferred, not documented.** Always show the raw numeric code
  next to them. Don't remove the caveat in the inspector until someone has actually
  checked them against ArrayCalc.
- Units and axes are applied in `geom/transform.ts` and nowhere else. Importers report
  what the format states; they never guess.
- `ParentVenueObjectId` is derived on write from depth-first document order. Never store it.
- Numbers go through `g17()`. Never `String(n)` — it breaks the byte-exact round trip.
- `src/lib/` stays free of three.js (bar `import/mesh.ts`) so the pipeline tests run in node.
- The CSP in `public/_headers` needs `'wasm-unsafe-eval'` for web-ifc. Removing it breaks
  IFC import only, which does not look like a CSP problem.

## The fixture is the ground truth

`test/fixtures/theatre.dbacv` is a real ArrayCalc 12.8.2 export. The round-trip test
reproduces it byte for byte. If that test fails, the format understanding has regressed —
fix that before anything else.
