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
import { type PlanarizeOptions, findCoplanarRegions, weld } from './planarize.ts'
import {
  type Pt2,
  boundaryLoops,
  dropCollinear,
  levelAlignedRect,
  minAreaRect,
  simplifyClosed,
} from './polygon.ts'
import { type TransformOptions, applyTransform } from './transform.ts'
import { type Basis, planeBasis, toPlane2D } from './vec.ts'

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
  let regions = findCoplanarRegions(mesh, opts.planarize)
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

    let outer = simplifyClosed(dropCollinear(to2(loops[0]), opts.simplifyTolerance), opts.simplifyTolerance)
    let holes: Pt2[][] = []

    if (opts.fit === 'rect' || forceRect) {
      // Prefer a rectangle aligned to the plane's level direction: it is guaranteed to be
      // writable as a single ArrayCalc quad, whereas the tightest rectangle on a tilted
      // plane is usually diagonal and has to be split into two triangles. Falls back to
      // the min-area rectangle on a horizontal plane, where every direction is level.
      const levelled = levelAlignedRect(
        loops[0].map((i) => mesh.vertices[i]),
        region.plane.normal,
      )
      outer = levelled ? levelled.map((p) => toPlane2D(p, basis)) : minAreaRect(outer)
      // A rectangle has no interior to preserve, so holes go with it. Deliberate: 'rect'
      // is the "give me the coverage area, not the joinery" mode.
      if (loops.length > 1) {
        warnings.push(`"${node.name}": ${loops.length - 1} hole(s) discarded by rectangle fit.`)
      }
    } else {
      holes = loops
        .slice(1)
        .map((l) => simplifyClosed(dropCollinear(to2(l), opts.simplifyTolerance), opts.simplifyTolerance))
        .filter((h) => h.length >= 3)
    }

    if (outer.length < 3) continue

    outlines.push({ basis, outer, holes })
  }

  return { outlines, stats, warnings }
}
