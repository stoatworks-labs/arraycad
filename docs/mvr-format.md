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

Not implemented yet. The sketch, so it is not designed into a corner:
one `Layer` named for the project, one `SceneObject` per venue plane, each referencing its
own small glb with an identity matrix and vertices baked in millimetres — so the plane
names pruned in ArrayCAD arrive as a readable object tree in Capture or Depence. The glb
encoder should be hand-rolled and positions-only, for the same reason the `.fc3` container
is hand-rolled: `src/lib/` stays three-free and the output stays byte-exact testable.

Note that §5 lands squarely on the writer too. Until a real file settles which unit a
consumer expects inside the glb, an export is a guess in the same direction as the import.
