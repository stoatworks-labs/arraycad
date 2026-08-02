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
unencrypted, it is bidirectional — the menu offers both *Import 3D room data* and *Export
3D room data*, filter `*.txt;*.xar` — and it is the supported CAD route. DXF is **export
only** (loudspeaker designs out to CAD), so it is not an inbound path.

`.xar` is the EASE audience-area alternative offered by the same menu item. Not implemented.

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
| Coordinate format | All 89,280 coordinates reproduced exactly via `f6()` |
| Planarity requirement | Measured across all 7,180 non-degenerate faces |
| End-to-end | `demo/demo-venue.dxf` (mm) → 80 faces in metres, in the running app |
| **Import into Soundvision** | **NOT verified — see below** |

**No file written by ArrayCAD has yet been opened in Soundvision.** The format is derived
from a real export and reproduced byte for byte, which is strong evidence, but it is not the
same as an accepted import. That check needs Soundvision on a Mac with the file in hand:
*3D room data → Import 3D room data*. Until it has been done, treat the header attribution
line and the `'up'` winding default as the two most likely things to want revisiting.
