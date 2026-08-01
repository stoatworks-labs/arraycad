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
  lib/geom/             THE ENGINE
    vec.ts              small vector maths, deliberately three-free
    planarize.ts        weld + coplanar flood fill. The module that makes this possible
    polygon.ts          boundary loops, simplification, quad/triangle fitting
    transform.ts        units, up-axis, datum. The ONLY place these are applied
    convert.ts          the pipeline: ImportedNode -> RoomObject
  components/           Viewport (three.js), Tree, Inspector, ui
  state.ts              decisions, settings, the debounced conversion hook
vectorworks/            a SECOND implementation, in Python 3.9, for the VW plug-in
test/fixtures/theatre.dbacv   a real ArrayCalc 12.8.2 export. The ground truth
docs/dbacv-format.md    everything known about the format, and what is not known
```

**`src/lib/` is pure and three-free** (except `import/mesh.ts`, which needs the loaders).
The whole conversion runs in node, which is why 151 tests can cover it without a browser.

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
`docs/dbacv-format.md` §7. Every group in the sample has rotation 0 and scale 1, so
**rotation composition is untested**.

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

151 TypeScript tests plus 80 Python tests, none of which need a browser or Vectorworks.

The ones that matter most:

- `dbacv.test.ts` — **byte-exact round trip** of the real 75 kB fixture. If this breaks,
  the format understanding has regressed.
- `pipeline.test.ts` — end to end: import → convert → write → re-parse, checking the venue
  lands in the same place it started (within 30 mm) and that the parent-id chain resolves.
- `geom.test.ts` — synthetic shapes where the answer is known: a box is six regions, a
  split rectangle is one, a cylinder is not one.
- `guards.test.ts` — degenerate input that must not throw or hang.

## 8. Deploy

Static-assets Worker, not Cloudflare Pages.

```bash
cf-run npx wrangler deploy
```
