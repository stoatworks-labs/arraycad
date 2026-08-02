# The Soundvision 3D room data format

What ArrayCAD writes for L-Acoustics Soundvision, why it is this format and not the native
one, and what is known versus assumed.

Companion to [dbacv-format.md](dbacv-format.md).

---

## 1. Why not `.xmls`

Soundvision's native scene file is `.xmls`. **It is encrypted and cannot be written from
outside the application.**

The evidence, from Soundvision 3.18.0.15 (`2026.2`):

- The binary names its own scheme in a `__PRETTY_FUNCTION__` string:
  `std::optional<std::string> soundvision::core::files::read(const boost::filesystem::path &,
  const constants::AES256CBCKey64 &, const constants::AES256CBCIV32 &)` — AES-256-CBC, a
  64-hex-character key and a 32-hex-character IV, both compile-time constants.
- The files agree. Every `.xmls` sampled is an exact multiple of 16 bytes, has entropy
  ≈ 7.999/8, and contains **no repeated 16-byte block** — so CBC, not ECB. Three unrelated
  venues share a byte-identical 64-byte prefix, which means one fixed key *and* one fixed
  IV across files.
- L-Acoustics encrypts its own shipped resources the same way: `project/scene.xsd`,
  `types/units.xml` and `common/glm.xsd` all begin with the identical ciphertext
  `e0c777bf4ba5b6bc…`, being the same plaintext XML preamble under the same key.
- **No 64-character hex string exists anywhere in the 53 MB binary.** The key is assembled
  at runtime, not stored, so it cannot be lifted statically.

Writing `.xmls` would therefore mean defeating a vendor protection measure, and would break
silently for every file ArrayCAD had ever produced the moment L-Acoustics rotated the key.

## 2. What Soundvision documents instead

From its own help, *Interoperability → Importing 3D room data into Soundvision*:

> It is possible to import in Soundvision 3D room data `*.txt` files that were exported
> from CAD software, such as SketchUp or Vectorworks.

This is the format its own SU4SV (SketchUp) and Vectorworks plug-ins write. It is
unencrypted and it is the supported CAD route. DXF is **export only** (loudspeaker designs
out to CAD), so it is not an inbound path.

`.xar` is the EASE audience-area alternative accepted by the same dialog. Not implemented.

### The text format is INBOUND ONLY

An earlier draft of this document said the menu offers both *Import 3D room data* and
*Export 3D room data*. **It does not**, and this was checked directly in 3.18.0.15's
3D ROOM DATA panel, whose entire toolbar is:

| Control | Tooltip | What it does |
| --- | --- | --- |
| 📄 | `New 3D room data [command + N]` | empties the panel |
| 📂 | `Open 3D room data [command + O]` | opens an `.xmls` |
| ▾ | `Open recent 3D room data` | recent `.xmls` list |
| 💾▾ | `Save 3D room data as... [ctrl + option + command + S]` | writes an **`.xmls`** |
| 📂↓ | `Import 3D room data` | reads a `.txt` or `.xar` |

So room data goes **in** as text and comes **out** encrypted. Saving the imported probe
produced a 3,872-byte `.xmls` — 242 × 16, consistent with the AES-CBC block size in §1.

The practical consequence is that the writer cannot be proved by asking Soundvision to
write the same file back, the way `theatre.dbacv` proves the ArrayCalc writer. What can be
done instead is read the geometry back off the Properties panel, which is what §6 records.

### It is read as well as written

`import/soundvisionScene.ts` takes the same format back in, which is what makes ArrayCAD a
converter *between* ArrayCalc and Soundvision rather than only into them. Faces are grouped
by label — the CAD layer tree, recovered — triangulated by `geom/polygon.ts:triangulateRing`
and then handed to the ordinary pipeline, so a Soundvision room is pruned, retyped and
written as a `.dbacv` by exactly the road a DXF takes.

Two things the round trip depends on:

- **The ` face` suffix comes off on the way in**, because §3 says every label carries it and
  `convert.ts` puts it back on the way out. Without the strip a name gains a word per
  conversion: `"Seating face face"`, then `"Seating face face face"`.
- **A `.txt` is sniffed first.** One `"Label",` row is the whole test — the same thing
  Soundvision's own parser needs, and less brittle than matching the inert header, which a
  plug-in other than the two stock ones need not write.

Faces are planar by requirement (§3), but a hand-edited one need not be: a ring too warped
to project without folding it flat is fanned about its centre instead and counted in a
warning, rather than silently flattened onto a best-fit plane.

## 3. The grammar

Recovered from a real 1.0 MB Vectorworks plug-in export of a live venue: 7,194 faces,
29,760 coordinates.

```
"; VECTORWORKS"                        line 1, the producing software
";"
";   using Outside is front (white)"   the plug-in's export options, echoed
";   using Name By Layer"
";   using Visible Entities"
";"
";"
";"
"; LengthUnit","m"
";"
"Label","None face"                    opens a face
-41.373000,-28.562500,0.000000         a vertex
-41.488000,-28.562500,0.000000
-41.488000,-18.600000,0.000000
-41.373000,-18.600000,0.000000
";"                                    closes it
"Label","Stage Trusses face"
...
```

Rules:

- A line beginning `";` is a **comment**. The line `";"` exactly *also closes the face
  currently open*.
- `"Label","<name>"` opens a face. Labels are **not unique** — 6,786 of the 7,194 faces in
  the reference export share the label `"None face"`.
- Every other line is `x,y,z`: three `%.6f` decimals, comma separated, no spaces.
- **The ring is implicit.** The last vertex does not repeat the first (only 6 of 7,194 faces
  did, coincidentally).
- The file ends with the `";"` that closes its last face, then a newline. LF, pure ASCII.

### What the parser actually reads

Only `"Label"` rows and coordinate rows. None of `VECTORWORKS`, `Outside is front`,
`Name By Layer`, `Visible Entities`, nor a `;`-prefixed `LengthUnit` appears anywhere in the
Soundvision binary — the whole header is inert comment. (There *is* one
`"LengthUnit","m"` string in the binary, but it sits among `"FileType","Speaker Types"` and
`"Format",4.0`, which is the **CLF loudspeaker exporter**, not this parser.)

ArrayCAD still reproduces the header verbatim, because that exact block is the only
combination proven to import and there is no way to test a variant without Soundvision in
the loop. Its own attribution goes in as one extra comment line rather than by editing the
established ones.

### Polygon count and shape

Faces are arbitrary polygons, not just triangles and quads. The reference export contains
faces of 3, 4, 5, 8, 10, 11, 67 and 114 vertices.

**Every face is planar** — measured max deviation from the best-fit plane was 0.000000 m
across all 7,180 non-degenerate faces. Soundvision surfaces are planes, so this is a
requirement, not a coincidence. ArrayCAD satisfies it for free: `geom/planarize.ts` only
ever emits coplanar regions.

## 4. Traps

### A reversed surface is not an error, it is a silent zero

Soundvision's help, *Adjusting for acoustic simulation*:

> To obtain results when adding sources on the 3D scene, surface points must be entered
> counter-clockwise… If the points have not been entered in the right order, the orientation
> of the surfaces and profiles must be reversed.

A face wound the wrong way produces **no mapping result**, with no warning. A CAD export
whose floor triangles happen to wind downwards therefore yields a venue that looks perfect
and predicts nothing — the same class of failure as the Y-up handedness trap in
`geom/transform.ts`.

`soundvision/write.ts` defends this twice:

1. `convert.ts` forces each ring counter-clockwise **in its own plane frame**, so the face
   normal is the region normal rather than its opposite. Without this a vertical wall
   inherits whatever winding the source mesh had, and step 2 cannot rescue it.
2. `orientFace(points, 'up')` reverses any near-horizontal face still pointing downwards.
   Vertical faces are left alone: a wall has no correct side without knowing which way the
   room is.

The reference export is itself ~50/50 (1,216 faces up, 1,203 down) because it dumps closed
solids with both sides. ArrayCAD emits single-sided listening planes, so it can and should
be opinionated here.

### Negative zero is load-bearing for the round trip

The reference export contains `-0.000000` 168 times. JavaScript's `(-0).toFixed(6)` is
`"0.000000"`, which is geometrically identical but breaks byte-exactness. `f6()` applies the
sign to the magnitude itself. With that one guard, all 89,280 coordinates of the reference
export round-trip exactly.

### The format carries geometry and a label. Nothing else.

There is no field for an audience listening level, for enabled/disabled, or for the
audience-versus-geometry distinction. Soundvision's own workflow sets those after import
(*Setting Audience listening levels*, *Adjusting for acoustic simulation*). `convertNodes­ToSoundvision`
returns a warning saying so, and the label — the node name the user already recognises — is
the only handle they get for finding a surface again.

### A surface is one ring, so a hole cannot be one surface

Soundvision has no concept of an interior ring on a surface. A region with holes is
therefore triangulated through `polygon.ts:toFaces`, which preserves the void; discarding
holes instead would silently fill in a stage pit. `stats.regionsTriangulated` reports it,
and it is the only reason the face count can exceed the region count.

Balconies and revolutions are a separate Soundvision object class (*Profiles*, extruded
cutviews). They are not expressible in this format and ArrayCAD does not attempt them.

## 5. Why this target is *less* lossy than `.dbacv`

A Soundvision surface is a free polygon. There is no canonical quad frame to satisfy
(`dbacv/quad.ts`) and no symmetric-trapezoid restriction, so a recovered outline goes out
whole. The same six-sided region that ArrayCalc forces into two triangles is one surface
here.

## 6. Verification status

| Claim | How it was checked |
| --- | --- |
| Grammar | Parsed a real 7,194-face Vectorworks export; 0 unrecognised lines |
| Writer fidelity | Byte-exact round trip of that file, all 1,066,486 bytes |
| Reader as an import source | `.txt` → planes → `.dbacv` lands inside 30 mm of where it started; three `.txt` → `.txt` conversions leave every label unchanged |
| Coordinate format | All 89,280 coordinates reproduced exactly via `f6()` |
| Planarity requirement | Measured across all 7,180 non-degenerate faces |
| End-to-end | `demo/demo-venue.dxf` (mm) → 80 faces in metres, in the running app |
| **Import into Soundvision** | **VERIFIED in 3.18.0.15 — see below** |
| Acoustic orientation | **Still NOT verified** — see below |

### The import check, 2026-08-02

A file written by `writeSoundvision` was imported into **Soundvision 3.18.0.15 (2026.2)**
through *Import 3D room data*, and every surface was read back off the Properties panel.
The probe is four surfaces chosen so each one answers something:

| Written by ArrayCAD | Read back in Soundvision | Answers |
| --- | --- | --- |
| `Floor face`, 4 pts, `0,-6,0 / 20,-6,0 / 20,6,0 / 0,6,0` | group **Floor** → Surface 1, 4 points, identical | coordinates survive exactly, in order |
| `Rake face`, 4 pts, rising `0 → 3` over `x 20 → 30` | identical, `Z (auto)` column | a raked plane is not flattened |
| `Hexagon face`, **6 pts** at `z = 6` | **one surface, "Number of points: 6"** | §5 holds *inside* Soundvision — a six-sided region is ONE surface |
| `Wall face`, vertical at `x = 30`, `z 0 → 8` | identical, and the dependent column becomes **`X (auto)`** | a vertical face is recognised as vertical, not folded flat |

Four findings worth keeping:

1. **The `written by ArrayCAD` header line is tolerated.** It was one of the two things §4
   flagged as most likely to need revisiting. It does not need revisiting.
2. **Soundvision strips the trailing ` face` itself.** `"Floor face"` arrives as an object
   named **`Floor`**. So the suffix really is the plug-ins' convention and not part of the
   name, which is independent confirmation that `import/soundvisionScene.ts` is right to
   strip it — both ends agree, and a round trip is name-stable.
3. **A label becomes a GROUP, not a surface name.** `"Floor face"` produced a group `Floor`
   containing `Surface 1`. Labels shared by many faces therefore collect into one group,
   which is exactly what makes the CAD layer tree survive the trip.
4. **`Audience listening level (m)` came in as 0** on every surface, confirming §4: the
   format carries no listening level and Soundvision defaults it.

**What is still not verified: whether a mapping actually results.** Geometry landing
correctly and a surface *predicting* are different claims — §4 is precisely about a
correctly-shaped surface that silently returns nothing because it is wound the wrong way.
Confirming that needs a source placed on the scene and a prediction run over an imported
surface, which this check did not do. Until then the `'up'` winding default is still the
thing most likely to want revisiting; the header attribution line no longer is.
