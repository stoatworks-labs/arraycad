/**
 * The L-Acoustics Soundvision "3D room data" text format.
 *
 * Soundvision's native scene file (`.xmls`) is AES-256-CBC encrypted — the application
 * names its own scheme in
 * `soundvision::core::files::read(path, constants::AES256CBCKey64&, constants::AES256CBCIV32&)`
 * — with a key it assembles at runtime rather than storing, so nothing outside Soundvision
 * can write one. What CAN be written is the interchange format Soundvision documents for
 * exactly this purpose: "It is possible to import in Soundvision 3D room data *.txt files
 * that were exported from CAD software, such as SketchUp or Vectorworks."
 *
 * That is this format. It is what the SU4SV (SketchUp) and Vectorworks plug-ins write, and
 * it is read back through 3D room data > Import 3D room data.
 *
 * See docs/soundvision-format.md for the grammar and the evidence behind it.
 */

import type { Vec3 } from '../geom/vec.ts'

/**
 * One planar polygon. Becomes a Soundvision **Surface**.
 *
 * Soundvision surfaces are free polygons of three or more points, which is why this target
 * is less lossy than `.dbacv`: there is no canonical quad frame to satisfy and no
 * symmetric-trapezoid restriction, so a recovered outline goes out whole instead of being
 * split into triangles. Balconies and revolutions (Soundvision "Profiles") are a different
 * object class and are not expressible here.
 */
export interface SoundvisionFace {
  /**
   * Shown in Soundvision's object tree. The stock plug-ins write `"<layer name> face"`,
   * e.g. `"Stage Trusses face"`, and `"None face"` for geometry on no layer.
   */
  label: string
  /**
   * World-space ring in metres, three or more points, all coplanar.
   *
   * The ring is IMPLICIT — the last point must not repeat the first. Winding decides which
   * side Soundvision treats as the front; see `write.ts`.
   */
  points: Vec3[]
}

export interface SoundvisionScene {
  /**
   * The comment block ahead of the first face, stored verbatim including the leading `";`.
   *
   * Kept raw so a file read here writes back byte for byte. Every line in it is a comment:
   * none of `VECTORWORKS`, `Outside is front`, `Name By Layer`, `Visible Entities` nor a
   * `;`-prefixed `LengthUnit` appears anywhere in the Soundvision binary, so the parser
   * skips the lot. Only `"Label"` rows and coordinate rows carry meaning.
   */
  header: string[]
  faces: SoundvisionFace[]
}

/**
 * The header a real Vectorworks plug-in export begins with, reproduced exactly.
 *
 * The content is inert — see `SoundvisionScene.header` — but this exact block is the one
 * combination proven to import, and there is no way to test a variant without Soundvision
 * in the loop. So the shape stays as the plug-in writes it and ArrayCAD adds its
 * attribution as one more comment line rather than editing the established ones.
 *
 * `LengthUnit` is `m` because `geom/transform.ts` has already converted to metres; this
 * format has no other unit convention worth offering.
 */
export const DEFAULT_HEADER: readonly string[] = [
  '"; VECTORWORKS"',
  '";"',
  '";   using Outside is front (white)"',
  '";   using Name By Layer"',
  '";   using Visible Entities"',
  '";"',
  '";   written by ArrayCAD"',
  '";"',
  '"; LengthUnit","m"',
  '";"',
]

/** Marks both a comment and the end of a face. A line that is exactly this closes a ring. */
export const SEPARATOR = '";"'
