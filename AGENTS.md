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
    dxf.ts              DXF entities -> triangles. The fiddliest importer
    ifc.ts              web-ifc wasm; the only source of plane-type suggestions
    dbacvScene.ts       an existing venue, tessellated, so it can be pruned
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
    convert.ts          the ArrayCalc half: outlines -> RoomObject
  components/           Viewport (three.js), Tree, Inspector, TraceEditor, TracePanel, ui
  state.ts              decisions, settings, the debounced conversion hook
vectorworks/            a SECOND implementation, in Python 3.9, for the VW plug-in
test/fixtures/theatre.dbacv   a real ArrayCalc 12.8.2 export. The ground truth
test/fixtures/roomdata.txt    a synthetic Soundvision export, in the exact byte format
docs/dbacv-format.md    everything known about the format, and what is not known
docs/soundvision-format.md    ditto for Soundvision, incl. why .xmls is not writable
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
- `guards.test.ts` — degenerate input that must not throw or hang.
- `trace.test.ts` — synthetic *drawings*: a mask built by hand, so "a rectangular room
  detects as four corners" is an exact assertion rather than a tolerance on a real scan.
- `soundvision.test.ts` — round trip of `roomdata.txt`, the winding rule, and the fact a
  six-sided region stays ONE surface. The writer was additionally checked byte for byte
  against a real 7,194-face Vectorworks export (1.0 MB, 29,760 coordinates); that file is a
  client drawing and is not in the repo.

**Nothing ArrayCAD writes has yet been opened in Soundvision.** The `.dbacv` side has three
ArrayCalc round trips behind it; the Soundvision side has a byte-exact reproduction of a
real export, which is strong but is not the same thing. Until someone runs *3D room data →
Import 3D room data* on an ArrayCAD file, treat the header attribution line and the `'up'`
winding default as the likeliest things to need revisiting.

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

**A PDF will not finish loading in a hidden tab.** `page.render()` continues on
`requestAnimationFrame`, which a backgrounded tab does not fire, so the promise simply
never settles and the UI sits on "Reading…" until the tab is looked at again. Harmless for
a real user, and *not* a bug to go hunting — but it makes automated verification through a
headless or hidden browser pane look like a hang in the loader. Bring the page to the
front before testing PDF import.

## 9. Deploy

Static-assets Worker, not Cloudflare Pages.

```bash
cf-run npx wrangler deploy
```
