/**
 * The AFMG EASE Focus 3 project file (`.fc3`) object model.
 *
 * REVERSE-ENGINEERED on 2026-08-03 against EASE Focus 3.1.260 (Windows), by saving a
 * default project, decoding it, and round-tripping synthetic files back through the
 * application. There is no published schema. See docs/ease-focus-format.md for the
 * container grammar and the evidence behind every claim here.
 *
 * Why this target matters: EASE Focus has NO geometry import of any kind — its user guide
 * offers manual coordinate entry or tracing over a picture, nothing else — so writing the
 * project file is the only way to get venue geometry in from outside.
 *
 * The model is NOT 3D surfaces. An EASE Focus venue is a set of **audience zones**: plan
 * footprints (rectangle, circular sector, …) with a position, an orientation and a height
 * profile along their axis. A zone contains one or more **areas** — segments of that
 * profile, each a straight run from (d1, z1) to (d2, z2) where `d` is the distance along
 * the zone axis from the zone's front edge. That is the entire geometric vocabulary, and
 * it is why this exporter reduces planes to oriented rectangles rather than writing
 * outlines: there is nothing in the format an outline could land in.
 */

/** One profile segment. Distances in metres from the zone's FRONT edge, heights absolute. */
export interface EaseFocusArea {
  label: string
  /** Start distance along the zone axis, ≥ 0. */
  d1: number
  /** End distance along the zone axis, ≤ the zone depth. */
  d2: number
  /** Height at d1. */
  z1: number
  /** Height at d2. */
  z2: number
}

/**
 * One audience zone. Only `Type=Rectangle` is written — the sector types exist in the
 * format but nothing in a CAD reduction maps onto them.
 *
 * Anchor semantics, established with an on-screen ruler probe (axis glyph at the world
 * origin, zones at known coordinates): **(x, y) is the zone's centre in plan**, +y is up
 * in Top View, and at orientation 0° the zone axis runs along +x with the audience facing
 * −x — the user guide states "0° = facing left". `depth` is the size along the axis,
 * `width` across it. The front edge (d = 0) is therefore at `x − depth/2` when
 * orientation is 0.
 */
export interface EaseFocusZone {
  label: string
  /** Zone centre, metres. */
  x: number
  y: number
  /**
   * Degrees. 0° = audience facing −x (zone axis along +x), assumed counter-clockwise
   * positive. The sign is the one semantic not yet pinned by a probe; see
   * docs/ease-focus-format.md §5.
   */
  orientation: number
  /** Across the axis, metres. */
  width: number
  /** Along the axis, metres. */
  depth: number
  /** Base height offset (`ReferencePoint.Z`). Areas carry absolute heights, so 0 here. */
  referenceZ: number
  areas: EaseFocusArea[]
}

export interface EaseFocusProject {
  title: string
  author: string
  company: string
  notes: string
  zones: EaseFocusZone[]
}

/**
 * The version string written into every file this module produces, exactly as the
 * application that the format was reverse-engineered from writes it — trailing space
 * included. Same policy as the `.dbacv` writer's `appVersion: '12.8.2'`: claim the
 * version actually understood, not the newest one.
 */
export const EASEFOCUS_VERSION = 'EASE Focus 3, Version 3.1.260.3184 '

export const PROJECT_VERSION = '3.0'

/**
 * `Project.SoundSourcesManager.GlobalFilter`, copied verbatim from a default project
 * saved by EASE Focus 3.1.260. An opaque 928-byte blob (base64) holding the default
 * global EQ state; the application writes it even for a project with no sound sources,
 * so this writer does too rather than gamble on the loader tolerating its absence.
 */
export const DEFAULT_GLOBAL_FILTER =
  'oAMAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAMAAAAAAAAIAAAAAQAAAGoAAAAAAAAAKgAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgBIUAAAOAAAAAAAAAABAAAAAAAAAAIAAAAAAAAAAEBfQAEAAAAAAAAAAAAAAAAAAAAAAPA/AAAAAAAAAAABAAAAagAAAAAAAAAqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAExTAAA4AAAAAAAAAAUAAAADAAAAAQAAAAAAAAAAQG9AAAAAAAAAAAAAAAAAAAAAAAAA8D8AAAAAAAAAAAEAAABpAAAAAAAAACkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAMQAAOAAAAAAAAAAEAAAAAwAAAAIAAAAAAAAAAEB/QAAAAAAAAAAAAAAAAAAAAAAAABRAAAAAAAAAAAABAAAAaQAAAAAAAAApAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABADIAADgAAAAAAAAABAAAAAMAAAACAAAAAAAAAABAj0AAAAAAAAAAAAAAAAAAAAAAAAAUQAAAAAAAAAAAAQAAAGkAAAAAAAAAKQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAzAAA4AAAAAAAAAAQAAAADAAAAAgAAAAAAAAAAQJ9AAAAAAAAAAAAAAAAAAAAAAAAAFEAAAAAAAAAAAAEAAABpAAAAAAAAACkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEANAAAOAAAAAAAAAAEAAAAAwAAAAIAAAAAAAAAAECvQAAAAAAAAAAAAAAAAAAAAAAAABRAAAAAAAAAAAABAAAAagAAAAAAAAAqAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAEhTAAA4AAAAAAAAAAYAAAADAAAAAQAAAAAAAAAAQL9AAAAAAAAAAAAAAAAAAAAAAAAA8D8AAAAAAAAAAAEAAABqAAAAAAAAACoAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIATFAAADgAAAAAAAAAAAAAAAAAAAACAAAAAAAAAABAz0ABAAAAAAAAAAAAAAAAAAAAAADwPwAAAAAAAAAAAAAAAA=='

/**
 * The audience-zone geometry limits EASE Focus imposes — the reason ConverTool declines
 * to export this format at all.
 *
 * `MIN_ZONE_WIDTH_METRES` is **enforced by the application, silently**: verified on
 * 3.1.260 by writing a venue with 45 zones narrower than 2 m and reading back what the
 * application saved — every one had become exactly 2 m, centre unmoved, with no warning
 * shown. Depth under 2 m was left alone, so the minimum is on width only.
 *
 * The slope limit is documented rather than observed; it has not been probed.
 *
 * Neither is clamped on write. An exported file should still say what the room is, and
 * clamping here would hide the discrepancy the warning exists to report.
 */
export const MIN_ZONE_WIDTH_METRES = 2
export const MAX_SLOPE_DEG = 45
