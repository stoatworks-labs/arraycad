# The MVR format (`.mvr`), and the visualisers behind it

Companion to `docs/dbacv-format.md`, `docs/soundvision-format.md` and
`docs/ease-focus-format.md`; implemented in `src/lib/mvr/` and `src/lib/import/mvr.ts`.

**Provenance.** Unlike every other format documented here, MVR is **not reverse
engineered**. It is an open standard — DIN SPEC 15801:2023-12, "My Virtual Rig",
maintained by the GDTF group at <https://github.com/mvrdevelopment/spec>. Everything in
§1–§4 below is quoted from the v1.6 specification. §5 is the one thing the specification
does not settle, and is labelled as such.

## 1. Why this format and not Capture's or Depence's

Every lighting visualiser keeps its projects in a closed format:

| Application | Own format | Reads MVR | Writes MVR |
|---|---|---|---|
| Capture | closed | yes, 1.4+ | yes, 1.4 — "including geometry (without materials) and fixtures / patch information with placeholder geometry" |
| Depence | closed; a project *folder* containing `project.depence` | yes | fixtures only |
| Vectorworks, WYSIWYG, grandMA3, Blender | closed / various | yes | yes |

None of those native formats will ever be readable here, and none of them needs to be.
MVR is the interchange format all of them already share, so **one importer covers the
lot** — and it is the only one of them that ArrayCAD could ever write back.

Capture is doubly covered: it also exports glTF (`.glb`) and DWG, both of which this tool
already read before MVR existed here. Its glTF carries a `CAPTURE_model` extension holding
patch data, which the mesh importer ignores harmlessly.

Sources: the Capture 2025 Reference Manual §3.4.3.4 and §3.8.3
(<https://www.capture.se/Manual/en-UK/2025/FileMenu.html>), and Syncronorm's Depence
release notes.

## 2. Container

A zip, per the specification:

```
GeneralSceneDescription.xml     mandatory, at the root
Custom@Fixture1.gdtf            one per fixture type
geo1.3ds / geo1.glb             geometry
Textr12.png                     textures
```

Rules that matter to a reader: STORE or DEFLATE only, no encryption, **every referenced
file at the root** rather than in folders, and filenames that must not differ only by case
— which is why `container.ts` may key members lower-case without risking a collision.

`container.ts` opens the archive **twice**: once for the XML alone, then, once the scene
says which files it actually references, for exactly those. A real show MVR is mostly
`.gdtf` payload — each of those is itself a zip full of models — and inflating all of it
to reach a few hundred kilobytes of venue would cost hundreds of megabytes for nothing.

## 3. Scene structure

```
GeneralSceneDescription   @verMajor @verMinor @provider @providerVersion
  Scene
    AUXData
      Symdef  @uuid @name    reusable geometry, instanced by Symbol
      Class   @uuid @name    a visibility grouping across layers
    Layers
      Layer @uuid @name
        Matrix              spec: elevation only, no rotation or scale
        ChildList
          SceneObject | GroupObject | Fixture | Truss | Support |
          VideoScreen | Projector | FocusPoint
            Matrix
            Classing        a Class uuid
            GDTFSpec        the fixture's GDTF file
            Geometries
              Geometry3D @fileName   geometry from an archive member
              Symbol @symdef         an instance of a Symdef
            ChildList       nesting, recursively
```

One asymmetry worth knowing, because it is easy to read past: a **`Symdef` holds its
geometry under `ChildList`, not under `Geometries`** (spec Table 10), which is the reverse
of everything else. `read.ts` reads both, since exporters do write both.

`Geometry3D@fileName` with no extension means `.3ds` — stated explicitly in the spec.

## 4. Coordinates

> Right-handed, Z-Up, 1 Distance Unit equals 1 mm.

`Matrix` is a 4×3 written `{u1,u2,u3}{v1,v2,v3}{w1,w2,w3}{o1,o2,o3}`, where `u`, `v` and
`w` are the images of the x, y and z axes and `o` is the translation, so a point maps to
`u·x + v·y + w·z + o`. A missing `Matrix` is the identity.

Z-up and right-handed is ArrayCalc's own convention, so `upAxis: 'z'` needs no rotation
and only the datum and heading are ever left to the user.

## 5. ⚠️ The unit of embedded glTF is NOT stated

This is the one open question in the format, and it is a factor-of-1000 one.

Spec Table 46 lists the two permitted geometry formats:

| Format | Requirement, verbatim |
|---|---|
| 3DS | `1 unit = 1 mm` |
| gltf 2.0 | `extensionsRequired` shall be empty |

So `.3ds` is pinned to millimetres and **glTF is left to its own specification, which is
metres**. An MVR is therefore a millimetre document that, in the common case, wraps metre
geometry — the only format in this repo whose parts do not share a unit.

`scene.ts` takes the literal reading: `.3ds` is millimetres, glTF is metres scaled by
1000 on the way in, everything normalised to MVR's own declared millimetre before any
matrix is applied. `import/mvr.ts` then declares `unitsPerMetre: 0.001` once for the whole
scene. That is a normalisation, not a units guess, and it does not break the rule in
AGENTS.md §4: the importer still reports the source document's own stated unit, it just
has to reconcile the parts first.

**Because the deduction is a deduction, it is also range-checked.** `scene.ts` warns when
the finished scene measures under 1 m or over 1 km across — the shape a metres/millimetres
mix-up takes when seen from outside — and names the unit control, so a wrong reading is
visible rather than a silently wrong room.

> **STATUS: to be confirmed against a real file.** Verify by importing an MVR exported
> from Capture or Depence and measuring a known dimension. If it comes in 1000× out, the
> constant to flip is `GLTF_METRES_PER_UNIT` in `src/lib/mvr/types.ts`, and this section
> should record what the real file proved, with the application and version that wrote it.

## 6. What this importer does not read

- **GDTF files.** A fixture's shape lives in its `.gdtf`, itself a zip of 3D models.
  Unzipping one would be work done in order to throw the result away: ArrayCalc places its
  own sources, and a venue full of surfaces shaped like lanterns is exactly what
  `prepare/` spends its time removing — the same reason `loudspeaker` has always been a
  clutter word. Fixtures with no geometry of their own are counted into one warning.
- **Textures, materials, patch, DMX addresses, focus points, projections, MVR-xchange.**
  None of it survives into a room model.

## 7. Node types as evidence

In a visualiser model the **node type is reliable and the name is not** — a truss is as
likely to be called `Sunstrip 12` as `TRUSS 1`. So `scene.ts` stamps the MVR type on every
node of the subtree it produces, not just the wrapper, because `prepare/plan.ts` judges
each node on its own name and tags and never looks at its ancestors. The `Class` name goes
on too: it is the axis MVR users actually organise by, and so the natural one for
"select all like this".

`prepare/vocabulary.ts` then reads those tags with the rules it already had. `Truss`,
`Fixture` and `Projector` land on clutter words directly. `Support` does not — bare
`support` is too ambiguous in a building model, where `ROOF SUPPORT` is structural steel —
so the importer translates that one type into the vocabulary's existing word, `rigging`.

**`VideoScreen` is deliberately not clutter.** An LED wall is a large rigid reflector and
belongs in the prediction.

## 8. Writing MVR

Implemented in `src/lib/mvr/convert.ts`, `write.ts` and `glb.ts`; reached from the
**Export .mvr** button.

**Shape.** One `Layer` named for the project, and **one `SceneObject` per venue plane**,
each with its own small glb and no `Matrix` at all — the coordinates are already where
they belong, and the spec reads a missing `Matrix` as the identity. A visualiser therefore
shows the plane names the user pruned by (`STALLS RAKE`, `BALCONY`) as a readable object
tree rather than one anonymous lump.

**Plane types go out as `Class`es**, which is what a visualiser filters visibility by, so
the audience planes can be toggled as a set. The class name carries the raw numeric code
beside the label — `Listening (1)` — because those labels are inferred and unverified
(CLAUDE.md), and an inferred label leaving this tool unqualified is how a guess becomes
somebody else's fact.

**The glb writer is hand-rolled** (`glb.ts`, positions only, no materials or normals) for
the same reason the `.fc3` container is: `src/lib/` stays three-free so the whole pipeline
runs in node, and every byte is one a test can assert. `extensionsRequired` is satisfied by
never writing an extension. A primitive without normals is flat-shaded by the glTF spec,
which is what a room surface should be — computing them would only invent smoothing the
model does not have.

**uuids are stable, not random.** MVR asks for persistent ids to "track changes between
the different applications", and Depence uses exactly that to re-import an updated MVR and
update in place instead of duplicating the room. `stableUuid` derives them from a 128-bit
FNV-1a over the object's name and its occurrence count — not its array index, or inserting
a plane would renumber everything after it and defeat the point. The version nibble is 4,
which is the truthful classification: v4 covers random *or pseudo-random* bits, and a hash
is a pseudo-random source. It is not a name-based v5 and is not claimed to be.

**The version declared is 1.4, not 1.6.** Nothing written postdates 1.4, and 1.4 is the
floor both Capture and Depence state they accept. A consumer reads `verMajor`/`verMinor` to
decide how to parse, so promising 1.6 features that are not in the file could turn a
readable export into a refused one for nothing.

**This is the only target that does not reduce.** ArrayCalc needs parametric planes and
EASE Focus needs rectangles; glTF wants triangles, which is exactly what `planarize.ts`
already produced. So what goes out is the *simplified* room — one welded, coplanar,
Douglas-Peucker'd surface where the source had a thousand facets — with nothing lost to the
format on the way.

### What is verified, and what is not

Verified: the archive is a valid MVR that `read.ts` parses; the glbs read back through
**three.js's own GLTFLoader**, which is the check a hand-rolled binary writer needs; and an
MVR imported, exported and re-imported produces a byte-for-byte identical venue — a real
file of seven planes came back with every dimension unchanged (12x6 stage, 20x18 stalls
with a 3.2 m rake, 18x9 wall, both symbol-instanced boxes).

**Not verified: that any visualiser opens one.** Nobody has put an ArrayCAD MVR into
Capture or Depence. And §5 lands squarely on the writer as well as the reader — the export
writes glb geometry in metres, which is what this importer reads back, so the round trip
above proves self-consistency and nothing more. A consumer that treats embedded glTF as
millimetres would see the room 1000x small. The button's tooltip says so.

> **TO CONFIRM.** Open an ArrayCAD `.mvr` in Capture or Depence and measure one known
> dimension. If it arrives 1000x out, `GLTF_METRES_PER_UNIT` in `types.ts` is the constant
> to flip and it fixes the reader and the writer together. Record the application and
> version here either way.
