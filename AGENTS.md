# AGENTS.md — bringing an LLM up to speed on ArrayCAD

Orientation for an AI assistant (or a new human) picking this project up cold.
`CLAUDE.md` holds the short command reference; this file explains the model and the traps.

---

## 1. What this is

A **CAD → d&b ArrayCalc venue converter**. Browser-only, no backend: React + TypeScript +
Vite, built to a static `dist/` and served by a Cloudflare Worker with static assets. Same
shape as blend-calc, pixel-peeker and aspect-calc.

It imports a CAD model, reduces its triangles to flat planes, lets the user prune and
classify them, and writes a `.dbacv`.

It writes **L-Acoustics Soundvision** too, as a 3D room data `.txt`. Soundvision's native
`.xmls` is AES-256-CBC encrypted with a runtime-assembled key and cannot be written from
outside, so the target is the unencrypted interchange format its own SketchUp and
Vectorworks plug-ins produce. See `docs/soundvision-format.md`.

**Both venue formats are also inputs**, which makes the tool a converter *between the two
prediction packages* and not only into them. `.dbacv` in / `.txt` out, or the reverse. There
is no special path for it: `dbacvScene.ts` and `soundvisionScene.ts` produce the ordinary
`ImportedScene`, and the reduction, the tree, the pruning and the plane typing are the same
ones a DXF gets. Adding a third venue format means adding a third importer and nothing else.

It also **traces one off a plan**. A PDF or an image has no model in it at all, so the
tracer builds one: the user calibrates the sheet, outlines regions (by hand or by flood
fill), and types a height at each corner. What comes out is the same `ImportedScene` every
importer produces, so from there the road is identical. See §8.

## 2. Layout

```
src/
  lib/dbacv/            THE FORMAT. types / read / write, + a byte-exact round-trip test
  lib/import/           one importer per format, all producing ImportedScene
    types.ts            the intermediate model every importer must produce
    mesh.ts             OBJ STL PLY glTF FBX DAE 3DS, via three.js loaders
    entities.ts         THE VECTOR-CAD CORE: entities -> triangles. Shared by DXF and DWG
    chain.ts            loose LINE/ARC segments -> closed rings. See §9
    dxf.ts              dxf-parser -> CadDocument. A translation, no geometry
    dwg.ts              acad-ts -> CadDocument. A translation, no geometry
    seats.ts            do a drawing's rows of seats agree with its stated units? WARNS only
    ifc.ts              web-ifc wasm; the only source of plane-type suggestions
    mvr.ts              thin: the archive + three.js seam. All the logic is in lib/mvr/
    dbacvScene.ts       an existing venue, tessellated, so it can be pruned
    soundvisionScene.ts an existing Soundvision room, ditto. With dbacvScene, §1's converter
    index.ts            extension dispatcher + the closed-format guidance table
  lib/trace/            THE TRACER: a 2D drawing -> an ImportedScene. See §8
    types.ts            the trace document; regions live in PIXELS, never metres
    source.ts           PDF/image -> raster + vector paths. The only browser-bound module
    raster.ts           pixels -> the ink mask everything else reads
    detect.ts           flood fill, boundary recovery, contours, the snap index
    pdfPaths.ts         pdf.js operator list -> polylines. Version-fragile, guarded
    calibrate.ts        pixels -> metres. The ONLY place the sheet scale is applied
    heights.ts          typed corner heights -> a least-squares surface
    build.ts            regions -> ImportedScene, and from there the ordinary pipeline
    cad.ts              a flat DXF/DWG plan -> a sheet, already calibrated. Pure; see §8
  lib/mvr/              THE VISUALISERS' FORMAT. MVR — open, so quoted not deduced
    types.ts            the object model, the 4x3 matrix, and the unit constants
    container.ts        the zip, opened twice so a show's .gdtf payload is never inflated
    read.ts             GeneralSceneDescription.xml -> MvrScene. A translation, no geometry
    scene.ts            matrices, symbol instancing, units, tagging. Three-free on purpose:
                        the decoder is injected, so all of it is tested in node
    convert.ts          outlines -> objects. The ONLY target that does not reduce
    write.ts            GeneralSceneDescription.xml + the zip, with stable uuids
    glb.ts              a minimal glb: one mesh, positions only. Hand-rolled, no three
  lib/soundvision/      THE OTHER FORMAT. Soundvision 3D room data .txt
    types.ts            faces, the scene, and the header a real export begins with
    read.ts             parser, mostly so the writer can be proved by round trip
    write.ts            serialiser + the winding rule Soundvision fails silently on
    convert.ts          outlines -> surfaces. The short half; the reduction is shared
  lib/geom/             THE ENGINE
    vec.ts              small vector maths, deliberately three-free
    planarize.ts        weld + coplanar flood fill. The module that makes this possible
    polygon.ts          boundary loops, simplification, quad/triangle fitting
    transform.ts        units, up-axis, datum. The ONLY place these are applied
    outline.ts          the SHARED reduction: ImportedNode -> planar outlines
    rationalise.ts      many objects -> ONE outline. The case outline.ts cannot reach
    convert.ts          the ArrayCalc half: outlines -> RoomObject
  lib/prepare/          what the file already says, decided at import. See §12
    vocabulary.ts       names -> categories, as plain word lists
    plan.ts             names, repetition and shape -> DECISIONS. Never a scene edit
    split.ts            a one-piece mesh -> rakes, floor, ceiling, walls. See §12
    simplify.ts         heavy flat regions re-cut from their own outlines
  lib/realVenues.test.ts  real venues' published drawings. LOCAL ONLY; see §7
  components/           Viewport (three.js), Tree, Inspector, TraceEditor, TracePanel, ui
  state.ts              decisions, settings, the debounced conversion hook
vectorworks/            a SECOND implementation, in Python 3.9, for the VW plug-in
test/fixtures/theatre.dbacv   a real ArrayCalc 12.8.2 export. The ground truth
test/fixtures/roomdata.txt    a synthetic Soundvision export, in the exact byte format
docs/dbacv-format.md    everything known about the format, and what is not known
docs/soundvision-format.md    ditto for Soundvision, incl. why .xmls is not writable
docs/mvr-format.md      MVR: quoted from the open spec, plus the ONE thing it does not state
```

**Every output target shares `geom/outline.ts` and differs only after it.** The reduction is
the whole value of this tool; a second copy of it would drift the way the TypeScript and
Python writers already did once (§6).

**`src/lib/` is pure and three-free** (except `import/mesh.ts`, which needs the loaders,
and `trace/source.ts`, which needs a canvas and pdf.js). The whole conversion runs in node,
which is why the whole suite runs in node without a browser.

## 3. The one thing to understand

An ArrayCalc venue is a few dozen parametric planes. A CAD export of the same room is tens
of thousands of triangles. **`planarize.ts` is what closes that gap** and everything else
is plumbing around it. If output object counts look wrong, start there.

Flood fill compares each candidate triangle against the **region's accumulated plane**, not
against its neighbour. That is deliberate and there is a test for it: pairwise comparison
walks all the way around a cylinder one tolerable step at a time and swallows the whole
thing into one region.

## 4. Invariants

### The imported scene is immutable

Every user decision lives in `Decisions`, keyed by node id, separate from the scene.
Conversion is a pure function of `(scene, decisions, settings)`. Changing the unit setting
after an hour of pruning must not throw the pruning away.

### Units and axes are applied in exactly one place

`geom/transform.ts`. Importers hand over **raw source coordinates** and only *declare* what
they know (`unitsPerMetre`, `upAxis`) when the format actually states it. Two importers
each doing their own half-correct unit guess is how a model ends up 25.4× too big in one
axis only.

The guesses for what a format does NOT state live beside the transform, not in an importer:
`guessUnits` from the model's size, and `guessUpAxis` from the way its surfaces face. The
axis that the most surface area faces along is the vertical one, sign-free, because a floor
wound downwards is as level as one wound up; Blender, three.js and media-server OBJs are
Y-up, and the old Z default stood disguise's stock theatre on its back. `settingsForScene`
applies both, and the UI labels both as guesses.

**Stated is not the same as right.** The National Taichung Theater's published DWGs state
millimetres and are drawn in centimetres. `import/seats.ts` reads that off the drawing's own
seats — rows of one block at half a metre in some metric power of ten of the stated unit —
and adds `ImportedScene.unitsDoubt` and a warning. It never changes `unitsPerMetre`: a
layout that looks like seating is evidence, and the setting is the user's. Only powers of ten
are suggested, because a 0.2 m fly-bar pitch read as inches is a plausible seat.

### `ParentVenueObjectId` is derived on write, never stored

It is the parent's 1-based depth-first document index. Recomputing it on every write is
what makes pruning safe — delete anything and the rest renumbers itself. Tested.

### Numbers are written as `%.17g`

Not as `String(n)`. `g17()` in `write.ts` matches C, which is what makes the round-trip
byte-exact and a diff against a real ArrayCalc export meaningful.

## 5. Traps

### A quad is NOT four free points

`Shape=1` must be written in ArrayCalc's canonical frame — origin on the **near edge**,
symmetric trapezoid, rotation about Z only, `depth` may be zero for a vertical plane. See
`dbacv/quad.ts`. Write it the obvious way (centroid origin) and ArrayCalc collapses the
plane to zero depth **with no error**, and does so only sometimes: a bad quad survives at
top level and dies later when it ends up under a rotated group. Quads that cannot be
expressed become two triangles, which are unconstrained.

This cost the project a whole round trip to find. Do not "simplify" `canonicalQuad` away.

### A Positioning area must be rectangular

`PlaneType 5` is ArrayCalc's "Positioning area" and it refuses a non-rectangular one — it
offers to transform the plane or to change the type, and both damage the venue. `convert.ts`
therefore forces rectangle fit for that plane type regardless of the fit setting, and warns.

### The plane-type labels are only partly guesses

Two names now come from ArrayCalc itself: **5 is "Positioning area"** and its dialog also
names a **"Listening"** type, which is almost certainly 1 — the only type that keeps a
user-set `ListenerHeight` (2 is silently forced to 0.01). **3 is a real type** that
ArrayCalc accepts and preserves, but its name is unknown. **0 is groups-only** and is
coerced to 1 on a real object.

`Surface` and `Stage` are still guesses. The UI shows the raw numeric code beside every
label for exactly that reason — do not quietly drop the caveat from the inspector.

### Groups write their transform AFTER their children

And that transform **composes** — child origins are relative to it. Evidence is in
`docs/dbacv-format.md` §7. A round trip confirms ArrayCalc preserves a group's Origin,
Rotation and Scaling unchanged and does not bake them into children, so the hierarchy is
real; whether rotation and scaling are *applied* when drawing is still unconfirmed by eye.

### A backwards Soundvision surface predicts nothing, and says nothing

Soundvision requires surface points counter-clockwise. A face wound the other way is **not**
an error — it simply returns no mapping result. A CAD model whose floor triangles wind
downwards therefore imports into a venue that looks right and predicts nothing.

`soundvision/convert.ts` forces each ring counter-clockwise in its own plane frame first (so
the face normal is the region normal, not its opposite), and `orientFace(…, 'up')` then
flips any near-horizontal face still pointing down. Vertical faces are deliberately left
alone: a wall has no correct side without knowing which way the room is. Same family as the
Y-up handedness trap below, and tested the same way.

### A Soundvision label carries a suffix, so the importer must take it off

The stock plug-ins label every face `"<layer name> face"` and `soundvision/convert.ts`
writes the same, deliberately, so an ArrayCAD export reads the way a Vectorworks one does.
Which means `import/soundvisionScene.ts` has to strip ` face` back off the node name. Skip
it and a room that goes out and comes back is labelled `"Seating face face"`, and the trip
after that `"Seating face face face"` — a fault that is invisible on the first conversion
and obvious on the third. `pipeline.test.ts` runs three round trips for exactly this.

### A `.txt` has to be sniffed before it is claimed

`.dbacv`, `.dxf` and the rest name their format; `.txt` names nothing. `isSoundvisionText`
looks for one `"Label",` row, which is the only thing Soundvision's own parser needs, and
the dispatcher raises a proper `ImportError` when it is missing. Without the sniff a
shopping list imports as a venue with no objects in it, which reads as a bug in the
reduction rather than as the wrong file.

### Soundvision `.xmls` cannot be written, and that is not a gap to close

It is AES-256-CBC with a fixed key and IV that the application assembles at runtime rather
than storing — there is no 64-character hex string in the binary to find. The `.txt` route
is the supported one, is what L-Acoustics' own plug-ins use, and does not break when a
Soundvision update rotates the key. Evidence in `docs/soundvision-format.md` §1.

### Welding must probe neighbouring cells

Two vertices 0.1 mm apart still land in different cells when they straddle a grid boundary.
A quantise-and-hash weld leaves exactly the hairline cracks it was meant to close, and a
cracked ceiling shatters into forty regions. Tested.

### DXF field names come from dxf-parser, not the DXF spec

They disagree. A `POLYLINE`'s closed flag is `shape`; polyface face records are
discriminated by `faceA !== undefined`, not by the 64/128 vertex flags, which real files
set inconsistently. `is3dPolygonMesh` M×N meshes are **skipped** because dxf-parser
discards group codes 71/72 and the vertex list cannot be re-gridded without them.

### DXF `SOLID` corners are 1,2,4,3

A Z, not a ring. Read in file order the quad self-intersects, its halves cancel to zero
area, and the entity silently vanishes at the `minArea` check. Tested.

### Y-up → Z-up must preserve handedness

Source `-Z` becomes venue `+Y`. The lazy swap (`+Y → +Y`) mirrors the room, and a mirrored
auditorium is invisible in a symmetric venue until it is on site. There is a determinant
test for this.

### Setting the origin is a subtraction in venue space, not an inverse transform

`Pick in view` hands the viewport's raycast hit — already in venue space, because that is
what the viewport draws — to `withOriginAt`, which only does `offset - p`. The tempting
alternative is to invert units, up axis, heading and mirror to reach the source point, and
that is a **second copy of `applyTransform`** that will drift from the first; the same rule
as "units and axes are applied in exactly one place" wearing a different hat. Consequences
that follow from the offset being applied last:

- **Heading has to be set before the origin.** The rotation happens about the *source*
  datum, so turning the room afterwards carries the picked point off zero. The panel says
  so; do not "fix" it by rotating about the offset, which breaks the composition above.
- **The camera follows a change of offset instead of re-fitting.** Re-fitting there snaps
  the model back under the crosshair and it looks as though nothing was picked. `Viewport`
  keeps a `placementKey` of everything *except* the offset for exactly this.
- The result is rounded to the millimetre, so the number fields stay legible. That is the
  whole error budget of a pick, and the test asserts it.

### One `l` line in an OBJ loses every face of its object

three's OBJLoader keeps one geometry per object and gives it ONE type, so a single line
statement turns the whole object into `LineSegments`. disguise's stock arena has 8,193 faces
and six stray edges in one object, and imported as "contains no triangles". `mesh.ts` takes
`l` and `p` statements out before the loader sees them (`withoutLinesOrPoints`), joining
continuations first as the loader does.

### A mesh rebuild loses its colours

`Viewport` builds source meshes with a default material and colours them in a *separate*
effect. That effect must therefore also depend on `sourceKey`, or every placement change
washes the whole model to one grey until something else happens to touch the tree.

### The debounced conversion lags the scene

`useConversion` debounces settings and decisions by 250 ms. For that interval after an
import they describe the *previous* file. `useDebounced` takes the scene as a flush key so
this cannot happen, and the memo refuses to convert without a transform. Both matter: an
earlier version only avoided a crash here by accident of hook ordering.

### The CSP needs `wasm-unsafe-eval`

Unique to this app in the fleet. web-ifc instantiates a WebAssembly module. Without it,
**IFC import fails and nothing else does**, which looks like an IFC bug rather than a
policy problem. It is in `public/_headers`.

### A canvas element's box must come from CSS, never from React state

`TraceEditor` sets only the canvas *backing store*, read from `clientWidth`/`clientHeight`
at paint time; the box itself is `width: 100%` in the stylesheet. The obvious alternative —
keeping the size in state and writing `style.width` from it — lets the element's box and
its pixels desynchronise after a layout change, and then **every click lands somewhere
other than where the cursor is**, with nothing on screen to say so.

## 6. The Vectorworks plug-in is a deliberate second implementation

`vectorworks/` contains a Python 3.9 port of the `.dbacv` writer and the core of the
geometry engine. It has to: the plug-in runs inside Vectorworks' own CPython and cannot
call the TypeScript.

**Two implementations of the same reduction will drift apart.** What stops that:

- `vectorworks/tests/test_geom.py` uses the **same synthetic cases** as
  `src/lib/geom/geom.test.ts` — box is six regions, split rectangle is one, cylinder is
  not one.
- `vectorworks/tests/test_dbacv.py` reproduces the **same fixture byte for byte** as
  `src/lib/dbacv/dbacv.test.ts`.

Change the reduction on one side and you must change it on both. The drift has already
been caught once: the Python `g17` took its exponent from a 6-digit `%e` probe, which
rounds `9.99…e-02` up to `1.0e-01` and cost one fraction digit. The TypeScript was right
by accident (`toExponential()` is shortest-round-trip). Both now have the case pinned.

`vwbridge.py` is the only module that imports `vs`, and it is the only code in this repo
that has **never been executed**. Every call in it is wrapped so a wrong signature becomes
a named diagnostic rather than wrong geometry. Do not "tidy" that wrapping away.

## 7. Testing

TypeScript tests plus 80 Python tests, none of which need a browser or Vectorworks.

The ones that matter most:

- `dbacv.test.ts` — **byte-exact round trip** of the real 75 kB fixture. If this breaks,
  the format understanding has regressed.
- `pipeline.test.ts` — end to end: import → convert → write → re-parse, checking the venue
  lands in the same place it started (within 30 mm) and that the parent-id chain resolves.
- `geom.test.ts` — synthetic shapes where the answer is known: a box is six regions, a
  split rectangle is one, a cylinder is not one.
- `rationalise.test.ts` — mostly the claims it must REFUSE to make: two blocks do not
  merge, a horseshoe does not fill in, a stepped rake reports its steps, a seat solid does
  not drag the plane inside itself, and the fit does not care which way a quad was split.
- `pipeline.test.ts`'s rationalisation block — the same on a real drawing rather than a
  grid. `demo/demo-seats.dxf` is generated by `scripts/make_demo_seats.py` with the rake
  (1:14) and the balcony step pitch (0.35 in 1.05) **written down**, which is what makes
  the recovered slopes assertions rather than observations.
- `guards.test.ts` — degenerate input that must not throw or hang.
- `trace.test.ts` — synthetic *drawings*: a mask built by hand, so "a rectangular room
  detects as four corners" is an exact assertion rather than a tolerance on a real scan.
- `cad.test.ts` — a CAD plan into the tracer, end to end in node: `demo/demo-rigplot.dxf`
  (`scripts/make_demo_rigplot.py`) is detected as flat past its 3D speaker symbols, lands
  calibrated at the drawing's own coordinates, and its audience floor comes back off the
  wand as the 24 x 20 m rectangle the generator wrote down — and as half of it with the
  centreline drawn, which is why the clutter stays off the sheet.
- `split.test.ts` — `demo/demo-onepiece.obj` (`scripts/make_demo_onepiece.py`): a theatre as
  ONE Y-up mesh with a stray OBJ line, a stepped fan of stalls, a balcony overhanging them, a
  stage stair and a floor wound upside down. Its slopes are written down in the generator, so
  "each sector sits within a step of a plane at the rake drawn" is an assertion.
- `realVenues.test.ts` — **LOCAL ONLY.** Four venues' own published DWGs (Epsom Playhouse,
  Tower Theatre, Theatre Royal Bury St Edmunds, National Taichung Theater; AutoCAD 2000 to
  2018) against the dimensions in their own specifications: a published figure must exist
  as a drawn length at the drawing's units. Bury's seven are all within 1%. The drawings are
  not in the repo — none carries a licence to redistribute it —
  `python3 scripts/fetch_real_venues.py` downloads them by the URLs and checksums in
  `test/real-venues/venues.json`, and the suite skips without them, which is what CI does.
  Add a venue there, not a file here.
- `soundvision.test.ts` — round trip of `roomdata.txt`, the winding rule, and the fact a
  six-sided region stays ONE surface. The writer was additionally checked byte for byte
  against a real 7,194-face Vectorworks export (1.0 MB, 29,760 coordinates); that file is a
  client drawing and is not in the repo.

**Both writers have now been through the real application.** The `.dbacv` side has three
ArrayCalc round trips behind it. The Soundvision side was checked on 2026-08-02 against
**Soundvision 3.18.0.15**: a four-surface probe written by `writeSoundvision` went through
*Import 3D room data* and every point read back off the Properties panel exactly as
written, a six-point polygon stayed ONE surface, and a vertical wall stayed vertical. See
`docs/soundvision-format.md` §6 for the table.

Two things that check settled, and one it did not:

- The `written by ArrayCAD` header line is fine. Stop treating it as a risk.
- Soundvision strips the trailing ` face` from a label itself, so both ends agree with
  `import/soundvisionScene.ts` and a round trip is name-stable.
- **Whether a surface actually predicts is still unverified.** Geometry landing right and a
  surface returning a mapping result are different claims, and §5's winding trap is exactly
  a correctly-shaped surface that silently returns nothing. That needs a source on the
  scene and a prediction run. The `'up'` default is still the likeliest thing to revisit.

Note also that the text format is **inbound only** — 3.18.0.15's room-data toolbar offers
*Import 3D room data* but its *Save as* writes the encrypted `.xmls`. So the writer can
never be proved the way `theatre.dbacv` proves the ArrayCalc one; reading the Properties
panel back is the available substitute.

## 8. The tracer

`lib/trace/` builds a model where there was none. The rule that keeps it honest:

> **A traced region is stored in PIXELS, and converted to metres in exactly one place.**

`calibrate.ts`, and nothing else. Same reason `geom/transform.ts` owns units for 3D
imports: re-measuring the scale after an hour of tracing then re-scales the whole venue
and moves nothing relative to the drawing it was traced from.

`build.ts` is the join. It emits the same `ImportedScene` every importer produces, so
weld → coplanar regions → outline → canonical quad all run untouched, and the tests that
guard that road cover traced geometry for free.

### Traps

**Raster rows run DOWN; venue Y runs UP.** `pxToVenue` is `origin.y - py`, not the other
way. Getting it wrong mirrors the auditorium left for right, which is invisible in a
symmetric venue until the delays are hung on the wrong side. `build.ts` additionally
forces every region counter-clockwise in venue XY so its normal points up regardless of
which way round the user clicked — otherwise whether a floor faces the ceiling depends on
click order and nothing would ever say so.

**Four typed heights are only coplanar by luck.** 0, 0, 2.4, 2.5 describes a warped
surface, and warped comes out of the planarizer as several objects with a seam. Hence the
default `plane` height mode: least-squares fit, every corner moved onto it, and the
residual reported so a real step is not quietly flattened. `free` mode is the escape
hatch and says what it will cost.

**Self-intersection is checked BEFORE area.** A symmetric bow tie has two halves of equal
and opposite area, so its shoelace total is zero; check area first and the only thing the
user is told about a crossed outline is "encloses no area".

**A real plot is mostly annotation, and `source` is what the detector found.** Labels,
symbols and furniture inside a room are all enclosed islands, so the wand leaves holes out
by default (`WandOptions`, converted to pixels per click by `floodOptionsFor`), and a hall
with pilasters comes back as a hundred corners, so a region carries a `fit`.
`TraceRegion.source` is the outline as detected or drawn and is never modified;
`vertices`/`holes` are derived from it by `fit.ts` and then edited freely. Switching the
fit re-derives them — a dragged corner or a removed hole is an edit to the derived corners,
and that is what a re-fit discards. Don't make a fit edit `source`, and don't push the fit
through the pipeline instead: the drawing must show what is exported, and the height table
must have as many rows as the export has corners.

**Flood fill is 4-connected over the paper, not 8.** Eight would squeeze diagonally
between two ink pixels a person reads as a continuous wall. And it always reports
`touchedBorder` / `coverage` rather than silently returning the whole sheet — a doorway or
a broken hairline is the normal case, not an error.

**`pdfPaths.ts` is version-fragile by nature.** `OPS` is pdf.js's public API; the argument
*shape* of `constructPath` is not, and the `DrawOP` codes are pinned from pdf.js v5
internals. The buffer is validated before it is walked, and anything unrecognised returns
no paths plus a warning — never invented geometry. If a `pdfjs-dist` major bump makes
every PDF report "no vector geometry", check `DrawOPS` in `pdf.worker.mjs`. Raster contour
detection is the always-works fallback and is only less exact.

**Only `source.ts` touches a browser.** It is not re-exported from `trace/index.ts`,
because importing it pulls in pdf.js and a DOM and the whole point of the split is that
everything else runs in node under test. pdf.js itself sits behind a **dynamic import** in
`pdfSource.ts` — 400 kB that nobody dropping a DXF should download — which is why the
build emits a separate `pdfSource-*.js` chunk.

### A flat CAD plan goes through the tracer too

A rig plot or a floor plan saved as DXF or DWG is a 2D drawing in a 3D format: every
entity at z = 0. Converted as a model it comes out as surfaces all lying on the floor — the
Amfar Rig 2026 plot was 1,393 ArrayCalc objects at height zero, with a layer called
`Ceiling Coffers` typed as a ceiling on the floor. What the file holds is what a PDF of the
same plan holds, so it takes the same road. `trace/cad.ts` is the bridge; everything after
it is the tracer as it stands.

- **The importer keeps the line work.** `entities.ts` records every path as drawn, open or
  closed, per layer, into `ImportedScene.linework` — packed, because a plan is hundreds of
  thousands of two-point LINEs. It records at the ENTITY, not after chaining, since the
  chained rings are made of segments it already has. SOLID's edge is kept (a 2D fill);
  3DFACE and the meshes are not (their plan edges are a wireframe, not a drawing). A plan
  whose lines never close used to stop at "no surfaces"; `noSurfacesError` now carries the
  scene as `ImportError.traceable` and the app opens the tracer instead.
- **"Flat" is an area share, never a height span.** `flatPlanReport` judges what is LEFT
  IN: at least 90% of its surface area level and within 50 mm of the peak height. A span
  fails on the very plot this was built for — its speaker symbols are 3D blocks on layers
  the vocabulary does not call clutter (`Custom Sound`, `CAD-Audio`, 1.2 m each). Their
  area is nothing next to a plan's, while a 3D model of even a flat-floored hall is well
  under half floor. With no surface left in, it judges the line work's points instead.
- **Which layers go on the sheet is `traceLayers`, and it follows the tree with two
  exceptions.** A layer Prepare left out for its SIZE is still drawn: walls whose corners do
  not quite meet have no area, and their lines are exactly what the wand stops at. A layer
  of nothing but open lines has no node to decide by, so it is drawn unless its name is
  clutter — a `CENTRELINE` on the sheet cuts every room it crosses in two.
- **Metres still stay in `calibrate.ts`.** `cad.ts` only maps drawing units to pixels.
  `pixelsPerDrawingUnit` picks the scale (longest side within 2,400 px, rounded DOWN to two
  significant figures of px/m so the readout is checkable) and `calibrateByDrawingUnits`
  makes the `Calibration`, kind `drawing-units`. `stated: false` means the drawing had no
  `$INSUNITS` and the Source units setting is standing in, and the panel says so.
- **The venue origin is the drawing's own 0, 0**, on the sheet or not, so a room traced and
  the same room converted land in the same place, and the Placement heading, offset and
  mirror carry across both ways.
- **The extent is clustered, not trimmed by quantile.** A title block forty metres away or
  one stray entity at a kilometre would shrink the plan to a corner of the sheet. Per axis,
  paths further from the main body than 10% of the span are left off and counted in a
  warning. The obvious alternative, trimming the extreme half-percent of points, is wrong:
  a room's walls are a handful of points against tens of thousands in the symbols inside
  it, so trimming points trims the walls.
- **Rasterised by hand: one pixel, 8-connected, black on white.** No canvas, so the whole
  road from DXF text to a wand-traced room runs in node, and an 8-connected line is what
  stops a 4-connected fill squeezing through a diagonal. Because it is pure, `cad.ts` IS
  re-exported from `trace/index.ts`, unlike `source.ts`.
- **The editor shows a sheet through a darkest-pixel mip chain** (`raster.ts:shrinkDarkest`).
  A browser's canvas downscale samples between one-pixel lines and drops them, and
  `imageSmoothingQuality = 'high'` does not help in Chrome. At fit-to-view half the walls
  of a CAD plan were simply not on screen, which reads as the reason a fill escaped.

**A PDF will not finish loading in a hidden tab.** `page.render()` continues on
`requestAnimationFrame`, which a backgrounded tab does not fire, so the promise simply
never settles and the UI sits on "Reading…" until the tab is looked at again. Harmless for
a real user, and *not* a bug to go hunting — but it makes automated verification through a
headless or hidden browser pane look like a hang in the loader. Bring the page to the
front before testing PDF import.

**pdf.js fetches its JPEG 2000, JBIG2 and ICC decoders at runtime, and losing them is
silent.** They are WebAssembly, not part of `pdf.worker`, and pdf.js builds their URL by
concatenating a bare filename onto the `wasmUrl` option. Unset, it asks for the literal
`nullopenjpeg.wasm`, the decode fails, and **the image is dropped from the page** — as a
console warning, never a rejected render promise. The JS fallback beside each decoder is
built from the same option, so it fails too.

For the tracer that lands in the worst possible place. A page with no vector line work is
already a supported input — `source.ts:contoursOf` recovers outlines from the pixels, for
exactly the scanned drawing this affects — so a JPEG 2000 or JBIG2 scan arrives as a blank
white page, traces nothing, and is reported as *"Almost nothing was detected as a drawn
line. Try inverting, or set the threshold by hand."* The user is sent to the threshold
controls for a page that has no pixels in it. JBIG2 is the ordinary bilevel codec for
scan-to-PDF, so this is the common scan, not an exotic one.

`vite.pdfjs-wasm.ts` serves and emits the decoders **unhashed** at `pdfjs-wasm/` — hashed
names would never be requested — and `pdfSource.ts` points `wasmUrl` there, resolved
against `document.baseURI` so it survives the app's relative `base`. The path is a literal
in both places, because importing the plugin would pull `node:fs` into the browser bundle;
`pdfjsWasmPathMatches` in `trace.test.ts` is what holds them together, and the companion
test names the three decoders so a `pdfjs-dist` upgrade that renames one fails loudly
instead of quietly going back to blank scans.

## 9. Vector CAD: DXF and DWG

**They are one importer, not two.** DXF is the drawing model written as tagged text; DWG
is the same model written as a versioned bitstream. `entities.ts` owns everything from an
entity list onwards — block expansion, curve flattening, chaining, filling, layer
bucketing — and `dxf.ts` and `dwg.ts` are each only a translation into `CadDocument`.
Neither of them contains any geometry, and neither should ever grow any. This is the same
rule as `geom/outline.ts`, for the same reason.

**A plan drawing contains no surfaces.** This is the thing to understand about DXF. A
seating block is not a closed polyline; it is forty separate LINE and ARC entities whose
endpoints coincide on the page. `chain.ts` welds those endpoints and walks the segment
graph to recover the rings. Without it every LINE in the file is discarded and a seating
plan imports as nothing at all — which is exactly what it used to do.

Two things in the chainer are load-bearing and both look like details:

- **The walk goes in BOTH directions from its seed.** The seed is rarely the end of its
  own chain, and walking only forwards strands every segment behind it.
- **At a junction it takes the straightest continuation**, comparing the direction of
  TRAVEL against each candidate. Compare the segment's own outward direction instead and
  the test inverts: the walk takes the sharpest available turn, runs up the first row
  divider it meets, and closes a ring that is not in the drawing.

**Where the parsers lie, and it changes geometry.** Both of these were found by importing
the same drawing as `.dxf` and as `.dwg` and comparing:

- dxf-parser stores an arc's `angleLength` as a bare `endAngle - startAngle`. A DXF arc
  always sweeps counter-clockwise, so one that runs past zero comes back **negative** and
  draws the complement — the long way round, covering none of the same ground. Its own
  CIRCLE handler normalises this and its ARC handler does not. In the Music Hall drawing
  that was 64 of 316 arcs.
- dxf-parser has no end angle at all if the writer used group code 60, which is the
  *visibility* flag. Defaulting a missing sweep to a full turn fills in a disc tens of
  metres across that nobody drew, so a missing end angle is a warning and no geometry.
- acad-ts reports angles in **radians**; DXF's INSERT rotation is degrees. Miss it and
  every seat in the house faces somewhere random.
- acad-ts's `Arc.sweep` getter is `start - end`, the negative of the DXF sweep. Don't use
  it; recompute.
- dxf-parser has no 3DSOLID handler and drops them **without a warning** — and in a venue
  drawing the 3DSOLIDs are the truss the speakers fly from. `dxf.ts` registers one; the body
  is read by `acis.ts` (ciphered SAT in R2000–R2004 DXF) and imported as its convex hull.
- acad-ts 3.x sets `isBinaryAcisData: false` on an R2004 DWG body that is SAB (`ACIS
  BinaryFile`). `acis.ts` sniffs the bytes and ignores the flag.
- acad-ts 3.2 reads only 5 of the 45 3DSOLIDs in a real R2018 (AC1032) DWG, with no body and
  no wires on those 5 — the rest vanish inside the reader. 2.4 returned all 45 with their
  isoline `wires`. Found on the Amfar Rig 2026 plot (2026-09-28): the same drawing saved as
  DWG 2004 or DXF 2004 imports all 45, which is what the unreadable-solid warning says.

**Fills use earcut, not a centroid fan.** A fan is only correct for a convex ring, and
chaining makes deeply concave rings the common case — an auditorium outline fanned about
its centroid lays triangles across the empty middle of the room, which then merge into one
region whose recovered boundary is the convex hull.

**Why acad-ts and not libredwg.** libredwg is the obvious choice and is GPL-3; bundling it
into an MIT browser app relicenses the app. Several npm packages wrap it in WASM and
declare themselves MIT, which they cannot do — check what a DWG package actually contains
before believing its licence field. acad-ts is an independent MIT implementation (a port
of ACadSharp), is pure TypeScript, and pulls in no WebAssembly, so unlike web-ifc it needs
nothing added to the CSP. It is behind a **dynamic import**: nobody who only opens a DXF
should download it.

## 10. The object tree is where pruning happens

Pruning is the work this app asks of a user, and it is done by reading names. Two things
get in the way, and both are solved in `src/lib/grouping.ts` — pure, DOM-free, tested —
rather than inside the component.

**Some groups arrive with no usable name.** A `.dbacv` names every group after its own
GUID, so the theatre fixture shows twelve rows reading `RoomObjectGroup: {c9ab9376-…}` and
the only way to tell them apart is to open each one. The children know what the group is:
eleven objects all called `TIER 3 - something` make it the tier 3 group. `deriveLabel`
reads that back off them. It works **word-wise, not character-wise** — a character-wise
common prefix of `TIER 3 - CENTRE` and `TIER 3 - CEILING LEFT 1` is `TIER 3 - CE`, which
reads as a typo.

**Some scenes have no groups at all.** A DXF or DWG is one node per layer and a flat glTF
export can be hundreds of siblings, so `autoGroup` clusters them by the structure already
in the names. Two passes, because venue drawings are named both ways round: the leading
segment catches `TIER 3 - LEFT 1` where the category leads, and a shared word catches
`25 loge` / `45 loge` where it trails a number that means nothing on its own.

Three rules in there are load-bearing, and each was a bug first:

- **A number inside a *common* prefix is part of the name, never an index.** If it were an
  index it would differ between the names and would not be common. Strip it and the three
  tiers of a theatre merge into one indistinguishable heap.
- **A group holding every sibling has organised nothing.** This is the common case one
  level down, where all eleven children of the tier 3 group are of course called
  `TIER 3 - …`. The check must be against what is still UNASSIGNED, not against the
  original list — once the right-hand seats are taken out, the word the rest still share
  covers all of them.
- **Group on what the row SHOWS, not on the raw name.** Otherwise the dozen GUID groups
  cluster into one bucket named `RoomObjectGroup` and the whole thing has made it worse.

In the component: synthetic grouping is skipped where **half or more of the siblings are
already containers** — the file organised itself and second-guessing it produces groups of
groups. And every row standing for more than one object has a **tri-state checkbox that
applies to all of them**. That last one is the point: a venue is pruned by throwing away
categories. Before, a container's checkbox was `disabled` because the node has no geometry
of its own, so the documented alt-click-to-apply-to-children could never fire on the rows
where it mattered.

## 11. Rationalisation: the case the flood fill cannot reach

`planarize.ts` merges triangles that **share an edge**. That rule is why a cracked ceiling
comes back as one plane, and it is also why it can do nothing at all with a drawing where
every seat is modelled separately: four hundred seats do not touch, the gap between them is
real geometry rather than a crack for `weld` to close, and so the flood fill is *correct* to
report four hundred regions. `minArea` cannot drop them — a seat pan is ~0.2 m² — and
`maxObjectsPerNode` only keeps an arbitrary biggest N. `demo/demo-seats.dxf` imports as
**3,710 ArrayCalc objects**, which is not a venue anybody can work in.

Closing that gap needs a decision the geometry cannot supply: that a scattering of surfaces
*stands for* one surface. `geom/rationalise.ts` is where the user makes it.

**It emits `RegionOutline[]`, not an `ImportedNode`.** That is the design, and it is why
the module is short: an outline is the currency every output target already shares, so
`convert.ts` and `soundvision/convert.ts` each pick a rationalisation up through the same
`outlinesToObjects` / `outlinesToFaces` their own nodes go through. Nothing forks.

It also means **the transform is applied once, forwards, in `capture`, and never inverted** —
everything after that is venue space, which is the space an outline is defined in anyway.
An earlier draft returned source-space geometry so it could ride in a node, which required
an inverse transform; that is the same mistake §5's origin-picker entry warns about.

### What has to stay true

- **A rationalisation is a DECISION, not a scene edit.** It lives in `state.ts` keyed by
  node id and is recomputed from the source geometry on every conversion, so changing the
  units afterwards moves a rationalised seating area with the rest of the room, and deleting
  the record brings the seats back. Same rule as `Decisions`, §4.
- **Components come back separately on purpose.** Two seating blocks either side of a
  gangway are two planes. Bridging them yields one object covering the traffic route, which
  looks entirely plausible on screen and is wrong on site. The gap that would have to be
  bridged is reported, not silently taken.
- **The plane is fitted through the SURFACE, not through the corners.** Accumulating corners
  weights a vertex by how many triangles happen to share it, so the answer depends on how
  the exporter meshed the room — a quad split along one diagonal tilts the fit. Integrating
  over each triangle (centroid + the exact second moment, parallel-axis) depends only on the
  shape. `rationalise.test.ts` pins it by meshing one surface both ways.
- **Least squares, never an average of the face normals.** A stepped rake is the normal way
  to model an auditorium and every tread is separately level, so the normal average points
  straight up and describes a flat floor. The fit finds the real slope, and `maxResidual`
  then reports the tread rather than hiding it. `demo-seats.dxf`'s balcony exists to test
  exactly this, and its step pitch is written down in the generator so the test is an
  assertion and not an observation.
- **The residual warning fires before every early return.** A capture spanning two tiers
  projects both onto one plane, where they overlap and the outline recovery collapses; if
  the warning came last, "no area survived the minimum" would be the only thing on screen
  and it describes the symptom rather than the cause.
- **`upward` capture is the default because a seat is a solid.** Its back, sides and
  underside are all in the soup and would put the "seating plane" somewhere inside the seat.
  Keeping upward faces reduces each seat to its pan — the same trick `vwbridge.py` uses when
  it takes a seating solid's top face.
- **The gap is between SURFACES, so the surfaces are sampled, not only their corners.**
  `densify` adds points across every captured face, no further apart than half the gap. A
  deck cut into 1.3 m squares, or a row of a stepped rake drawn as one 30 m strip, has no two
  corners within any sensible gap, and an alpha shape over corners alone bridged nothing and
  lost the whole area. It is bisection, not a lattice, and it is budgeted.
- **Points go onto the plane STRAIGHT DOWN, not along its normal.** The audience plane is a
  claim about where the seating is in plan. Dropped along the normal, every tread of a
  stepped rake slides up the slope by its height off the plane and the outline comes back a
  sawtooth with gaps between the rows. Only a plane too near vertical keeps the normal
  projection.
- **A stepped rake is judged on its SURFACE RMS** (`stepped`, `fitPlane().surfaceRms`). Its
  corners all sit at a tread's edge, half a step off the incline, so their RMS is nearly the
  worst case; the surface between them crosses the plane, and its RMS is the 0.29 of a step
  that `prepare/split.ts` cuts to. Two tiers caught together are a metre off either way.

### The tree and the drawing compose, and have to

Three ways to choose what to rationalise: tree multi-select, a screen-space marquee, and a
polygon drawn in the view. The third is not a convenience — **a DXF keeps a whole seating
block on one layer**, so no amount of pruning in the tree separates the left bank from the
right, and the polygon is the only thing that can.

But drawing alone cannot say *which* surfaces under it are wanted. Draw round a seating
block and the floor beneath it falls inside too, and one plane through seats and floor
together sits between them — a listening plane half a seat height low, which the residual
duly reports but which nobody asked for. So **the tree says what kind of thing and the
polygon says where**: with a selection, a drawn area captures only the selected nodes
within it. With nothing selected it falls back to everything included, which is the
reasonable reading of drawing with no other instruction. This was found by building the
feature and watching a drawn area come back at 0.31 m off plane; it is not theoretical.

`delaunator` does the triangulation behind the gap-bridging outline — an alpha shape whose
radius is expressed as a distance a person can reason about. **ISC, 3 kB gzipped, pure JS,
one transitive dependency (`robust-predicates`, Unlicense) and no WASM**, so it needs
nothing added to the CSP and carries none of the licence problem libredwg would (§9). The
component boundaries then come back from `polygon.ts:boundaryLoops`, the same routine the
coplanar regions use, so a horseshoe balcony's inner void arrives as a hole for free.

## 12. Preparation: the work the file already describes

`src/lib/prepare/` runs once, the moment a model is imported, and answers what the drawing
already says. A theatre arrives as several thousand objects of which a few dozen are room
surfaces; the rest are dimensions, lighting bars, cable trays and four hundred separately
modelled seats. Every one of them is drawn, picked against and converted until somebody
prunes it. The names in the file describe most of that, and reading them costs nothing.

It is two halves, kept apart on purpose:

```
plan.ts       reads the model and produces DECISIONS. No geometry is touched.
vocabulary.ts the word lists behind it, as plain data
split.ts      cuts a one-piece model into parts. The same triangles, in rows a person can prune.
simplify.ts   re-cuts heavy objects into fewer triangles. The same shape, less of it.
```

`prepareScene` runs them split, re-cut, read — splitting first, because it cuts rakes along
the model's own triangles and a re-cut would have merged a row into one long sliver first.

The panel (`components/PreparePanel.tsx`) is six checkboxes and a report. The report is the
important half: every line says what happened to THIS model with a count, because a pass
that silently left out forty objects is indistinguishable from an importer that lost them.

### What has to stay true

- **A file that is ALREADY a venue gets none of this.** `.dbacv`, Soundvision `.txt` and
  `.fc3` importers set `ImportedScene.alreadyAVenue`, and `prepareScene` returns an empty
  plan for them. Every object in one of those was put there by a designer: there is no
  clutter to find, nothing to classify that is not classified, and no seating left
  scattered. Run the vocabulary over one and it reads `LIGHTING BRIDGE` — a real ArrayCalc
  plane type 2 — as rigging and drops it on the way in.
- **A plan is applied as `Decisions` and `Rationalisation[]`, never as a scene edit.**
  Everything it does is therefore visible in the tree, ghosted rather than hidden in the
  viewport, and undone by one click — the same rule as §4 and §11 and for the same reason.
- **It is decided once, at import, against the transform in force then.** The thresholds are
  in metres and the unit setting behind them may have been a guess. Changing the units later
  does not silently re-run it; the panel re-runs on request, from the RAW scene, and says so.
- **Clutter first, seating last.** `STAGE LIGHTING` is a lighting bar over a stage, and
  `FLOOR - STALLS` is the concrete under the stalls. The category that excludes wins over
  the categories that classify, and the category that claims the most — seating, which turns
  hundreds of objects into one fitted plane — wins only when nothing else in the name
  disagrees.
- **Whole words only.** `TEXT` is annotation; `TEXTURED PANEL` is a surface. A substring
  match would leave a real surface out of the venue, which is the one failure this must not
  have.
- **Seating is detected before the size test, not after.** A seat modelled as a flat pan has
  about 0.2 m² of surface — below any sensible "too small to matter" threshold. Testing size
  first leaves out the entire audience one seat at a time and reports it as trim.
- **Seats do not tile their own floor.** A packed block covers under half its footprint; a
  raked deck covers all of it. That ratio is what keeps a deck merely NAMED `SEATING` out of
  the flattening — and flattening a deck does not just gain nothing, it can lose the deck
  (see the bridging gap below).
- **A rationalisation that produced nothing must not replace anything.** `rationalisedAreas`
  returns the ones that did, and only those reach `replacedNodeIds`. Without it a capture
  that came back empty took its source objects out of the venue and put nothing back: an
  auditorium with no audience in it and a lower object count than before. This protects a
  hand-drawn area exactly as much as a prepared one.
- **The bridging gap is the row pitch OR the mesh, whichever is coarser.** Written when the
  alpha shape saw only corners, so a deck cut into 1.3 m squares and bridged at 0.9 m joined
  nothing at all. `rationalise.densify` now samples the faces (§11) and the deck comes back
  either way; the rule stays because erring coarse costs a gangway narrower than the mesh,
  which is reported, and the coverage test above still keeps decks out.
- **The row pitch is the fourth nearest neighbour, at the lower quartile.** The two nearest
  seats are the ones either side — the column pitch — and bridging only that leaves every row
  its own area. The quartile rather than the median because a seat on the edge of a block
  has no neighbours on one side, so its fourth nearest is a diagonal, and on a small block
  the edges outnumber the middle.
- **Where the name says nothing, the shape — but only the clear cases.** An unnamed object
  that is nine-tenths wall is a surface; one that is nine-tenths level with a room's height
  under it and nothing to stand on over it is a ceiling. A mix is a one-piece model, and one
  type for all of it would be wrong for most of it.

### Splitting a one-piece model

`split.ts` exists for the file with no names at all: an OBJ, an STL, disguise's stock theatre
(1,041 ArrayCalc objects, every one a listening plane) or its arena (8,152). It only touches a
leaf the vocabulary cannot categorise, with height in it — a flat plan is skipped before the
weld, which on Taichung's 700,000-triangle seating plan was most of fifteen seconds. Its parts
are named in the vocabulary's own words (`Floor`, `Ceiling`, `Walls`), so the ordinary name
rules type them, and rakes are tagged `shape:rake` so the plan flattens each into a
`stepped` audience plane. The node keeps its id as a container; the parts are
`<id>/rake1`, `<id>/floor` and so on, deterministic, because a re-run must give the same ids.

What has to stay true, each found on a real mesh:

- **A riser has no minimum height.** The d3 theatre rakes its stalls 30 mm a row. What keeps a
  slab's 20 mm edge from joining its top to its underside is the TREAD test — twice area over
  perimeter, at most a row's depth — and the count of rows.
- **A rake is cut where one plane stops fitting, by whichever cut fits better.** Along the plan
  (two-means from the median of the longest axis) takes a bowl's side from its corner; across
  the fitted plane (two-means, height weighted) takes a tier from the one overhanging it. The
  arena's end, tiers stacked in plan, shredded into fragments with plan cuts alone.
- **Then the cut pieces are put back together.** Each sector is split into the pieces that
  actually touch (a shared corner in plan, a step apart in height), and neighbours whose union
  still fits are merged, best first, on summed moments — refitting triangles per pair took ten
  seconds on the arena; moments take a fifth of one.
- **Floor or ceiling is decided by position, then winding where winding can be trusted.** No
  room under it means somewhere to stand. Over a room, a surface facing away from the way the
  model's own TREADS face is an underside; with no seating to judge by, no standing room over
  it makes it a ceiling. Where nothing is modelled underneath, the model's lowest level stands
  in (the arena has no arena floor), and a walkable-facing surface with nothing over it is a
  roof only near the top of the model — the d3 theatre has no roof over its auditorium and its
  circle landings were coming out ceilings.

### Re-cutting, and the two things that make it unsafe

`simplify.ts` is `planarize` run early and written back: merge a meshed flat wall into the
region it already forms, re-cut that region from its own boundary, keep the outline exactly.
It is not a decimator — there is no error metric and no vertex budget. The demo venue goes
from 3,206 triangles to 1,322 with an identical converted venue, which is the claim the pass
rests on and what `prepare.test.ts` asserts.

Both of its guards were found by getting it wrong, and neither is obvious:

1. **A region that is only NEARLY flat must not be re-cut.** `findCoplanarRegions`
   deliberately tolerates 20 mm of bulge, so a "region" can be a shallow dome or a stepped
   rake. Its own small triangles are each nearly flat; a re-cut joining ring points ten
   metres apart is not.
2. **A region with a nearly-parallel NEIGHBOUR must not be re-cut either, and this is the
   subtle one — the region that changes is not the region that was re-cut.** The demo
   venue's balcony is a fan of raked tiers two or three degrees apart, separate regions only
   because the flood fill's running plane drifts out of tolerance as it walks. Which
   triangle lands in which tier is decided by the tessellation itself, so re-cutting one
   tier shuffled the areas of its neighbours: eleven regions became fourteen. Fewer
   triangles, a different room. A faceted vault is safe by contrast, because each facet is
   exactly the plane it claims to be — so the rule is only to refuse where a bulging
   neighbour is involved.

It also refuses a region with a hole (re-cutting from the outer ring alone fills the
doorway), a ring the triangulator can only fan, and any output triangle that comes back more
than a degree off the region it came from.

**The Vectorworks plug-in has no equivalent and does not need one.** §6's no-forking rule is
about the reduction and the writer, which the plug-in reimplements and which must not drift.
Preparation is a different kind of thing: it exists because an exported file has thrown away
what the plug-in can still read directly out of the drawing — the class names, the object
types, the seating solids. Inside Vectorworks the answer is available rather than inferred.

## 13. Deploy

Static-assets Worker, not Cloudflare Pages.

```bash
cf-run npx wrangler deploy
```

## Notes

`docs/NOTES.md` carries this repo's working notes — current status, decisions
already made, and the traps that have actually bitten. Read it before changing
anything non-obvious. Cross-cutting fleet knowledge lives in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).
