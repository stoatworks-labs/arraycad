# The MVR format (`.mvr`), and the visualisers behind it

Companion to `docs/dbacv-format.md`, `docs/soundvision-format.md` and
`docs/ease-focus-format.md`; implemented in `src/lib/mvr/` and `src/lib/import/mvr.ts`.

**Provenance.** Unlike every other format documented here, MVR is **not reverse
engineered**. It is an open standard — DIN SPEC 15801:2023-12, "My Virtual Rig",
maintained by the GDTF group at <https://github.com/mvrdevelopment/spec>. Everything in
§1–§4 below is quoted from the v1.6 specification. §5 is the one thing the specification
does not settle, and is labelled as such — ArrayCalc 13's own files have since settled it.
§9 records what ArrayCalc 13 does with MVR, which is observed, not specified.

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

Z-up and right-handed is ArrayCalc's own convention, so `upAxis: 'z'` needs no rotation.

**The plan orientation is not the same, and is applied once, in code.** An MVR as
ArrayCalc 13 writes it aims the room down −Y, the way a lighting plot puts the audience at
the bottom of the sheet; an ArrayCalc venue aims it down +X. Venue (x, y) is MVR (y, −x).
`import/mvr.ts` turns a finished MVR scene into venue axes with `intoArrayCalcFrame`, after
`scene.ts` has applied every matrix and never inside that chain; `write.ts` bakes the
inverse into the vertices it writes. That is ArrayCalc's own *Rotate around z: 90°*
default, so an MVR from ArrayCalc lands here the way ArrayCalc had it, an ArrayCAD export
lands in ArrayCalc at the dialog's default, and ArrayCAD → ArrayCAD is unchanged. The two
matrices are `ARRAYCALC_TO_MVR` and `MVR_TO_ARRAYCALC` in `types.ts`, with the evidence.
Heading and datum are still the user's, on top.

## 5. The unit and axes of embedded glTF — not stated, settled by ArrayCalc

This was the one open question in the format, and it is a factor-of-1000 one.

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

**Confirmed: metres, and Y-up.** ArrayCalc 13.2.1 beta (2026-11-16) writes its default
venue's 53 × 40 m floor as a glb spanning 1.78..54.78 by −20..20 — its own floor in metres —
lying in glTF's XZ plane with the height in Y. That is the glTF specification's "+Y is up"
carried inside a Z-up MVR, not an ArrayCalc habit, so it should hold for any conforming
producer; ArrayCalc is the one checked.

The axes were the half nobody had asked about. A glb's (x, y, z) is MVR's (x, −z, y)
(`GLTF_TO_MVR`), applied to glTF only — `.3ds` is MVR's own millimetre Z-up space. ArrayCAD
used to read **and write** glbs as if they were Z-up. The two errors cancelled, so its own
round trip passed, while ArrayCalc imported an ArrayCAD room lying on its back: the plan
view showing the section. A self round trip proves the reader and writer agree and nothing
else; the tests now carry ArrayCalc's own numbers (`import/mvr.test.ts`, "ArrayCalc 13's
MVR dialect") so the axes are checked against something outside this repo.

The range check stays: a producer that writes glTF in millimetres would still be caught.

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
**Export .mvr** and **Export .mvr 1.4** buttons, and the MCP targets `mvr` and
`mvr-visualiser`.

**Two flavours, the same two ArrayCalc 13's own Export MVR offers.** `arraycalc` (the
default; "latest MVR audio extensions" in ArrayCalc, "Vectorworks 2027") writes each
listening plane as a `ListeningPlane` node from the audio proposal, because that node is
the only thing ArrayCalc's importer types as Listening (§9). `visualiser` ("applications
that only support earlier MVR versions") writes every plane as a plain `SceneObject`, for
software that has never heard of the proposal and might drop a node it does not know — for
a lighting visualiser, that would be the audience areas. Same geometry, same uuids: the
uuid key leaves the node type out, so switching flavour never turns one room into two.

**Shape.** One `Layer` named for the project, and **one object per venue plane**, each
with its own small glb and no `Matrix` at all — the coordinates are already where they
belong, and the spec reads a missing `Matrix` as the identity. The tree therefore shows the
plane names the user pruned by (`STALLS RAKE`, `BALCONY`) rather than one anonymous lump.

**Orientation is baked into the vertices**, as ArrayCalc bakes its own: `write.ts` turns
venue space into MVR's plan orientation (`ARRAYCALC_TO_MVR`, §4) and `glb.ts` turns Z-up
into glTF's Y-up (§5). Written as a `Matrix` instead, a consumer that composes matrices
wrongly could turn the room; nothing can mis-read a vertex.

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

**The version declared is the oldest each flavour conforms to.** `visualiser` declares
1.4: nothing in it postdates 1.4, and 1.4 is the floor both Capture and Depence state they
accept. A consumer reads `verMajor`/`verMinor` to decide how to parse, so promising 1.6
features that are not in the file could turn a readable export into a refused one for
nothing. `arraycalc` declares 1.6, because `ListeningPlane` is in no released version and
the only implementation there is — ArrayCalc's own — writes it under 1.6.

**This is the only target that does not reduce.** ArrayCalc needs parametric planes and
EASE Focus needs rectangles; glTF wants triangles, which is exactly what `planarize.ts`
already produced. So what goes out is the *simplified* room — one welded, coplanar,
Douglas-Peucker'd surface where the source had a thousand facets — with nothing lost to the
format on the way.

### What is verified, and what is not

Verified: the archive is a valid MVR that `read.ts` parses; the glbs read back through
**three.js's own GLTFLoader**, which is the check a hand-rolled binary writer needs; and an
MVR imported, exported and re-imported produces an identical venue.

**Verified in ArrayCalc 13.2.1 beta, 2026-11-16**, with exports of `demo/demo-venue.dxf`:

- ArrayCalc parses the file and keeps every object name.
- With Y-up glbs the room arrives the right way up and the right size. Z-up glbs, which
  this writer used to produce, arrived on their backs.
- `ListeningPlane` objects arrive typed Listening. A `SceneObject` arrives as Background,
  whatever its class is called (`Listening (1)` and ArrayCalc's own `Listening Plane` both
  tried).
- A simplified plane is one ArrayCalc element at every *Venue geometry detail* setting.
- Importing the same file again marks every object modified and keeps the types already
  chosen: the stable uuids do what they are for.

**Not yet imported: the export with the quarter turn built in.** The turn is read off
ArrayCalc's own export, and its importer at 90° restored that export exactly; the final
file is built to the same convention but has not itself been through ArrayCalc.

**Not verified: that any visualiser opens the 1.4 flavour.** Nobody has put an ArrayCAD MVR
into Capture or Depence. The unit is no longer the risk (§5); orientation is, since
visualisers have no 90° default to agree with. The button's tooltip says check it.

> **TO CONFIRM.** Import the current `Export .mvr` of the demo venue into ArrayCalc at
> 90°: the stage should sit on x −12..0, y −9..9 and the stalls on x 1..23, as the
> `.dbacv` has them. Then open `Export .mvr 1.4` in Capture or Depence and check the size
> and which way the stage faces. Record the application and version here.

## 9. ArrayCalc 13's MVR

ArrayCalc reads and writes MVR from 13.2 (beta 13.2.1 at the time of writing). Everything
below is observed in that beta, not specified anywhere; d&b's exported files used to find
it are not in the repo.

**Import.** MVR is parsed with libMVRgdtf (the GDTF group's reference library) and geometry
loaded with assimp 5.4.0, so any glb assimp reads will do. The dialog lists every object
with a **Type**: Listening, Structure, Obstacle or Background.

- Only a `ListeningPlane` node arrives as Listening. Class names are ignored, and anything
  ArrayCalc does not recognise defaults to Background. That is why the `arraycalc` flavour
  exists.
- *Venue geometry detail* is ArrayCalc's own mesh → venue-element reduction. It does not
  replace this tool's: a plane already reduced here is one element at every setting, where
  a raw CAD mesh would need the slider and still not get names or plane types.
- *Rotate around z* defaults to 90° on first use and remembers its last value after that.
  The export dialog has the same control, and export at 90° then import at 90° is the
  identity. ArrayCAD writes for 90° (§4). If the room arrives turned, that setting has been
  changed.
- ArrayCalc keeps a uuid mapping per project. A re-import lists each object as new (`*`),
  modified (pencil) or unchanged (`=`), updates in place, and keeps the types chosen last
  time.
- A Background object is kept as a mesh, stored in the project with its own 4×4 transform,
  rather than reduced to venue elements.

**Export.** *Vectorworks 2027* writes each listening plane as a `ListeningPlane` with
`AudioDescriptionFile` naming a per-plane XML of its SPL heat map, each cabinet as a
`Speaker` naming a GDTF (`V8.gdtf`) and each flown frame as a `SpeakerBumper`. *Vectorworks
2026* writes the planes as `SceneObject`s and the cabinets as `Fixture`s. Both declare 1.6,
provider `ArrayCalc d&b`. Glbs are named by uuid, Y-up, metres, with the geometry baked in
and no `Matrix` on the planes.

**Importing that here.** Listening planes are tagged `ListeningPlane` and read as seating
whatever they are called (`Right Corner` says nothing). Loudspeakers have no geometry of
their own and are counted into one warning, apart from lighting fixtures. Heat maps are
ignored: a prediction is the output, not the room.
