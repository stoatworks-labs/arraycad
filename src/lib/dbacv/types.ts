/**
 * The d&b ArrayCalc venue file (.dbacv) object model.
 *
 * REVERSE-ENGINEERED from a real ArrayCalc 12.8.2 export (test/fixtures/theatre.dbacv).
 * There is no published schema. Everything in this file that is asserted as fact was
 * observed in that file; everything inferred is labelled as such. See docs/dbacv-format.md.
 */

/** Metres. ArrayCalc is metric throughout; the file carries no unit declaration. */
export interface Vec3 {
  x: number
  y: number
  z: number
}

/**
 * `Shape` selects which geometry attributes/children the object carries.
 * Codes observed: 1, 2, 4, 5, 6. Codes 0 and 3 were not present in the sample.
 */
export enum Shape {
  /** 4 corner points, P1..P4. Need NOT be planar — the sample rakes seating by moving P2/P3 in z. */
  Quad = 1,
  /**
   * Elliptical annulus sector. No P children at all; defined entirely by attributes:
   * Inner/OuterRadiusA (semi-axis 1), Inner/OuterRadiusB (semi-axis 2), Inner/OuterZ,
   * StartAngle and SpanAngle (degrees). This is how ArrayCalc draws curved raked tiers.
   */
  Arc = 2,
  /** 8 points, P1..P8: bottom quad P1..P4 then top quad P5..P8. A prism/box. */
  Box = 4,
  /** A group. Carries no geometry of its own; children are nested RoomObject elements. */
  Group = 5,
  /** 3 corner points, P1..P3. */
  Triangle = 6,
}

/**
 * `PlaneType` — what the object IS acoustically.
 *
 * ⚠️ THESE LABELS ARE INFERRED, NOT VERIFIED against ArrayCalc's own UI. They are
 * deductions from the names, colours and ListenerHeight values in the sample file:
 * PlaneType 1 objects are the seating blocks and carry ListenerHeight 1.2 (seated) or
 * 1.7 (standing at the mix position); PlaneType 2 objects are ceilings, rails and
 * lighting bridges and carry ListenerHeight 0.01; PlaneType 4 is the stage and
 * proscenium; PlaneType 5 is the single object named SOUNDSCAPE; PlaneType 0 is only
 * ever used by groups.
 *
 * Code 3 was not present in the sample and its meaning is unknown.
 *
 * The UI always shows the raw code alongside the label so a wrong guess is visible
 * rather than silently misleading. Correct these once checked against ArrayCalc.
 */
export enum PlaneType {
  /** Observed only on groups. */
  None = 0,
  /** Inferred: audience / listening plane. Where ArrayCalc computes coverage. */
  Audience = 1,
  /** Inferred: acoustic surface or obstacle — ceiling, wall, rail, bridge. */
  Surface = 2,
  /** Not observed in the sample. Meaning unknown. */
  Unknown3 = 3,
  /** Inferred: stage / structure. */
  Stage = 4,
  /** Inferred: Soundscape (En-Scene/En-Space) system plane. */
  Soundscape = 5,
}

export const PLANE_TYPES: { code: PlaneType; label: string; verified: boolean; hint: string }[] = [
  { code: PlaneType.None, label: 'None / group', verified: false, hint: 'Only seen on groups.' },
  {
    code: PlaneType.Audience,
    label: 'Audience',
    verified: false,
    hint: 'Seating and standing areas. Coverage is computed here.',
  },
  {
    code: PlaneType.Surface,
    label: 'Surface',
    verified: false,
    hint: 'Ceilings, walls, rails, bridges — geometry that is not listened to.',
  },
  { code: PlaneType.Unknown3, label: 'Type 3', verified: false, hint: 'Not seen in any sample.' },
  { code: PlaneType.Stage, label: 'Stage', verified: false, hint: 'Stage deck, proscenium.' },
  {
    code: PlaneType.Soundscape,
    label: 'Soundscape',
    verified: false,
    hint: 'The En-Scene/En-Space object plane.',
  },
]

/** Default ListenerHeight in metres, by inferred plane type. Matches the sample. */
export const DEFAULT_LISTENER_HEIGHT: Record<number, number> = {
  [PlaneType.None]: 1.2,
  [PlaneType.Audience]: 1.2,
  [PlaneType.Surface]: 0.01,
  [PlaneType.Unknown3]: 1.2,
  [PlaneType.Stage]: 0.01,
  [PlaneType.Soundscape]: 0.01,
}

/** Attributes unique to Shape.Arc. All present-or-all-absent in the sample. */
export interface ArcParams {
  innerRadiusA: number
  innerRadiusB: number
  outerRadiusA: number
  outerRadiusB: number
  innerZ: number
  outerZ: number
  /** Degrees. */
  startAngle: number
  /** Degrees. */
  spanAngle: number
}

/**
 * One `<RoomObject>`.
 *
 * `id` is OURS, not the file's: the file has no id attribute. `ParentVenueObjectId`
 * refers to the parent's 1-based position in a depth-first walk of the document, which
 * means it is fully derivable on write and must never be stored. See write.ts.
 */
export interface RoomObject {
  id: string
  name: string
  shape: Shape
  planeType: PlaneType
  /** Metres. */
  listenerHeight: number
  /**
   * Set only when the file's ListenerHeight was not a finite number. ArrayCalc writes a
   * bare `nan` for it on some groups; preserving the literal keeps round-trips byte-exact
   * without ever letting NaN into `listenerHeight` and from there into the geometry.
   */
  listenerHeightRaw?: string
  enabled: boolean
  locked: boolean
  transparent: boolean
  /** ARGB packed into a uint32, e.g. 4278239406. */
  color: number
  printColor: number
  /** Not the document order — ArrayCalc's own display ordering. Groups sit at 101+. */
  orderIndex: number
  origin: Vec3
  /** Degrees, applied about the object origin. */
  rotation: Vec3
  scaling: Vec3
  /** Local coordinates relative to `origin`. Length depends on `shape`: 3, 4, 8 or 0. */
  points: Vec3[]
  /** Present iff shape === Shape.Arc. */
  arc?: ArcParams
  children: RoomObject[]
}

export interface VenueFile {
  /** ArrayCalc version string from the root element, e.g. "12.8.2". */
  appVersion: string
  /** `<Venue Version="...">`, e.g. "9". Distinct from appVersion. */
  venueVersion: string
  projectName: string
  /** Written as DD.MM.YYYY in the sample. */
  date: string
  author: string
  projectComments: string
  venueComments: string
  objects: RoomObject[]
}

/** ARGB uint32 -> CSS hex, discarding alpha. */
export function argbToCss(argb: number): string {
  const rgb = argb & 0xffffff
  return '#' + rgb.toString(16).padStart(6, '0')
}

/** CSS hex -> ARGB uint32 with alpha forced opaque. */
export function cssToArgb(css: string): number {
  const rgb = parseInt(css.replace('#', ''), 16) & 0xffffff
  // >>> 0 keeps it an unsigned 32-bit value; without it this goes negative.
  return ((0xff << 24) | rgb) >>> 0
}

export function pointCountForShape(shape: Shape): number {
  switch (shape) {
    case Shape.Triangle:
      return 3
    case Shape.Quad:
      return 4
    case Shape.Box:
      return 8
    case Shape.Arc:
    case Shape.Group:
      return 0
  }
}
