/**
 * Imported nodes -> EASE Focus audience zones.
 *
 * Shares the whole reduction with the other two targets (`geom/outline.ts`) and differs
 * in the last step, which here is a genuine REDUCTION rather than a re-serialisation:
 * EASE Focus has no surfaces, only oriented rectangular zones with a height profile, so
 * every recovered plane becomes the best rectangle for it — axis along the slope, front
 * at the low edge, one profile segment from front height to back height.
 *
 * Only Listening planes convert. Walls, ceilings and stages have no representation in
 * EASE Focus at all — the format models the audience and nothing else — so exporting
 * them is not lossy, it is meaningless, and skipping them is reported once rather than
 * warned per node.
 */

import type { ImportedNode } from '../import/types.ts'
import { PlaneType } from '../dbacv/types.ts'
import { type OutlineOptions, type RegionOutline, nodeOutlines } from '../geom/outline.ts'
import { DEFAULT_PLANARIZE } from '../geom/planarize.ts'
import { minAreaRect } from '../geom/polygon.ts'
import { fromPlane2D } from '../geom/vec.ts'
import {
  type EaseFocusProject,
  type EaseFocusZone,
  MAX_SLOPE_DEG,
  MIN_ZONE_WIDTH_METRES,
} from './types.ts'

export type EaseFocusConvertOptions = OutlineOptions

export const DEFAULT_EASEFOCUS_CONVERT: EaseFocusConvertOptions = {
  transform: { unitsPerMetre: 1, upAxis: 'z', headingDeg: 0, offset: { x: 0, y: 0, z: 0 }, flipX: false },
  planarize: DEFAULT_PLANARIZE,
  simplifyTolerance: 0.05,
  fit: 'exact',
  maxObjectsPerNode: 0,
}

export interface EaseFocusStats {
  trianglesIn: number
  regionsFound: number
  regionsDropped: number
  zonesOut: number
  /** Included nodes whose plane type is not Listening; they have no place in this format. */
  nodesNotAudience: number
}

export interface EaseFocusResult {
  project: EaseFocusProject
  stats: EaseFocusStats
  warnings: string[]
}

/** Near-vertical planes cannot be audience: the plan footprint degenerates to a line. */
const VERTICAL_NZ = 0.05

/**
 * One outline -> one zone, or null for a plane no zone can stand for (vertical).
 *
 * The zone axis follows the slope — audience rakes rise away from the stage, so the
 * front is the LOW edge and the facing direction is downslope. A flat plane has no slope
 * to follow; its axis instead points away from the venue origin, on the grounds that the
 * origin is where the PA is and the audience faces it. That guess only sets which edge
 * of a flat zone is called the front, which for a flat zone changes nothing acoustic.
 */
export function outlineToZone(
  outline: RegionOutline,
  label: string,
  warnings: string[],
): EaseFocusZone | null {
  const { basis, outer, holes } = outline
  const n = basis.n
  const nz = Math.abs(n.z)

  if (nz < VERTICAL_NZ) {
    warnings.push(`"${label}": a near-vertical plane cannot be an audience zone and was skipped.`)
    return null
  }

  const world = outer.map(([x, y]) => fromPlane2D(x, y, basis))

  // Steepest-ascent direction in plan, from the plane normal: for z = f(x, y) the
  // gradient is (-nx/nz, -ny/nz). Zero for a horizontal plane, and the same whichever
  // side of the surface the region's normal happened to come out — both components
  // negate, so a downward-wound floor still rakes the right way.
  const gx = -n.x / n.z
  const gy = -n.y / n.z
  const slope = Math.hypot(gx, gy)

  const centroid = world.reduce(
    (acc, p) => ({ x: acc.x + p.x / world.length, y: acc.y + p.y / world.length, z: 0 }),
    { x: 0, y: 0, z: 0 },
  )

  let ax: number
  let ay: number
  if (slope > 1e-4) {
    ax = gx / slope
    ay = gy / slope
  } else {
    // A flat plane has no slope to orient by, so the axis comes from the outline's own
    // minimum-area rectangle — otherwise a rectangle off to one side of the room gets a
    // diagonal zone axis and its bounding rectangle balloons. The venue origin (where
    // the PA is) only decides which of the two rectangle axes is depth, and which end
    // of it is the front: the audience faces the stage, so depth points AWAY from it.
    const rect = minAreaRect(outer)
    const e1u = rect[1][0] - rect[0][0]
    const e1v = rect[1][1] - rect[0][1]
    const len1 = Math.hypot(e1u, e1v) || 1
    // Edge directions mapped from the plane's (u, v) frame to plan.
    const d1x = (basis.u.x * e1u + basis.v.x * e1v) / len1
    const d1y = (basis.u.y * e1u + basis.v.y * e1v) / len1
    const d2x = -d1y
    const d2y = d1x
    const away = Math.hypot(centroid.x, centroid.y)
    const cx0 = away > 1e-6 ? centroid.x / away : 1
    const cy0 = away > 1e-6 ? centroid.y / away : 0
    const along1 = d1x * cx0 + d1y * cy0
    const along2 = d2x * cx0 + d2y * cy0
    if (Math.abs(along1) >= Math.abs(along2)) {
      const sign = along1 >= 0 ? 1 : -1
      ax = d1x * sign
      ay = d1y * sign
    } else {
      const sign = along2 >= 0 ? 1 : -1
      ax = d2x * sign
      ay = d2y * sign
    }
  }

  // Bounding rectangle in the (axis, across) frame.
  const wx = -ay
  const wy = ax
  let minD = Infinity
  let maxD = -Infinity
  let minW = Infinity
  let maxW = -Infinity
  for (const p of world) {
    const d = p.x * ax + p.y * ay
    const w = p.x * wx + p.y * wy
    if (d < minD) minD = d
    if (d > maxD) maxD = d
    if (w < minW) minW = w
    if (w > maxW) maxW = w
  }
  const depth = maxD - minD
  const width = maxW - minW
  if (depth < 1e-6 || width < 1e-6) return null

  const midD = (minD + maxD) / 2
  const midW = (minW + maxW) / 2
  const cx = ax * midD + wx * midW
  const cy = ay * midD + wy * midW

  // Height at the front and back edge midpoints, off the plane equation through any
  // outline point. nz is bounded away from zero above.
  const p0 = world[0]
  const zAt = (x: number, y: number) => p0.z - (n.x * (x - p0.x) + n.y * (y - p0.y)) / n.z
  const frontX = cx - (ax * depth) / 2
  const frontY = cy - (ay * depth) / 2
  const backX = cx + (ax * depth) / 2
  const backY = cy + (ay * depth) / 2
  const z1 = zAt(frontX, frontY)
  const z2 = zAt(backX, backY)

  // 0 degrees = axis along +x (audience facing -x); assumed counter-clockwise positive.
  const orientation = (Math.atan2(ay, ax) * 180) / Math.PI

  if (holes.length > 0) {
    warnings.push(`"${label}": ${holes.length} hole(s) cannot be carried by a zone and were filled in.`)
  }
  // VERIFIED against 3.1.260, and it is a silent widening, not a rejection: a venue
  // written with 45 sub-2 m zones came back from the application with every one of them
  // at exactly 2 m, centres unmoved, no dialog and no error. Depth below 2 m was NOT
  // touched — the minimum applies to width alone. Left unclamped here on purpose so the
  // exported file still says what the room is; the warning is what the user needs.
  if (width < MIN_ZONE_WIDTH_METRES) {
    warnings.push(
      `"${label}" is ${width.toFixed(2)} m wide. EASE Focus silently widens any zone under ` +
        `${MIN_ZONE_WIDTH_METRES} m to ${MIN_ZONE_WIDTH_METRES} m about its centre, so this ` +
        'row will cover more seats there than it does in the room.',
    )
  }
  const slopeDeg = (Math.atan(slope) * 180) / Math.PI
  if (slopeDeg > MAX_SLOPE_DEG) {
    warnings.push(
      `"${label}": the plane rises at ${slopeDeg.toFixed(0)} degrees; EASE Focus allows at most ${MAX_SLOPE_DEG}.`,
    )
  }

  return {
    label,
    x: cx,
    y: cy,
    orientation,
    width,
    depth,
    referenceZ: 0,
    areas: [{ label, d1: 0, d2: depth, z1, z2 }],
  }
}

export function outlinesToZones(
  outlines: RegionOutline[],
  label: string,
  warnings: string[],
): EaseFocusZone[] {
  const zones: EaseFocusZone[] = []
  for (let i = 0; i < outlines.length; i++) {
    const name = outlines.length > 1 ? `${label} ${i + 1}` : label
    const zone = outlineToZone(outlines[i], name, warnings)
    if (zone) zones.push(zone)
  }
  return zones
}

/** A rationalised area, ready to be written alongside the ordinary nodes. */
export interface EaseFocusAreaEntry {
  name: string
  planeType: PlaneType
  outlines: RegionOutline[]
}

export function convertNodesToEaseFocus(
  nodes: { node: ImportedNode; planeType: PlaneType; include: boolean; name: string }[],
  opts: EaseFocusConvertOptions = DEFAULT_EASEFOCUS_CONVERT,
  areas: EaseFocusAreaEntry[] = [],
  projectName = 'ArrayCAD export',
): EaseFocusResult {
  const zones: EaseFocusZone[] = []
  const warnings: string[] = []
  const stats: EaseFocusStats = {
    trianglesIn: 0,
    regionsFound: 0,
    regionsDropped: 0,
    zonesOut: 0,
    nodesNotAudience: 0,
  }

  for (const entry of nodes) {
    if (!entry.include) continue
    if (entry.planeType !== PlaneType.Listening) {
      stats.nodesNotAudience++
      continue
    }
    const reduced = nodeOutlines(entry.node, opts)
    stats.trianglesIn += reduced.stats.trianglesIn
    stats.regionsFound += reduced.stats.regionsFound
    stats.regionsDropped += reduced.stats.regionsDropped
    warnings.push(...reduced.warnings)
    zones.push(...outlinesToZones(reduced.outlines, entry.name, warnings))
  }

  for (const area of areas) {
    if (area.planeType !== PlaneType.Listening) {
      stats.nodesNotAudience++
      continue
    }
    stats.regionsFound += area.outlines.length
    zones.push(...outlinesToZones(area.outlines, area.name, warnings))
  }

  stats.zonesOut = zones.length

  if (stats.nodesNotAudience > 0) {
    warnings.push(
      `${stats.nodesNotAudience} included object(s) are not Listening planes and were left out: ` +
        'EASE Focus models audience zones only — walls, stages and ceilings have no equivalent there.',
    )
  }
  if (zones.length > 0) {
    warnings.push(
      'Each audience plane becomes an oriented rectangular zone with a single profile ' +
        'segment. Outlines beyond the rectangle, and any holes, are not representable in ' +
        'EASE Focus.',
    )
  }

  return {
    project: {
      title: projectName,
      author: 'ArrayCAD',
      company: '',
      notes: '',
      zones,
    },
    stats,
    warnings,
  }
}
