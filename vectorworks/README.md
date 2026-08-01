# ArrayCAD for Vectorworks

Export a Vectorworks document straight to a d&b ArrayCalc venue (`.dbacv`), with no
intermediate file format.

Vectorworks files are a closed binary format that nothing outside Vectorworks can read,
so the browser tool can only ever see a glTF/IFC/DXF export of your drawing. This plug-in
runs *inside* Vectorworks, where it can see the things an export throws away — your class
names — and use them to decide what each object is.

---

## ⚠️ Read this first

**This plug-in has never been run inside Vectorworks.**

Everything that can be verified without Vectorworks has been, and is covered by 64 tests:
the `.dbacv` writer reproduces a real ArrayCalc export **byte for byte**, and the geometry
engine gives the same answers as the browser tool on the same cases.

What is *not* verified is `arraycad/vwbridge.py`, the one module that calls Vectorworks.
Its function names were read out of the Vectorworks 2025 application binary, so they exist
— but their exact signatures and return shapes could differ. That is why:

1. **Run `arraycad_probe.py` first.** It calls each function on your document and writes a
   report saying what worked. It changes nothing.
2. Every call in the exporter is wrapped so a wrong signature becomes a **named
   diagnostic in the summary dialog**, never silently wrong geometry. Wrong geometry in an
   acoustic model means reflectors in the wrong place with nobody noticing.

## Install

Copy the `vectorworks/` folder somewhere permanent, then either:

**As a menu command** — the proper way:

1. `Tools > Plug-ins > Plug-in Manager`
2. `New…` → Command → name it `Export ArrayCalc Venue`
3. Set its script to `arraycad_export.py`
4. `Tools > Workspaces > Edit Current Workspace` and drag the command into a menu

**Or paste it in** — quicker for a first try:

1. `Resource Manager > New Resource > Script > Python Script`
2. Paste the contents of `arraycad_export.py`
3. Make sure the `arraycad/` package folder sits next to wherever the script lives

Vectorworks 2025 bundles CPython 3.9, so this code targets 3.9. No third-party packages.

## Use it

### 1. Class your geometry

The plug-in decides what each object *is* from its **Vectorworks class**. Names containing
these words get a sensible default, which you can override:

| Class name contains | Becomes | Strategy |
|---|---|---|
| seat, audience, stall, balcony, tier, circle, gallery | Audience | Top face |
| stage, deck, riser, pros, apron, thrust | Stage | Top face |
| wall, ceiling, rail, balustrade, reflector, soffit | Surface | All faces |
| bridge, truss, rig, bar, beam, column | Surface | Single box |
| soundscape, en-scene | Soundscape | Top face |
| dim, text, annot, note, grid, sheet, title, north, hidden | — | **skipped** |

### 2. Select and run

Select the objects you want, or leave nothing selected to be offered every class. The
plug-in shows the **model size in metres before it writes anything** — check it against a
dimension you know, because the document unit scale is the one thing it cannot reliably
read, and a wrong scale makes every distance in the export wrong.

### 3. Choose a strategy per class

| Strategy | What it does | Use for |
|---|---|---|
| **Auto** | Box if the object really is one, else top face for audience/stage, else all faces | Most things |
| **Top face** | The single highest roughly-horizontal surface | Seating, stage decks |
| **All faces** | Every coplanar region | Walls, ceilings, reflectors |
| **Single box** | One ArrayCalc `Shape=4` box | Lighting bridges, proscenium legs |
| **Top face, rectangle** | Top face squared off to its smallest enclosing rectangle | Ragged seating outlines |

**Single box is worth reaching for.** A box exported as faces is six RoomObjects; exported
as a box it is one, which is what a person would have drawn in ArrayCalc by hand. It only
applies when the object's vertices really are the eight corners of its bounding box — a
near-box is rejected rather than quietly moved.

## How geometry is read

| Object | How |
|---|---|
| 3D polygon | Read directly — `GetVertNum` + `GetPolyPt3D`. Exact. |
| Mesh | Read directly — `GetMeshVertsCnt` + `GetMeshVertex`. |
| Group / symbol | Walked with `FInGroup` / `NextObj`. |
| Extrude, solid, wall, slab, roof | A **duplicate** is converted to a mesh, read, and deleted. |

That last row matters: `Convert to Mesh` replaces the original object, so the plug-in
always works on a duplicate and deletes it in a `finally` block. **Your drawing is not
modified.** If an export fails halfway, no debris is left behind.

Object *types* are never matched against hardcoded VectorScript type numbers — those vary
between versions, and a wrong constant would read the wrong geometry silently. Dispatch is
on what actually responds to a call.

## Known limitations

- **Stepped seating has no single top face.** Each riser is its own coplanar region at its
  own height. Top face takes only the highest, and the plug-in *says so* in the summary.
  Use All faces, or model the rake as one sloped surface.
- **A hand-built n-gon mesh reads as garbage triangles.** `GetMeshVertex` gives vertices
  with no face topology, so the vertex stream is assumed to be triangles. True for
  anything from `Convert to Mesh`, not true for an n-gon mesh.
- **Curved surfaces do not become ArrayCalc arc segments.** `Shape=2` — the elliptical
  annulus sector ArrayCalc uses for curved tiers — is understood by the writer but nothing
  generates one. A curved balcony comes out as a run of flat quads.
- **The document unit scale is not read.** See above.
- **Plane type names are reverse-engineered** from one sample file, not from d&b
  documentation. The numeric code is shown next to every name because that is what gets
  written. See [`../docs/dbacv-format.md`](../docs/dbacv-format.md).

## Tests

64 tests, none of which need Vectorworks:

```bash
python3 vectorworks/tests/test_dbacv.py
```

```bash
python3 vectorworks/tests/test_geom.py
```

```bash
python3 vectorworks/tests/test_export.py
```

`test_geom.py` deliberately uses the **same cases** as `src/lib/geom/geom.test.ts`. Two
implementations of the same reduction will drift apart unless something pins them
together, and that is what it is for.

## Files

```
arraycad_probe.py       run this FIRST — API diagnostic, changes nothing
arraycad_export.py      the plug-in command
arraycad/
  dbacv.py              the .dbacv format. Byte-verified against a real export
  geom.py               weld, coplanar merge, outline, box detection, top face
  export.py             the per-class strategy logic. No `vs` — fully testable
  vwbridge.py           THE ONLY MODULE THAT TOUCHES VECTORWORKS
tests/                  64 tests, no Vectorworks needed
```
