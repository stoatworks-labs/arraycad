/**
 * How far the written venue sits from the model it was made from.
 *
 * Every step of the reduction moves geometry on purpose: a region is flattened onto one
 * plane, its outline shaved by Douglas-Peucker, a scan's corners squared off, a rectangle
 * fitted round a ragged edge, anything under the minimum area dropped. Each is right on its
 * own and none of them says by how much. The object count says the reduction worked; this
 * says what it cost — which is the question a scan raises first, because a scan's planes are
 * only planes to within its noise.
 *
 * Measured against each region's OWN written surface, not the nearest one: the claim being
 * checked is "this quad stands for these triangles", and a triangle that happens to lie near
 * some other quad has not been represented by it.
 */

import type { Region, WeldedMesh } from './planarize.ts'
import { type Pt2, pointInRing } from './polygon.ts'
import { type Basis, signedArea2, toPlane2D } from './vec.ts'

export interface Deviation {
  /** m². The source surface the reduction was given. */
  area: number
  /** m² of it in no written surface: under the minimum area, past the object cap, unoutlined. */
  lost: number
  /** m² of written surface beyond its source: squaring off, rectangle fit, filled holes. */
  added: number
  /** Metres. Area-weighted rms distance of the kept surface from its written surface. */
  rms: number
  /** Metres. The furthest a sampled point of the kept surface sits from its written surface. */
  max: number
}

export const NO_DEVIATION: Deviation = { area: 0, lost: 0, added: 0, rms: 0, max: 0 }

/**
 * Triangles measured per region, at most. A ragged CAD outline is hundreds of points and a
 * region can be a hundred thousand triangles; every one of them against every edge is tens of
 * seconds on a theatre. An even stride over the region's triangles is the same rms to well
 * inside a millimetre, and the max is then the max of what was sampled.
 */
const SAMPLE = 2000

/** One region and the surface written for it, in that region's plane frame. */
export interface Written {
  region: Region
  basis: Basis
  outer: Pt2[]
  holes: Pt2[][]
}

/** Measure a node's written surfaces against the welded mesh they came from. */
export function measureDeviation(mesh: WeldedMesh, written: Written[]): Deviation {
  const { vertices, indices } = mesh
  const triArea = (t: number) => {
    const a = vertices[indices[t * 3]]
    const b = vertices[indices[t * 3 + 1]]
    const c = vertices[indices[t * 3 + 2]]
    const ux = b.x - a.x
    const uy = b.y - a.y
    const uz = b.z - a.z
    const vx = c.x - a.x
    const vy = c.y - a.y
    const vz = c.z - a.z
    return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
  }

  let area = 0
  for (let t = 0; t < indices.length / 3; t++) area += triArea(t)

  let kept = 0
  let added = 0
  let sumSq = 0
  let sampled = 0
  let max = 0
  for (const w of written) {
    const tris = w.region.triangles ?? []
    let regionArea = 0
    for (const t of tris) regionArea += triArea(t)
    kept += regionArea

    const surface = Math.abs(signedArea2(w.outer)) / 2 - w.holes.reduce((s, h) => s + Math.abs(signedArea2(h)) / 2, 0)
    added += Math.max(0, surface - w.region.area)

    const stride = Math.max(1, Math.ceil(tris.length / SAMPLE))
    for (let i = 0; i < tris.length; i += stride) {
      const t = tris[i]
      const a = vertices[indices[t * 3]]
      const b = vertices[indices[t * 3 + 1]]
      const c = vertices[indices[t * 3 + 2]]
      const at = triArea(t)
      const centroid = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, z: (a.z + b.z + c.z) / 3 }
      const d = distanceTo(centroid, w)
      sumSq += at * d * d
      sampled += at
      if (d > max) max = d
      // Corners as well: the shaved outline and the squared-off rectangle both show at the
      // edge of a region, which its triangles' centroids never reach.
      for (const p of [a, b, c]) {
        const dp = distanceTo(p, w)
        if (dp > max) max = dp
      }
    }
  }

  return {
    area,
    lost: Math.max(0, area - kept),
    added,
    rms: sampled > 0 ? Math.sqrt(sumSq / sampled) : 0,
    max,
  }
}

/** Distance from a point to a written surface: off its plane, then outside its outline. */
function distanceTo(p: { x: number; y: number; z: number }, w: Written): number {
  const { origin, n } = w.basis
  const off = (p.x - origin.x) * n.x + (p.y - origin.y) * n.y + (p.z - origin.z) * n.z
  const q = toPlane2D(p, w.basis)
  const inside = pointInRing(q, w.outer) && !w.holes.some((h) => pointInRing(q, h))
  if (inside) return Math.abs(off)
  let across = ringDistance(q, w.outer)
  for (const h of w.holes) across = Math.min(across, ringDistance(q, h))
  return Math.hypot(off, across)
}

function ringDistance(p: Pt2, ring: Pt2[]): number {
  let best = Infinity
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j]
    const [bx, by] = ring[i]
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const s = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2)) : 0
    const d = Math.hypot(p[0] - (ax + s * dx), p[1] - (ay + s * dy))
    if (d < best) best = d
  }
  return best
}

/** Two nodes' deviations as one. The rms is pooled by kept area, not averaged. */
export function addDeviation(a: Deviation, b: Deviation): Deviation {
  const ka = a.area - a.lost
  const kb = b.area - b.lost
  const kept = ka + kb
  return {
    area: a.area + b.area,
    lost: a.lost + b.lost,
    added: a.added + b.added,
    rms: kept > 0 ? Math.sqrt((a.rms * a.rms * ka + b.rms * b.rms * kb) / kept) : 0,
    max: Math.max(a.max, b.max),
  }
}
