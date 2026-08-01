/**
 * Source CAD space -> ArrayCalc venue space.
 *
 * ArrayCalc's convention, read off the sample file: metres, Z up, +X towards the audience.
 * In that file the stage and the Soundscape plane sit at x = -9.6 and the mix position at
 * x = +13.06, so the room runs along X with the stage at the negative end. Y is
 * left/right and is symmetric about zero for every symmetric object in the venue.
 *
 * This is the ONLY place unit and axis conversion happens. Importers hand over raw source
 * coordinates; see import/types.ts for why.
 */

import type { ImportedNode } from '../import/types.ts'

export interface TransformOptions {
  /** Metres per source unit. 1 for metres, 0.001 for mm, 0.0254 for inches. */
  unitsPerMetre: number
  /** Which source axis points up. Y-up gets rotated to ArrayCalc's Z-up. */
  upAxis: 'y' | 'z'
  /** Degrees about the venue Z axis, applied after the axis fix. Aims the room down +X. */
  headingDeg: number
  /** Metres, applied last: where the source origin lands in venue space. */
  offset: { x: number; y: number; z: number }
  /** Mirror X after everything else, for a model that came in back to front. */
  flipX: boolean
}

export const UNIT_PRESETS: { label: string; unitsPerMetre: number }[] = [
  { label: 'Metres', unitsPerMetre: 1 },
  { label: 'Centimetres', unitsPerMetre: 0.01 },
  { label: 'Millimetres', unitsPerMetre: 0.001 },
  { label: 'Feet', unitsPerMetre: 0.3048 },
  { label: 'Inches', unitsPerMetre: 0.0254 },
]

export const DEFAULT_TRANSFORM: TransformOptions = {
  unitsPerMetre: 1,
  upAxis: 'z',
  headingDeg: 0,
  offset: { x: 0, y: 0, z: 0 },
  flipX: false,
}

/** Apply a transform to a flat xyz triple stream, in place on a copy. */
export function applyTransform(positions: Float64Array, t: TransformOptions): Float64Array {
  const out = new Float64Array(positions.length)
  const s = t.unitsPerMetre
  const rad = (t.headingDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const sx = t.flipX ? -1 : 1

  for (let i = 0; i + 2 < positions.length; i += 3) {
    let x = positions[i] * s
    let y = positions[i + 1] * s
    let z = positions[i + 2] * s

    if (t.upAxis === 'y') {
      // Y-up right-handed (glTF, most mesh formats) -> Z-up right-handed. Source -Z
      // becomes venue +Y, NOT +Y -> +Y: taking the lazy swap mirrors the room, and a
      // mirrored auditorium is the kind of error that survives all the way to site.
      const ny = -z
      const nz = y
      y = ny
      z = nz
    }

    const rx = x * cos - y * sin
    const ry = x * sin + y * cos

    out[i] = rx * sx + t.offset.x
    out[i + 1] = ry + t.offset.y
    out[i + 2] = z + t.offset.z
  }
  return out
}

export interface Bounds {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}

export function boundsOf(nodes: ImportedNode[]): Bounds | null {
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  let any = false

  const walk = (ns: ImportedNode[]) => {
    for (const n of ns) {
      const p = n.positions
      for (let i = 0; i + 2 < p.length; i += 3) {
        any = true
        if (p[i] < minX) minX = p[i]
        if (p[i] > maxX) maxX = p[i]
        if (p[i + 1] < minY) minY = p[i + 1]
        if (p[i + 1] > maxY) maxY = p[i + 1]
        if (p[i + 2] < minZ) minZ = p[i + 2]
        if (p[i + 2] > maxZ) maxZ = p[i + 2]
      }
      walk(n.children)
    }
  }
  walk(nodes)
  if (!any) return null
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }
}

/**
 * Guess the source unit from the model's overall size.
 *
 * A venue is 10-200 m across. If the raw numbers say 30000, the file is in millimetres.
 * Only ever a starting guess, and the UI says so — an 80-foot room and a 24-metre room
 * are both plausible readings of the same bounding box.
 */
export function guessUnits(b: Bounds): number {
  const span = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z)
  if (span > 5000) return 0.001
  if (span > 500) return 0.01
  if (span > 150) return 0.3048
  return 1
}
