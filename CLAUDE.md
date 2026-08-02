# CLAUDE.md — ArrayCAD

Command reference. For the model, the invariants and the traps, read
[AGENTS.md](AGENTS.md) first.

## Commands

```bash
npm install
npm run dev          # vite dev server
npm test             # vitest
npm run test:watch
npm run build        # tsc -b && vite build -> dist/
npm run preview      # serve the built dist/ (does NOT apply _headers)
npm run serve:dist   # serve dist/ WITH _headers applied — use this to check the CSP
npx tsc -b           # typecheck only
```

The Vectorworks plug-in is Python and has its own tests. None need Vectorworks:

```bash
python3 vectorworks/tests/run_all.py
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
- **Every output target shares `geom/outline.ts`.** ArrayCalc and Soundvision differ only in
  what they do with an outline. Do not fork the reduction to add a target.
- Soundvision `.xmls` is encrypted and is not writable — the target is 3D room data `.txt`.
  A surface wound clockwise is not an error there, it silently predicts nothing; winding is
  forced in `soundvision/convert.ts` and must stay that way. See `docs/soundvision-format.md`.
- The CSP in `public/_headers` needs `'wasm-unsafe-eval'` for web-ifc. Removing it breaks
  IFC import only, which does not look like a CSP problem.
- **DXF and DWG share `import/entities.ts`.** `dxf.ts` and `dwg.ts` are translations into
  `CadDocument` and hold no geometry. Do not fork the entity reduction to add a format —
  same rule as `geom/outline.ts`, same reason. See AGENTS.md §9 for the parser lies that
  silently change geometry (arc sweep sign, radians vs degrees).
- DWG is read by `@node-projects/acad-ts` — **MIT and pure TypeScript**, behind a dynamic
  import. libredwg is GPL-3 and would relicense this app; npm packages that wrap it in
  WASM and claim MIT are wrong. Don't swap the dependency without checking that.
- `vectorworks/` is a **second implementation** of the writer and the reduction, in Python
  3.9, because the plug-in runs inside Vectorworks' own interpreter. Change the reduction
  and you change it in both places — the shared test cases are what catch the drift.
- `vectorworks/arraycad/vwbridge.py` is the only code here that has never been executed.
  Its defensive `_call` wrapping is load-bearing; don't tidy it away.
- **Tracing keeps regions in PIXELS.** `trace/calibrate.ts` is the only place the sheet
  scale is applied, for the same reason `geom/transform.ts` owns units. Venue Y is
  `origin.y - py`, because raster rows run down and the venue runs up.
- `trace/source.ts` is the only browser-bound module under `lib/` besides `import/mesh.ts`,
  and is deliberately not re-exported from `trace/index.ts` — importing it drags in pdf.js
  and a DOM, and every other trace module has to stay testable in node.
- The `constructPath` argument shape in `trace/pdfPaths.ts` is pdf.js **internals**, pinned
  to v5. It is validated before use; a bump that changes it must show up as a warning and
  no geometry, never as wrong geometry.
- Regenerate the demo plan with `python3 scripts/make_demo_plan.py`.

## The fixture is the ground truth

`test/fixtures/theatre.dbacv` is a real ArrayCalc 12.8.2 export. The round-trip test
reproduces it byte for byte. If that test fails, the format understanding has regressed —
fix that before anything else.

`test/fixtures/roomdata.txt` does the same job for Soundvision. It is synthetic, written in
the exact byte format of a Vectorworks plug-in export; the writer was separately verified
byte for byte against a real 7,194-face export that is not in the repo.
