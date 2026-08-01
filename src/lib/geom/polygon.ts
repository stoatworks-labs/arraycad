/**
 * Region -> outline -> ArrayCalc shapes.
 *
 * A region from planarize.ts is still a fan of triangles. ArrayCalc only speaks triangles,
 * quads, boxes and arc segments, so the outline has to be recovered and then re-expressed
 * in as few of those as possible. Fewer, bigger planes is the whole point: a venue with
 * 900 RoomObjects is not usable, and a venue with 40 is.
 */

import earcut from 'earcut'
import type { Region, WeldedMesh } from './planarize.ts'
import {
  type Basis,
  type Vec3,
  add,
  cross,
  dot,
  fromPlane2D,
  len,
  normalize,
  planeBasis,
  scale,
  signedArea2,
  sub,
  toPlane2D,
} from './vec.ts'

export type Pt2 = [number, number]

/**
 * Recover the boundary loops of a region.
 *
 * Every interior edge is traversed once in each direction by the two triangles sharing it;
 * a boundary edge is traversed once. So the directed edges with no opposing twin are
 * exactly the boundary, and chaining them by start vertex walks the loops. This relies on
 * the consistent winding that findCoplanarRegions applies before it returns.
 *
 * Returns loops largest-first by absolute area, so the outer boundary is [0] and any holes
 * follow.
 */
export function boundaryLoops(region: Region, mesh: WeldedMesh): number[][] {
  const directed = new Set<string>()
  const idx = region.indices
  for (let i = 0; i < idx.length; i += 3) {
    directed.add(`${idx[i]}>${idx[i + 1]}`)
    directed.add(`${idx[i + 1]}>${idx[i + 2]}`)
    directed.add(`${idx[i + 2]}>${idx[i]}`)
  }

  const next = new Map<number, number[]>()
  for (const e of directed) {
    const [a, b] = e.split('>').map(Number)
    if (directed.has(`${b}>${a}`)) continue // interior: both directions present
    const list = next.get(a)
    if (list) list.push(b)
    else next.set(a, [b])
  }

  const loops: number[][] = []
  while (next.size) {
    const start = next.keys().next().value as number
    const loop: number[] = []
    let cur = start
    // A vertex where several boundary loops touch has more than one outgoing edge. Taking
    // whichever is left and bailing on a repeat keeps a pinched region from looping forever.
    for (let guard = 0; guard < 1e6; guard++) {
      const outs = next.get(cur)
      if (!outs || outs.length === 0) break
      const nxt = outs.pop()!
      if (outs.length === 0) next.delete(cur)
      loop.push(cur)
      cur = nxt
      if (cur === start) break
    }
    if (loop.length >= 3) loops.push(loop)
  }

  const basis = planeBasis(region.plane)
  return loops.sort((a, b) => {
    const aa = Math.abs(signedArea2(a.map((i) => toPlane2D(mesh.vertices[i], basis))))
    const ba = Math.abs(signedArea2(b.map((i) => toPlane2D(mesh.vertices[i], basis))))
    return ba - aa
  })
}

/** Drop vertices whose perpendicular offset from the line through their neighbours is tiny. */
export function dropCollinear(poly: Pt2[], tol: number): Pt2[] {
  if (poly.length <= 3) return poly
  const out: Pt2[] = []
  for (let i = 0; i < poly.length; i++) {
    const p = poly[(i - 1 + poly.length) % poly.length]
    const c = poly[i]
    const n = poly[(i + 1) % poly.length]
    const ax = n[0] - p[0]
    const ay = n[1] - p[1]
    const l = Math.hypot(ax, ay)
    const d = l < 1e-12 ? Math.hypot(c[0] - p[0], c[1] - p[1]) : Math.abs(ax * (p[1] - c[1]) - ay * (p[0] - c[0])) / l
    if (d > tol) out.push(c)
  }
  return out.length >= 3 ? out : poly
}

/** Douglas-Peucker on an open chain. */
function dpChain(pts: Pt2[], tol: number): Pt2[] {
  if (pts.length < 3) return pts
  const first = pts[0]
  const last = pts[pts.length - 1]
  let worst = -1
  let worstI = 0
  const ax = last[0] - first[0]
  const ay = last[1] - first[1]
  const l = Math.hypot(ax, ay)
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]
    const d =
      l < 1e-12
        ? Math.hypot(p[0] - first[0], p[1] - first[1])
        : Math.abs(ax * (first[1] - p[1]) - ay * (first[0] - p[0])) / l
    if (d > worst) {
      worst = d
      worstI = i
    }
  }
  if (worst <= tol) return [first, last]
  return [...dpChain(pts.slice(0, worstI + 1), tol).slice(0, -1), ...dpChain(pts.slice(worstI), tol)]
}

/**
 * Simplify a closed polygon.
 *
 * Split at the two most distant vertices before running Douglas-Peucker: DP on a closed
 * ring anchored at an arbitrary vertex will happily shave off the far side of the ring,
 * which on a seating block means losing an entire back row.
 */
export function simplifyClosed(poly: Pt2[], tol: number): Pt2[] {
  if (poly.length <= 4) return poly
  let bi = 0
  let bj = 0
  let best = -1
  for (let i = 0; i < poly.length; i++) {
    for (let j = i + 1; j < poly.length; j++) {
      const d = Math.hypot(poly[i][0] - poly[j][0], poly[i][1] - poly[j][1])
      if (d > best) {
        best = d
        bi = i
        bj = j
      }
    }
  }
  const a = poly.slice(bi, bj + 1)
  const b = [...poly.slice(bj), ...poly.slice(0, bi + 1)]
  const sa = dpChain(a, tol)
  const sb = dpChain(b, tol)
  const merged = [...sa.slice(0, -1), ...sb.slice(0, -1)]
  return merged.length >= 3 ? merged : poly
}

/**
 * The smallest-area rectangle enclosing a 2D point set, by rotating calipers over every
 * hull edge direction.
 *
 * This is the "fit one quad" answer, and for audience planes it is usually the RIGHT
 * answer: a seating block traced from CAD has a ragged 60-vertex outline that describes
 * the carpet, not the coverage area, and four corners is what a person would have drawn.
 */
export function minAreaRect(poly: Pt2[]): Pt2[] {
  const hull = convexHull(poly)
  if (hull.length < 3) return poly
  let best: Pt2[] | null = null
  let bestArea = Infinity
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i]
    const q = hull[(i + 1) % hull.length]
    const ex = q[0] - p[0]
    const ey = q[1] - p[1]
    const l = Math.hypot(ex, ey)
    if (l < 1e-12) continue
    const ux = ex / l
    const uy = ey / l
    let minU = Infinity
    let maxU = -Infinity
    let minV = Infinity
    let maxV = -Infinity
    for (const h of hull) {
      const u = h[0] * ux + h[1] * uy
      const v = -h[0] * uy + h[1] * ux
      if (u < minU) minU = u
      if (u > maxU) maxU = u
      if (v < minV) minV = v
      if (v > maxV) maxV = v
    }
    const area = (maxU - minU) * (maxV - minV)
    if (area < bestArea) {
      bestArea = area
      const un = (u: number, v: number): Pt2 => [u * ux - v * uy, u * uy + v * ux]
      best = [un(minU, minV), un(maxU, minV), un(maxU, maxV), un(minU, maxV)]
    }
  }
  return best ?? poly
}

/**
 * A bounding rectangle in the plane whose edges are LEVEL, returned in world space.
 *
 * `minAreaRect` finds the tightest rectangle, but in an arbitrary in-plane basis — so on a
 * tilted surface it usually comes out diagonal, with no horizontal edge. ArrayCalc's quad
 * frame requires two level edges, so such a rectangle cannot be written as a quad and gets
 * split into two triangles. On a raked seating deck that is both wasteful and wrong-looking.
 *
 * Aligning the rectangle to the plane's own horizontal direction fixes it by construction:
 * two edges run along the level line, the other two straight up the slope. That is also
 * exactly how a person would draw a seating block — width across, depth up the rake.
 *
 * Returns null for a horizontal plane, where every direction is level and `minAreaRect`
 * is already both tighter and canonical.
 */
export function levelAlignedRect(worldPts: Vec3[], normal: Vec3): Vec3[] | null {
  if (worldPts.length < 3) return null
  const n = normalize(normal)

  // The level direction in the plane: perpendicular to both the normal and vertical.
  const h = cross(n, { x: 0, y: 0, z: 1 })
  const hLen = len(h)
  // A near-horizontal plane has no distinguished level direction.
  if (hLen < 1e-6) return null
  const u = scale(h, 1 / hLen)
  const v = cross(n, u) // in-plane, up the slope

  const o = worldPts[0]
  let minU = Infinity
  let maxU = -Infinity
  let minV = Infinity
  let maxV = -Infinity
  for (const p of worldPts) {
    const d = sub(p, o)
    const a = dot(d, u)
    const b = dot(d, v)
    if (a < minU) minU = a
    if (a > maxU) maxU = a
    if (b < minV) minV = b
    if (b > maxV) maxV = b
  }

  const at = (a: number, b: number): Vec3 => add(o, add(scale(u, a), scale(v, b)))
  return [at(minU, minV), at(maxU, minV), at(maxU, maxV), at(minU, maxV)]
}

/** Monotone chain convex hull. */
export function convexHull(pts: Pt2[]): Pt2[] {
  if (pts.length < 3) return pts.slice()
  const s = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross2 = (o: Pt2, a: Pt2, b: Pt2) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: Pt2[] = []
  for (const p of s) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop()
    lower.push(p)
  }
  const upper: Pt2[] = []
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i]
    while (upper.length >= 2 && cross2(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}

/** A face ready to become a RoomObject: 3 or 4 points, in world space. */
export interface Face {
  points: Vec3[]
}

/**
 * Decompose a polygon (with optional holes) into triangles and quads.
 *
 * earcut does the triangulation, then adjacent triangles are greedily merged back into
 * quads wherever the union stays convex. Halving the object count matters: ArrayCalc's
 * venue list is a flat scrolling list a human has to work in.
 */
export function toFaces(outer: Pt2[], holes: Pt2[][], basis: Basis): Face[] {
  if (outer.length === 3 && holes.length === 0) {
    return [{ points: outer.map(([x, y]) => fromPlane2D(x, y, basis)) }]
  }
  if (outer.length === 4 && holes.length === 0) {
    return [{ points: outer.map(([x, y]) => fromPlane2D(x, y, basis)) }]
  }

  const flat: number[] = []
  const holeIndices: number[] = []
  for (const [x, y] of outer) flat.push(x, y)
  for (const h of holes) {
    holeIndices.push(flat.length / 2)
    for (const [x, y] of h) flat.push(x, y)
  }
  const verts: Pt2[] = []
  for (let i = 0; i < flat.length; i += 2) verts.push([flat[i], flat[i + 1]])

  const tris = earcut(flat, holeIndices, 2)
  const quads = mergeToQuads(tris, verts)
  return quads.map((poly) => ({ points: poly.map((i) => fromPlane2D(verts[i][0], verts[i][1], basis)) }))
}

/** Greedily fuse triangle pairs that share an edge into convex quads. */
function mergeToQuads(tris: number[], verts: Pt2[]): number[][] {
  const n = tris.length / 3
  const used = new Uint8Array(n)
  const edgeOwner = new Map<string, number>()
  const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`)
  const neighbours: Map<string, number[]> = new Map()
  for (let t = 0; t < n; t++) {
    for (let e = 0; e < 3; e++) {
      const k = key(tris[t * 3 + e], tris[t * 3 + ((e + 1) % 3)])
      const l = neighbours.get(k)
      if (l) l.push(t)
      else neighbours.set(k, [t])
      edgeOwner.set(k, t)
    }
  }

  const out: number[][] = []
  for (let t = 0; t < n; t++) {
    if (used[t]) continue
    const a = tris[t * 3]
    const b = tris[t * 3 + 1]
    const c = tris[t * 3 + 2]
    let merged = false

    for (const [p, q, r] of [
      [a, b, c],
      [b, c, a],
      [c, a, b],
    ]) {
      const cand = (neighbours.get(key(p, q)) ?? []).find((u) => u !== t && !used[u])
      if (cand === undefined) continue
      // The far corner of the neighbour: the one vertex it does not share with this edge.
      const far = [tris[cand * 3], tris[cand * 3 + 1], tris[cand * 3 + 2]].find(
        (v) => v !== p && v !== q,
      )
      if (far === undefined) continue
      const quad = [r, p, far, q]
      if (!isConvex(quad.map((i) => verts[i]))) continue
      used[t] = 1
      used[cand] = 1
      out.push(quad)
      merged = true
      break
    }

    if (!merged) {
      used[t] = 1
      out.push([a, b, c])
    }
  }
  return out
}

/** True when every turn of the polygon goes the same way and no edge is degenerate. */
export function isConvex(poly: Pt2[]): boolean {
  let sign = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const c = poly[(i + 2) % poly.length]
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
    if (Math.abs(z) < 1e-12) continue
    const s = z > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return sign !== 0
}
