/**
 * Writer for the Soundvision 3D room data text format.
 *
 * Grammar, in full:
 *
 *   - a line beginning `";` is a comment and is skipped by Soundvision's parser
 *   - the line `";"` on its own also CLOSES the face currently being read
 *   - `"Label","<name>"` opens a face
 *   - every other line is `x,y,z` — three `%.6f` decimals, comma separated, metres
 *
 * The ring is implicit: the last point does not repeat the first.
 */

import { type Vec3 } from '../geom/vec.ts'
import { type SoundvisionFace, type SoundvisionScene, DEFAULT_HEADER, SEPARATOR } from './types.ts'

/**
 * C's `%.6f`, which is what the stock plug-ins emit.
 *
 * The sign is applied to the magnitude rather than left to `toFixed`, because a coordinate
 * of negative zero has to survive: a real Vectorworks export contains `-0.000000` 168
 * times, and `(-0).toFixed(6)` in JavaScript is `"0.000000"`. Getting this wrong costs
 * nothing geometrically but breaks the byte-exact round trip that proves the format is
 * understood. Verified against all 89,280 coordinates of a real export.
 */
export function f6(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`Soundvision export: coordinate is not finite (${n}).`)
  }
  const magnitude = Math.abs(n).toFixed(6)
  return n < 0 || Object.is(n, -0) ? `-${magnitude}` : magnitude
}

/**
 * Newell's normal — the area-weighted normal of a ring, valid for any planar polygon.
 *
 * Not normalised: callers here only ever want its direction, and leaving it unnormalised
 * means a degenerate ring comes back as a zero vector instead of NaN.
 */
export function faceNormal(points: Vec3[]): Vec3 {
  let x = 0
  let y = 0
  let z = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    x += (a.y - b.y) * (a.z + b.z)
    y += (a.z - b.z) * (a.x + b.x)
    z += (a.x - b.x) * (a.y + b.y)
  }
  return { x, y, z }
}

/**
 * Which way a face should end up pointing.
 *
 * `up` is the one that matters. Soundvision's own guidance is that "surface points must be
 * entered counter-clockwise… If the points have not been entered in the right order, the
 * orientation of the surfaces must be reversed" — and a reversed surface is not an error,
 * it simply returns NO mapping result. A CAD export whose floor triangles happen to wind
 * downwards therefore produces a venue that looks perfect and predicts nothing, which is
 * the same class of silent failure as the Y-up handedness trap in geom/transform.ts.
 *
 * Only near-horizontal faces can be judged this way; a wall's normal has no "correct" side
 * without knowing which way the room is, so `up` leaves vertical faces alone.
 */
export type Winding = 'preserve' | 'up'

/** Threshold on the normalised |z| below which a face counts as vertical and is left alone. */
const HORIZONTAL_Z = 0.2

/** Reverse the ring if `mode` demands it. Returns the input array when no change is needed. */
export function orientFace(points: Vec3[], mode: Winding): Vec3[] {
  if (mode === 'preserve' || points.length < 3) return points
  const n = faceNormal(points)
  const length = Math.sqrt(n.x * n.x + n.y * n.y + n.z * n.z)
  if (length === 0) return points
  const nz = n.z / length
  if (nz >= -HORIZONTAL_Z) return points
  return [...points].reverse()
}

/**
 * Labels sit inside a quoted field, so a double quote in one would end the field early and
 * shift every following column. Nothing in the pipeline should produce one, but a CAD layer
 * name is user data and this is cheaper than trusting it.
 */
function sanitiseLabel(label: string): string {
  return label.replace(/["\r\n]/g, ' ').trim() || 'None'
}

export interface WriteOptions {
  winding: Winding
}

export const DEFAULT_WRITE: WriteOptions = { winding: 'up' }

/**
 * Serialise a scene. Faces with fewer than three points are dropped — Soundvision cannot
 * make a plane from two, and the callers upstream already report them as warnings.
 */
export function writeSoundvision(scene: SoundvisionScene, opts: WriteOptions = DEFAULT_WRITE): string {
  const header = scene.header.length > 0 ? scene.header : DEFAULT_HEADER
  const lines: string[] = [...header]

  for (const face of scene.faces) {
    if (face.points.length < 3) continue
    lines.push(`"Label","${sanitiseLabel(face.label)}"`)
    for (const p of orientFace(face.points, opts.winding)) {
      lines.push(`${f6(p.x)},${f6(p.y)},${f6(p.z)}`)
    }
    lines.push(SEPARATOR)
  }

  // A real export ends with the separator that closes its last face, then a newline.
  return `${lines.join('\n')}\n`
}

/** Convenience for the common case: build a scene around faces and serialise it. */
export function writeFaces(faces: SoundvisionFace[], opts: WriteOptions = DEFAULT_WRITE): string {
  return writeSoundvision({ header: [...DEFAULT_HEADER], faces }, opts)
}
