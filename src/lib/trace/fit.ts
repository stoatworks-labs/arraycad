/**
 * Fitting a traced region: the corners a source outline becomes.
 *
 * A detected outline is faithful to the drawing, which on a real plot is the problem: a
 * hall with pilasters comes back as a hundred corners describing the wall joinery, and an
 * ArrayCalc listening plane wants four. The fit is the region-level version of the
 * rectangle fit in geom/outline.ts — applied here, in pixel space, so the drawing shows
 * exactly what will be exported and the height table has four rows rather than a hundred.
 *
 * `source` is never modified. Switching the fit re-derives `vertices` and `holes` from it,
 * so a rectangle can always go back to the detected outline; edits made on top of a fit —
 * a dragged corner, a removed hole — are edits to the derived corners, and are what a
 * re-fit discards.
 */

import { type Pt2, convexHull, minAreaRect } from '../geom/polygon.ts'
import type { Px, RegionFit, TraceRegion } from './types.ts'
import { fitHeightPlane, heightAt } from './heights.ts'

/** The corners and holes `fit` gives a source outline. Holes survive only 'outline'. */
export function fitOutline(source: TraceRegion['source'], fit: RegionFit): { vertices: Px[]; holes: Px[][] } {
  const copy = (ring: Px[]): Px[] => ring.map((p) => [p[0], p[1]])
  switch (fit) {
    case 'rect':
      return { vertices: copy(minAreaRect(source.vertices as Pt2[]) as Px[]), holes: [] }
    case 'hull':
      return { vertices: copy(convexHull(source.vertices as Pt2[]) as Px[]), holes: [] }
    default:
      return { vertices: copy(source.vertices), holes: source.holes.map(copy) }
  }
}

/**
 * Re-derive a region's corners for a new fit.
 *
 * Heights carry across through the plane fitted to the current corners, so a level floor
 * stays level and a rake stays a rake. A fit has nowhere to keep a per-corner step, so a
 * surface that was not planar is flattened onto that plane — which is what asking for a
 * four-corner rectangle means.
 */
export function fitRegion(region: TraceRegion, fit: RegionFit): TraceRegion {
  const { vertices, holes } = fitOutline(region.source, fit)
  // Fitted in pixel space rather than metres: the plane is only ever evaluated at pixels,
  // and the same affine map takes both to venue space, so the heights come out identical.
  const plane = fitHeightPlane(region.vertices.map((v) => ({ x: v.p[0], y: v.p[1], z: v.z })))
  return {
    ...region,
    fit,
    vertices: vertices.map((p) => ({ p, z: Math.round(heightAt(plane, p[0], p[1]) * 1000) / 1000 })),
    holes,
  }
}
