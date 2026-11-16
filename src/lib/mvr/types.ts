/**
 * The MVR (My Virtual Rig) scene object model.
 *
 * Unlike every other format in this repo, MVR is NOT reverse-engineered. It is an open
 * standard — DIN SPEC 15801:2023-12, published at https://github.com/mvrdevelopment/spec
 * — and everything asserted here is quoted from the v1.6 specification. The one thing the
 * spec does NOT settle is the unit (and axes) of embedded glTF geometry; see UNITS below
 * and docs/mvr-format.md, where ArrayCalc 13's own files settle it.
 *
 * Why this format matters: MVR is the door into every lighting visualiser at once.
 * Capture imports MVR 1.4+ and exports MVR 1.4 with venue geometry; Depence imports MVR;
 * Vectorworks, WYSIWYG, grandMA3 and Blender all read and write it. None of their native
 * formats is public, and none of them needs to be.
 *
 * ## UNITS — the one genuine ambiguity
 *
 * The spec states the coordinate system exactly, in §"Node Definition: Matrix":
 * "Right-handed, Z-Up, 1 Distance Unit equals 1 mm". Table 46 then requires embedded
 * `.3ds` to be `1 unit = 1 mm` as well, but says nothing about the units of embedded
 * glTF — which by the glTF 2.0 specification is METRES.
 *
 * So an MVR is a millimetre document that (usually) wraps metre geometry, and the
 * importer has to reconcile the two. It normalises everything to millimetres, MVR's own
 * declared unit, and declares `unitsPerMetre: MVR_UNITS_PER_METRE`. Getting this backwards
 * is a 1000x error, so `scene.ts` also range-checks the result and warns rather than
 * letting a silently wrong room through.
 */

/**
 * Metres per MVR distance unit. The spec's "1 Distance Unit equals 1 mm", as the number
 * `geom/transform.ts` wants. (That field is metres-per-source-unit despite its name.)
 */
export const MVR_UNITS_PER_METRE = 0.001

/**
 * Metres per unit of an embedded glTF/glb, by the glTF 2.0 specification.
 *
 * MVR does not state it — Table 46 constrains `.3ds` to millimetres and leaves glTF to its
 * own specification, which is metres — but a real producer now settles it: ArrayCalc
 * 13.2.1 beta writes its default venue's 53 x 40 m floor as a glb spanning 1.78..54.78 by
 * -20..20, which is metres. Every glb therefore gets scaled by
 * `GLTF_METRES_PER_UNIT / MVR_UNITS_PER_METRE` (i.e. x1000) on the way into MVR space.
 * See docs/mvr-format.md §5.
 */
export const GLTF_METRES_PER_UNIT = 1

/**
 * Embedded glTF -> MVR axes. glTF is Y-up by its own specification ("+Y is up"), MVR is
 * Z-up, so a glb's (x, y, z) is MVR's (x, -z, y) — the same right-handed fix
 * `geom/transform.ts` makes for a glTF opened directly.
 *
 * Confirmed against ArrayCalc 13.2.1 beta, in both directions: its exported glbs lay the
 * floor in glTF's XZ plane with the height in Y, and an ArrayCAD glb written Z-up arrived
 * in it lying on its back — the plan view showing the section. The swap is applied to
 * glTF only; `.3ds` is MVR's own millimetre, Z-up space.
 */
export const GLTF_TO_MVR: MvrMatrix = {
  u: [1, 0, 0],
  v: [0, 0, 1],
  w: [0, -1, 0],
  o: [0, 0, 0],
}

/**
 * ArrayCalc venue space -> MVR plan orientation, as ArrayCalc itself writes MVR.
 *
 * ArrayCalc aims the room down +X (stage at the negative end); an MVR from it aims the room
 * down -Y, the way a lighting plot is drawn with the audience at the bottom of the sheet.
 * Its Export MVR and Import MVR dialogs both default to "Rotate around z: 90°", and the
 * two are exact inverses: the default venue exported at 90° and imported at 90° comes back
 * with its floor on 1.78..54.78 x -20..20 again. Read off that export, ArrayCalc (x, y)
 * becomes MVR (y, -x) — the right corner of its default room, at y = -20..-45, is written
 * at MVR x = -20..-45.
 *
 * ArrayCAD's venue space IS ArrayCalc's (that is what a `.dbacv` holds), so the writer
 * applies this and the importer its inverse. An ArrayCAD MVR then imports into ArrayCalc
 * correctly at the dialog's default, sits in Vectorworks or Capture the way ArrayCalc's
 * own export does, and an MVR from either lands in ArrayCAD aimed down +X.
 */
export const ARRAYCALC_TO_MVR: MvrMatrix = {
  u: [0, -1, 0],
  v: [1, 0, 0],
  w: [0, 0, 1],
  o: [0, 0, 0],
}

/** The inverse of `ARRAYCALC_TO_MVR`: MVR (x, y) becomes ArrayCalc (-y, x). */
export const MVR_TO_ARRAYCALC: MvrMatrix = {
  u: [0, 1, 0],
  v: [-1, 0, 0],
  w: [0, 0, 1],
  o: [0, 0, 0],
}

/** Metres per unit of an embedded `.3ds`. Table 46: "1 unit = 1 mm". Stated, not deduced. */
export const TDS_METRES_PER_UNIT = 0.001

/** The root file every MVR archive must contain. Spec §"File Format Definition". */
export const ROOT_FILE = 'GeneralSceneDescription.xml'

/**
 * A 4x3 transform, in the spec's own order: three basis vectors then the origin.
 *
 * Written as `{u1,u2,u3}{v1,v2,v3}{w1,w2,w3}{o1,o2,o3}`. Stored flat, column-major in the
 * sense that `u`, `v`, `w` are the images of the x, y and z axes and `o` is the
 * translation — so a point maps to `u*x + v*y + w*z + o`. `mul` and `apply` below are the
 * only two operations anything needs.
 */
export interface MvrMatrix {
  u: [number, number, number]
  v: [number, number, number]
  w: [number, number, number]
  o: [number, number, number]
}

export const IDENTITY: MvrMatrix = {
  u: [1, 0, 0],
  v: [0, 1, 0],
  w: [0, 0, 1],
  o: [0, 0, 0],
}

/** `a` then `b`: the matrix that applies `a` first, as nesting a child inside a parent does. */
export function mul(parent: MvrMatrix, child: MvrMatrix): MvrMatrix {
  const map = (p: [number, number, number]): [number, number, number] => [
    parent.u[0] * p[0] + parent.v[0] * p[1] + parent.w[0] * p[2],
    parent.u[1] * p[0] + parent.v[1] * p[1] + parent.w[1] * p[2],
    parent.u[2] * p[0] + parent.v[2] * p[1] + parent.w[2] * p[2],
  ]
  const o = map(child.o)
  return {
    u: map(child.u),
    v: map(child.v),
    w: map(child.w),
    // The parent's own translation is added once, after its basis has mapped the child's.
    o: [o[0] + parent.o[0], o[1] + parent.o[1], o[2] + parent.o[2]],
  }
}

/** Transform a flat xyz triple stream in place. */
export function applyMatrix(positions: Float64Array, m: MvrMatrix): void {
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i]
    const y = positions[i + 1]
    const z = positions[i + 2]
    positions[i] = m.u[0] * x + m.v[0] * y + m.w[0] * z + m.o[0]
    positions[i + 1] = m.u[1] * x + m.v[1] * y + m.w[1] * z + m.o[1]
    positions[i + 2] = m.u[2] * x + m.v[2] * y + m.w[2] * z + m.o[2]
  }
}

/** Uniform scale, for the per-file unit normalisation. */
export function scaleMatrix(s: number): MvrMatrix {
  return { u: [s, 0, 0], v: [0, s, 0], w: [0, 0, s], o: [0, 0, 0] }
}

/**
 * The object node types a `ChildList` may hold, spec Table 18.
 *
 * Carried through onto `ImportedNode.tags` verbatim, because in a visualiser model the
 * node type is what says an object is rigging rather than room — far more reliable than
 * the name, which in a real show file is as likely to be "Sunstrip 12" as "TRUSS 1".
 *
 * The last three are not in any released MVR. They come from the `audio-proposal` branch
 * of github.com/mvrdevelopment/spec, and ArrayCalc 13.2.1 beta writes them when its export
 * targets Vectorworks 2027: each listening plane as a `ListeningPlane` (with an SPL heat
 * map beside it), each cabinet as a `Speaker` naming a GDTF, each flown array's frame as a
 * `SpeakerBumper` holding them. ArrayCalc's importer keys on `ListeningPlane` — it is what
 * makes a plane arrive as Listening rather than Background — so `write.ts` emits it too.
 */
export type MvrObjectType =
  | 'SceneObject'
  | 'GroupObject'
  | 'FocusPoint'
  | 'Fixture'
  | 'Support'
  | 'Truss'
  | 'VideoScreen'
  | 'Projector'
  | 'ListeningPlane'
  | 'Speaker'
  | 'SpeakerBumper'

export const OBJECT_TYPES: readonly MvrObjectType[] = [
  'SceneObject',
  'GroupObject',
  'FocusPoint',
  'Fixture',
  'Support',
  'Truss',
  'VideoScreen',
  'Projector',
  'ListeningPlane',
  'Speaker',
  'SpeakerBumper',
]

/** `Geometries > Geometry3D`: geometry from another file in the archive. */
export interface MvrGeometry3D {
  kind: 'file'
  /** Spec: "If there is no extension, it will assume that the extension is 3ds." */
  fileName: string
  matrix: MvrMatrix
}

/** `Geometries > Symbol`: an instance of a `Symdef` from `AUXData`. */
export interface MvrSymbol {
  kind: 'symbol'
  /** The uuid of the `Symdef` that holds the geometry. */
  symdef: string
  matrix: MvrMatrix
}

export type MvrGeometry = MvrGeometry3D | MvrSymbol

/** A reusable geometry definition from `AUXData`, instanced by `MvrSymbol`. */
export interface MvrSymdef {
  uuid: string
  name: string
  geometries: MvrGeometry[]
}

/** One object in a `ChildList`, or one `Layer` (which is the same shape with no type). */
export interface MvrObject {
  uuid: string
  name: string
  type: MvrObjectType
  matrix: MvrMatrix
  geometries: MvrGeometry[]
  /** `Classing` resolved to a class name, when `AUXData` declares one. */
  className?: string
  /** Set on a `Fixture` or `SceneObject` that names an external GDTF file. */
  gdtfSpec?: string
  children: MvrObject[]
}

export interface MvrLayer {
  uuid: string
  name: string
  matrix: MvrMatrix
  children: MvrObject[]
}

export interface MvrScene {
  /** `GeneralSceneDescription@verMajor.verMinor`, e.g. "1.6". */
  version: string
  /** `@provider` and `@providerVersion`: which application wrote this. */
  provider: string
  providerVersion: string
  symdefs: Map<string, MvrSymdef>
  layers: MvrLayer[]
}
