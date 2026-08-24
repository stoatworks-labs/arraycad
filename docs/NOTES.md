# Notes

Working notes for this repo: status, decisions, and the traps that have actually bitten.
Migrated out of Claude Code's memory on 2026-08-24, so they are written in the first
person and dated by when each thing was learned — that date is usually the useful part.

Cross-cutting notes that are not specific to this repo live in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).

*ArrayCAD — CAD to d&b ArrayCalc .dbacv converter: browser SPA on a Worker plus a Vectorworks Python plug-in. Output VERIFIED by three ArrayCalc round trips; the VW plug-in has still never been run. Also writes L-Acoustics Soundvision .txt, NOT yet opened in Soundvision*

**PUBLIC since 2026-08-05** — the private-repo statements below are historical; the repo, its Docker packaging and its `/software` page are all live. See [browser tools published](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/project_browser_tools_published.md).

**ArrayCAD** (`~/Projects/arraycad`, created 2026-08-01, renamed from "Venue Forge" the
same day) converts CAD venue models into d&b ArrayCalc venue files. Two halves:

1. **Browser SPA** — React + TS + Vite + three.js on a Cloudflare static-assets Worker,
   same shape as [aspect calc](https://github.com/stoatworks-labs/aspect-calc/blob/main/docs/NOTES.md) (`aspect-calc`) / [blend calc](https://github.com/stoatworks-labs/blend-calc/blob/main/docs/NOTES.md) (`blend-calc`) / [pixel peeker](https://github.com/stoatworks-labs/pixel-peeker/blob/main/docs/NOTES.md) (`pixel-peeker`).
   Imports DXF, **DWG natively**, glTF/GLB, IFC (web-ifc), FBX/Collada/3DS/OBJ/PLY/STL and
   `.dbacv` itself. 253 tests.
2. **Vectorworks plug-in** — `vectorworks/`, Python 3.9 (the interpreter VW bundles).
   Runs *inside* Vectorworks so it can read class names, which any export throws away, and
   apply venue-specific tricks: a seating solid becomes its top face, a lighting bridge
   becomes one ArrayCalc `Shape=4` box. 80 tests, none needing Vectorworks.

The core insight: an ArrayCalc venue is a few dozen parametric planes, a CAD export of the
same theatre is tens of thousands of triangles. Coplanar region merging IS the conversion.
Format details and traps in [dbacv format](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_dbacv_format.md).

**2026-08-02: two more capabilities, two more videos.** A **tracer** (`src/lib/trace/`)
turns a PDF or an image of a plan into the same `ImportedScene` every importer produces —
calibrate the sheet, flood-fill or hand-trace regions, type a height at each corner
(least-squares plane fit by default). And a **Soundvision 3D room data `.txt`** export
beside the `.dbacv` one. Shipped as two separate commits; `demo/demo-plan.pdf` is the
synthetic 1:200 sheet to trace. Three videos now: reducer tour `g5TH-Y7cWNs`, tracing
`Ky7lkRAa8qE`, Soundvision `w2-KEFSz1Mk`.

**v0.2.0, released 2026-08-03: rationalisation.** `src/lib/geom/rationalise.ts` closes the one gap
`planarize.ts` structurally cannot: a plan that models every seat separately, where the
surfaces genuinely do not touch, so the flood fill is right to report hundreds of regions.
Select / box-select / draw round them and they become one fitted plane. It emits
`RegionOutline[]` (not an `ImportedNode`), which is what lets both output targets pick it
up for free and why it never inverts the transform. New fixture
`demo/demo-seats.dxf` — **3,710 objects on import, 16 after rationalising** — with the rake
and step pitch written into `scripts/make_demo_seats.py` so the tests assert them. Full
rationale in AGENTS.md §11. **Video `HFZKeIwCB5k`** — the FOURTH arraycad video, and now the
one `webtools.json` points at. Deployed and verified live.

Two framing facts for the next take, both in `arraycad-rationalise/build.py`: the burnt-in
caption sits bottom-left, **exactly where the stats row is**, so a closing count must use
the WHOLE frame — at the STATS crop the number the video is built on is behind its own
caption. And the Rationalise panel grows downward, so it needs two focus boxes.

**Only `/web-tools` renders a video for this project** — it is `public: false`, so there
is no `/software/arraycad/` page and `projects.json`'s `youtube` is never drawn. Put the
video that matters in `webtools.json`.

v0.1.0, released 2026-08-02. **PRIVATE repo** `stoatworks-labs/arraycad` — same as every
sibling web tool, and because `docs/dbacv-format.md` is a full reverse-engineering
write-up of d&b's format. **LIVE at arraycad.stoatworks-labs.com**, listed on /web-tools,
video published as `g5TH-Y7cWNs` plus an Instagram reel.

Ships a **synthetic demo venue** (`scripts/make_demo_venue.py` → `demo/demo-venue.dxf`,
3,206 triangles → 80 regions). Use that for videos and screenshots — the theatre fixture
is a real building and must not appear publicly. `scripts/shoot.mjs` takes the doc
screenshots over CDP.

## Verification status

**The output is verified.** Three round trips through real ArrayCalc 12.8.2: diagnostic
venues written by this code were opened, saved and exported, and by the third round
**every object came back byte-identical**. Frozen as `src/lib/dbacv/roundtrip.test.ts`
with the sent and returned files as fixtures — that evidence needs a human with ArrayCalc
to reproduce, so it must not be allowed to rot.

Round 1 **failed** and caught a serious bug: quads written with a centroid origin were
silently collapsed to zero depth. See [dbacv format](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_dbacv_format.md).

**Still unverified**: `vectorworks/arraycad/vwbridge.py` has never been executed — its
`vs` API names were read out of the VW2025 binary (so they exist) but signatures are
unconfirmed. `arraycad_probe.py` exists to resolve that. See
[vectorworks python api](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_vectorworks_python_api.md).

Rectangle fit gives exactly **one canonical quad per region** (level-aligned rectangles);
exact fit splits any face that is not a symmetric trapezoid into two triangles, and the UI
shows a `split into triangles` count so the object total is explicable.

The Python port is a deliberate second implementation and **will drift**; the guard is
shared test cases. It has already caught two: `g17` taking its exponent from a 6-digit
`%e` probe, and a plane-type rename that left the plug-in entry point importing dead names
(now covered by `test_plugin_entrypoints.py`, which stubs `vs`).

The CSP needs `'wasm-unsafe-eval'` (unique in the fleet) for web-ifc.

## DWG and the DXF rewrite (2026-08-02)

**DWG is read natively** via `@node-projects/acad-ts` — **MIT, pure TypeScript, no WASM**
(so no CSP change), behind a dynamic import (135 kB gzipped chunk). Verified on a real
AC1021/R2007 file. libredwg is the obvious alternative and is **GPL-3, which would
relicense this MIT app**; several npm packages wrap it in WASM and declare themselves MIT,
which they cannot do — check contents, not the licence field.

DXF and DWG **share `src/lib/import/entities.ts`**; `dxf.ts` and `dwg.ts` are translations
into `CadDocument` and hold no geometry. Same no-forking rule as `geom/outline.ts`.

DXF import was badly broken and is rewritten: LINE entities were discarded outright and
arcs were filled as pie sectors. `import/chain.ts` now recovers rings from loose segments.
Traps in [dxf dwg parser traps](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_dxf_dwg_parser_traps.md).

Verified by importing the **same drawing as both `.dwg` and `.dxf`** — every shared layer
matches to 1e-6 on triangle count and bounding box.

## Second output target: L-Acoustics Soundvision (added 2026-08-02)

Writes **3D room data `.txt`**, not the native `.xmls` — that is encrypted and unwritable.
See [soundvision roomdata format](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_soundvision_roomdata_format.md). `src/lib/soundvision/` mirrors
`src/lib/dbacv/`, and both now share the reduction via `src/lib/geom/outline.ts`; adding a
target must never fork `planarize`.

Better fit than ArrayCalc: a Soundvision surface is a free polygon, so a six-sided region
stays ONE surface where `.dbacv` splits it into triangles.

**LIVE since 2026-08-02.** The export button carried an "(experimental)" tag for a few
hours; **that tag is gone, because the import is now VERIFIED** — see below.

The **browser app only** — the Vectorworks Python plug-in still writes `.dbacv` alone.

## Soundvision import VERIFIED, 2026-08-02

A four-surface probe written by `writeSoundvision` was imported into **Soundvision
3.18.0.15 (2026.2)** and read back off the Properties panel. Every point matched what was
written, in order: a 20×12 m floor, a rake rising 0→3 m, a **6-point polygon that stayed
ONE surface**, and a vertical wall that stayed vertical. Settled two of the open questions —
the `"; written by ArrayCAD"` header line is tolerated, and Soundvision **strips the
trailing ` face` from a label itself**, so both ends agree with the importer.

**Still open: whether an imported surface actually PREDICTS.** Geometry landing correctly
and a mapping result are different claims, and a backwards surface fails the second one
silently. Needs a source placed on the scene and a prediction run. The `'up'` winding
default remains the likeliest thing to want revisiting. Details and the AX-automation
recipe in [soundvision roomdata format](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_soundvision_roomdata_format.md).

## Cross conversion: both venue formats are INPUTS (2026-08-02)

`.dbacv` and Soundvision `.txt` both import, so ArrayCAD converts **between the two
prediction packages** in either direction, not just into them. `.dbacv` import already
existed; `src/lib/import/soundvisionScene.ts` is the new half. No special path — both
importers emit the ordinary `ImportedScene` and take the same road a DXF takes.

Two things that pairing depends on:

- **`soundvisionScene.ts` strips the plug-ins' trailing ` face`, because `convert.ts`
  re-applies it.** Break the pairing and a name grows a word per conversion: "Seating face
  face", then "Seating face face face". `pipeline.test.ts` runs three round trips on it.
- **A `.txt` is sniffed (`isSoundvisionText`) before it is claimed** — the extension
  declares nothing, and a file that is not room data must say so rather than import as an
  empty venue.
