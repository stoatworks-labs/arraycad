/**
 * The shared half of the pipeline: imported triangle soup -> simplified planar outlines.
 *
 *   transform -> weld -> coplanar regions -> boundary loops -> simplify
 *
 * Everything up to this point is target-agnostic. What differs between output formats is
 * only the last step — how an outline becomes an object — so ArrayCalc's `geom/convert.ts`
 * and Soundvision's `soundvision/convert.ts` both start here.
 *
 * That split is deliberate. `planarize.ts` is what makes this tool possible at all, and a
 * second copy of the reduction would drift from the first exactly the way the TypeScript
 * and Python writers already did once (see AGENTS.md §6).
 */

import type { ImportedNode } from '../import/types.ts'
import { type PlanarizeOptions, type Region, findCoplanarRegions, weld } from './planarize.ts'
import {
  type Pt2,
  boundaryLoops,
  dropCollinear,
  levelAlignedRect,
  minAreaRect,
  simplifyClosed,
} from './polygon.ts'
import { type ScanReport, findScanRegions } from './scan.ts'
import { type TransformOptions, applyTransform } from './transform.ts'
import { type Basis, planeBasis, signedArea2, toPlane2D } from './vec.ts'

/**
 * m². In a scan, a hole smaller than this is somewhere the scanner did not see — under a
 * seat, behind a pillar — not a doorway or a stair well, and it is left out of the outline
 * rather than cut into the venue as a ring of extra objects. A door is two square metres.
 */
export const SCAN_MIN_HOLE = 1

/** How a region's outline is turned into output geometry. */
export type FitMode =
  /** Keep the outline. Faithful, but faces that are not symmetric trapezoids may split. */
  | 'exact'
  /** Replace the outline with a level-aligned bounding rectangle. One quad per region. */
  | 'rect'

export interface OutlineOptions {
  transform: TransformOptions
  planarize: PlanarizeOptions
  /** Metres. Douglas-Peucker tolerance on the recovered outline. */
  simplifyTolerance: number
  fit: FitMode
  /** Cap on objects emitted per node, largest regions first. 0 means no cap. */
  maxObjectsPerNode: number
}

/** One recovered plane, as a simplified ring in that plane's own 2D frame. */
export interface RegionOutline {
  /** The plane's frame. `basis.n` is the region normal; (u, v, n) is right-handed. */
  basis: Basis
  /** Outer ring, counter-clockwise in (u, v) meaning the normal is along `basis.n`. */
  outer: Pt2[]
  /** Interior rings. Always empty under `fit: 'rect'`. */
  holes: Pt2[][]
}

export interface OutlineStats {
  trianglesIn: number
  regionsFound: number
  regionsDropped: number
  /** What the node measured as, when it was reduced as a scan. */
  scan?: ScanReport
}

/**
 * Reduce one node to planar outlines.
 *
 * `forceRect` squares off every region regardless of `opts.fit`. ArrayCalc needs it for
 * Positioning areas, which it refuses to accept as anything but rectangles.
 */
export function nodeOutlines(
  node: ImportedNode,
  opts: OutlineOptions,
  forceRect = false,
): { outlines: RegionOutline[]; stats: OutlineStats; warnings: string[] } {
  const warnings: string[] = []
  const stats: OutlineStats = { trianglesIn: 0, regionsFound: 0, regionsDropped: 0 }

  const positions = applyTransform(node.positions, opts.transform)
  stats.trianglesIn = positions.length / 9
  if (stats.trianglesIn === 0) return { outlines: [], stats, warnings }

  const mesh = weld(positions, opts.planarize.weldTolerance)
  let regions: Region[]
  // A scan's outline is the zigzag of its triangles' edges, so it is shaved to at least the
  // scale it was meshed at; anything finer is the mesh, not the room.
  let tolerance = opts.simplifyTolerance
  if (opts.planarize.surface === 'scan') {
    const found = findScanRegions(mesh, opts.planarize)
    regions = found.regions
    stats.scan = found.report
    tolerance = Math.max(tolerance, 1.5 * found.report.edge)
  } else {
    regions = findCoplanarRegions(mesh, opts.planarize)
  }
  stats.regionsFound = regions.length

  if (opts.maxObjectsPerNode > 0 && regions.length > opts.maxObjectsPerNode) {
    stats.regionsDropped = regions.length - opts.maxObjectsPerNode
    // findCoplanarRegions already sorted largest-first, so this keeps the biggest surfaces.
    regions = regions.slice(0, opts.maxObjectsPerNode)
  }

  const outlines: RegionOutline[] = []

  for (const region of regions) {
    const loops = boundaryLoops(region, mesh)
    if (loops.length === 0) {
      warnings.push(`"${node.name}": a region had no closed outline and was skipped.`)
      continue
    }

    const basis = planeBasis(region.plane)
    const to2 = (loop: number[]): Pt2[] => loop.map((i) => toPlane2D(mesh.vertices[i], basis))

    let outer = simplifyClosed(dropCollinear(to2(loops[0]), tolerance), tolerance)
    let holes: Pt2[][] = []
    // Prefer a rectangle aligned to the plane's level direction: it is guaranteed to be
    // writable as a single ArrayCalc quad, whereas the tightest rectangle on a tilted plane
    // is usually diagonal and has to be split into two triangles. Falls back to the min-area
    // rectangle on a horizontal plane, where every direction is level.
    const rectangle = (): Pt2[] => {
      const levelled = levelAlignedRect(
        loops[0].map((i) => mesh.vertices[i]),
        region.plane.normal,
      )
      return levelled ? levelled.map((p) => toPlane2D(p, basis)) : minAreaRect(outer)
    }

    if (opts.fit === 'rect' || forceRect) {
      outer = rectangle()
      // A rectangle has no interior to preserve, so holes go with it. Deliberate: 'rect'
      // is the "give me the coverage area, not the joinery" mode.
      if (loops.length > 1) {
        warnings.push(`"${node.name}": ${loops.length - 1} hole(s) discarded by rectangle fit.`)
      }
    } else {
      holes = loops
        .slice(1)
        .map((l) => simplifyClosed(dropCollinear(to2(l), tolerance), tolerance))
        .filter((h) => h.length >= 3)
        .filter((h) => !stats.scan || Math.abs(signedArea2(h)) / 2 >= SCAN_MIN_HOLE)
      // A scanned rectangle comes back with its corners where the noise left them, a few
      // centimetres out: not the symmetric trapezoid ArrayCalc takes as one quad, so every
      // wall of a scanned room went out as two triangles. Where the rectangle covers the
      // outline to within the shave tolerance all the way round, the difference is the
      // scanner's, and the rectangle is the surface. An L or a fan is far outside it.
      if (stats.scan && outer.length >= 4) {
        const rect = rectangle()
        let perimeter = 0
        for (let i = 0; i < outer.length; i++) {
          const a = outer[i]
          const b = outer[(i + 1) % outer.length]
          perimeter += Math.hypot(b[0] - a[0], b[1] - a[1])
        }
        const slack = Math.abs(signedArea2(rect)) / 2 - Math.abs(signedArea2(outer)) / 2
        if (slack <= perimeter * tolerance) outer = rect
      }
    }

    if (outer.length < 3) continue

    outlines.push({ basis, outer, holes })
  }

  return { outlines, stats, warnings }
}
