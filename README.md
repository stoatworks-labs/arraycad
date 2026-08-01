# Venue Forge

**Turn a CAD venue model into a d&b ArrayCalc venue file.**

Drop in a DXF, glTF, IFC, OBJ or similar. Venue Forge merges the model's triangles back
into flat planes, lets you throw away everything ArrayCalc does not need, lets you say
what each surface *is* — audience, surface, stage — and writes a `.dbacv`.

Browser only. No backend, no upload: the file never leaves your machine.

---

## Why it is not just a file conversion

An ArrayCalc venue is a few dozen **parametric planes**. A CAD export of the same theatre
is tens of thousands of **triangles**. Handing ArrayCalc the triangles produces a file it
cannot usefully work with.

So the interesting part is the reduction:

```
import  →  weld  →  coplanar regions  →  outline  →  simplify  →  quads/triangles  →  .dbacv
```

The whole of a raked seating deck is one plane, however many triangles the CAD model spent
on it. A 12-triangle box is six. That collapse is the tool.

## Supported inputs

| Format | Notes |
|---|---|
| **DXF** | Best for venue drawings. 3DFACE, polyface meshes, LWPOLYLINE, SOLID, CIRCLE/ARC, INSERT blocks including row/column arrays. Reads `$INSUNITS`. Closed 2D outlines can be extruded to a height, so a plan-only drawing still works. |
| **glTF / GLB** | Best of the mesh formats — keeps object names and hierarchy, and declares metres and Y-up, so nothing has to be guessed. |
| **IFC** | The only format carrying real semantics. `IfcSlab`, `IfcCovering`, `IfcWall` etc. are mapped to *suggested* plane types. |
| **FBX, Collada, 3DS** | Keep names and hierarchy. |
| **OBJ, PLY, STL** | Geometry only. STL has no names at all, so the whole model arrives as one node. |
| **`.dbacv`** | An existing ArrayCalc venue, for pruning and retyping. See the caveat below. |

### Formats that need an export step first

`.vwx`, `.dwg`, `.skp`, `.rvt`, `.3dm`, `.max`, `.blend` are **closed binary formats with
no public specification**. Nothing outside their own application can read them, and no
amount of work here changes that. Drop one in and Venue Forge names the export to run
instead — for Vectorworks that is glTF first, then IFC, then DXF 3D.

## Getting a good result

1. **Export less.** In the CAD tool, export only the classes you need — seating, stage,
   walls, ceiling — and leave lighting, rigging, trussing and dimensions behind. This
   saves more work than anything in this app.
2. **Check the units.** Only glTF and IFC state them, and DXF often says "unitless". The
   app guesses from the model's overall size and tells you when it is guessing. Check it
   against a dimension you know.
3. **Set the datum.** ArrayCalc wants the audience towards **+X**, Y symmetric about zero,
   Z up. Use heading, offset and the mirror toggle; the drawn axes show which way is which.
4. **Choose a fit.** *Rectangle* collapses each region to its smallest enclosing rectangle
   — one quad each, and usually what you want for seating. *Follow outline* is faithful
   but a ragged CAD outline turns into many objects.
5. **Watch the object count.** If it is in the hundreds, raise the merge tolerances, raise
   the minimum area, or switch to rectangle fit.

## The `.dbacv` format

It is undocumented. Everything this tool knows was reverse-engineered from one real
ArrayCalc 12.8.2 export, and is written up in **[docs/dbacv-format.md](docs/dbacv-format.md)**.

The reader and writer reproduce that file **byte for byte**, which is good evidence the
structure is right.

> ⚠️ **The plane-type names are inferred, not verified.** `Audience`, `Surface`, `Stage`,
> `Soundscape` are deductions from one file's names, colours and listener heights — they
> are not read from d&b documentation. The app always shows the raw numeric code beside
> the label, because that is what actually gets written. Check a converted venue in
> ArrayCalc before trusting a whole design to it.

### Re-importing a `.dbacv` is lossy

Opening an existing venue tessellates every object into triangles and rebuilds it from
planes. Arc segments and boxes come back as flat quads. Use it to prune and retype, not to
preserve.

## Develop

```bash
npm install
npm run dev
```

```bash
npm test
```

```bash
npm run build
```

See [CLAUDE.md](CLAUDE.md) for the full command reference and [AGENTS.md](AGENTS.md) for
the model, the invariants and the traps.

## Licence

MIT.
