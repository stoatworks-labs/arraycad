/**
 * Loose drawing segments -> closed rings.
 *
 * A venue plan is almost never drawn as closed polylines. The room walls, the seating
 * block boundaries and the balcony fronts arrive as hundreds of separate LINE and ARC
 * entities that only *look* like closed shapes because their endpoints coincide on the
 * page. Nothing downstream can use that — a plane needs a ring, and an entity list has
 * none — so a plan drawing imports as nothing at all unless the rings are recovered here.
 *
 * The method: weld endpoints into shared nodes, then walk the segment graph. Where more
 * than one unused segment leaves a node, the walk takes the straightest continuation,
 * which is what keeps a wall running past the row divider that tees into it rather than
 * turning up the divider and closing a ring that is not in the drawing.
 *
 * This is deliberately independent of DXF: DWG hands over exactly the same problem.
 */

import type { Vec3 } from '../geom/vec.ts'
import { cross, dot, len, normalize, sub, v3 } from '../geom/vec.ts'

export interface ChainOptions {
  /**
   * SOURCE UNITS. Endpoints this close are treated as the same node. Drawings are drawn
   * to snap, but exports round, so exact coincidence cannot be relied on.
   */
  tolerance: number
  /** Rings with fewer than this many distinct corners are discarded. */
  minCorners: number
}

export const DEFAULT_CHAIN_OPTIONS: ChainOptions = { tolerance: 1e-6, minCorners: 3 }

export interface ChainResult {
  /** Recovered closed rings, first point not repeated at the end. */
  loops: Vec3[][]
  /** Everything left over: paths that never closed. */
  open: Vec3[][]
}

/**
 * Spatial index that fuses endpoints onto a grid of `tol`.
 *
 * The 3x3x3 neighbour probe is not optional. Two endpoints 0.1 mm apart still land in
 * different cells whenever they straddle a cell boundary, and a plain quantised-key hash
 * then leaves exactly the hairline breaks it was meant to close — breaks that stop a wall
 * ring from ever closing, which is indistinguishable from the drawing being open.
 */
class NodeIndex {
  private grid = new Map<string, number[]>()
  readonly points: Vec3[] = []

  constructor(private readonly tol: number) {}

  private key(i: number, j: number, k: number): string {
    return `${i},${j},${k}`
  }

  private hit(gi: number, gj: number, gk: number, p: Vec3): number {
    const bucket = this.grid.get(this.key(gi, gj, gk))
    if (!bucket) return -1
    for (const vi of bucket) {
      const q = this.points[vi]
      if (
        Math.abs(q.x - p.x) <= this.tol &&
        Math.abs(q.y - p.y) <= this.tol &&
        Math.abs(q.z - p.z) <= this.tol
      ) {
        return vi
      }
    }
    return -1
  }

  add(p: Vec3): number {
    const inv = 1 / Math.max(this.tol, 1e-12)
    const gi = Math.round(p.x * inv)
    const gj = Math.round(p.y * inv)
    const gk = Math.round(p.z * inv)

    const home = this.hit(gi, gj, gk, p)
    if (home !== -1) return home
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let dk = -1; dk <= 1; dk++) {
          if (di === 0 && dj === 0 && dk === 0) continue
          const found = this.hit(gi + di, gj + dj, gk + dk, p)
          if (found !== -1) return found
        }
      }
    }
    const idx = this.points.length
    this.points.push(p)
    const k = this.key(gi, gj, gk)
    const bucket = this.grid.get(k)
    if (bucket) bucket.push(idx)
    else this.grid.set(k, [idx])
    return idx
  }
}

interface Seg {
  pts: Vec3[]
  a: number
  b: number
  used: boolean
}

/**
 * Unit direction of travel on setting off into `pts` from whichever end `fromStart` picks.
 *
 * Entering at the far end means travelling back towards the first point, so the vector is
 * the reverse of the segment's own last step.
 */
function leavingDir(pts: Vec3[], fromStart: boolean): Vec3 {
  const [p, q] = fromStart ? [pts[0], pts[1]] : [pts[pts.length - 1], pts[pts.length - 2]]
  return normalize(sub(q, p))
}

/** Unit direction of travel on arriving at the end of `pts`, having walked it in order. */
function arrivalDir(pts: Vec3[]): Vec3 {
  return normalize(sub(pts[pts.length - 1], pts[pts.length - 2]))
}

/**
 * Chain open paths into closed rings.
 *
 * `paths` are polylines in source units — a LINE is two points, a tessellated ARC is
 * many. Already-closed shapes must NOT be passed in; fill those directly.
 */
export function chainSegments(
  paths: Vec3[][],
  options: Partial<ChainOptions> = {},
): ChainResult {
  const opts = { ...DEFAULT_CHAIN_OPTIONS, ...options }
  const index = new NodeIndex(opts.tolerance)
  const segs: Seg[] = []

  for (const pts of paths) {
    if (pts.length < 2) continue
    const a = index.add(pts[0])
    const b = index.add(pts[pts.length - 1])
    // A segment whose ends weld together is either a dot or a closed shape that should
    // have been filled directly. Either way it cannot contribute to a chain.
    if (a === b) continue
    segs.push({ pts, a, b, used: false })
  }

  const adj = new Map<number, number[]>()
  for (let i = 0; i < segs.length; i++) {
    for (const node of [segs[i].a, segs[i].b]) {
      const list = adj.get(node)
      if (list) list.push(i)
      else adj.set(node, [i])
    }
  }

  const loops: Vec3[][] = []
  const open: Vec3[][] = []

  /**
   * Walk away from `node`, consuming segments, until the trail runs out or reaches `stop`.
   *
   * `heading` is the direction of TRAVEL, so the straightest continuation is the candidate
   * most nearly parallel to it. Comparing against the segment's own outward-facing
   * direction instead reverses the test and makes the walk take the sharpest turn
   * available, which at a tee junction turns up the side branch and closes a ring that is
   * not in the drawing.
   *
   * Returns the points visited, not including the one already at `node`.
   */
  function walk(node: number, heading: Vec3, stop: number): { pts: Vec3[]; end: number } {
    const pts: Vec3[] = []
    let cur = node
    // Bounded by the segment count: every step consumes one segment permanently.
    for (;;) {
      if (cur === stop) break

      let best = -1
      let bestDot = -Infinity
      let bestForward = true
      for (const ci of adj.get(cur) ?? []) {
        const c = segs[ci]
        if (c.used) continue
        const forward = c.a === cur
        // A node can appear at both ends of the same segment only via a closed shape,
        // which is filtered above, so one orientation is always the right one.
        const d = leavingDir(c.pts, forward)
        const straightness = dot(heading, d)
        if (straightness > bestDot) {
          bestDot = straightness
          best = ci
          bestForward = forward
        }
      }
      if (best === -1) break

      const c = segs[best]
      c.used = true
      const ordered = bestForward ? c.pts : [...c.pts].reverse()
      // The shared endpoint is already the last point of the trail.
      for (let i = 1; i < ordered.length; i++) pts.push(ordered[i])
      heading = arrivalDir(ordered)
      cur = bestForward ? c.b : c.a
    }
    return { pts, end: cur }
  }

  for (let s = 0; s < segs.length; s++) {
    if (segs[s].used) continue

    const seed = segs[s]
    seed.used = true
    const forward = walk(seed.b, arrivalDir(seed.pts), seed.a)
    const chain = [...seed.pts, ...forward.pts]

    if (forward.end === seed.a) {
      const ring = dropRepeated(chain, opts.tolerance)
      if (ring.length >= opts.minCorners) loops.push(ring)
      else open.push(chain)
      continue
    }

    // The seed is rarely the end of its own chain. Without walking the other way too,
    // every segment behind it is stranded and reported as a separate unjoined path — and
    // when open paths are force-closed, a three-sided bay comes out as a triangle with
    // one of its walls missing rather than as the bay.
    const backward = walk(seed.a, normalize(sub(seed.pts[0], seed.pts[1])), forward.end)
    if (backward.pts.length === 0) {
      open.push(chain)
      continue
    }
    const joined = [...backward.pts.slice().reverse(), ...chain]
    if (backward.end === forward.end) {
      const ring = dropRepeated(joined, opts.tolerance)
      if (ring.length >= opts.minCorners) loops.push(ring)
      else open.push(joined)
    } else {
      open.push(joined)
    }
  }

  return { loops, open }
}

/** Remove consecutive duplicates, including a final point equal to the first. */
function dropRepeated(pts: Vec3[], tol: number): Vec3[] {
  const out: Vec3[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (last && len(sub(last, p)) <= tol) continue
    out.push(p)
  }
  while (out.length > 1 && len(sub(out[0], out[out.length - 1])) <= tol) out.pop()
  return out
}

/**
 * Best-fit normal of a 3D ring, by Newell's method.
 *
 * Newell rather than a cross product of the first three points: a traced ring routinely
 * starts with three nearly collinear corners, and a cross product there is numerical
 * noise pointing anywhere.
 */
export function newellNormal(ring: Vec3[]): Vec3 {
  let x = 0
  let y = 0
  let z = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]
    const b = ring[i]
    x += (a.y - b.y) * (a.z + b.z)
    y += (a.z - b.z) * (a.x + b.x)
    z += (a.x - b.x) * (a.y + b.y)
  }
  return v3(x / 2, y / 2, z / 2)
}

/** Area of a planar ring in 3D, from the Newell vector. */
export const ringArea = (ring: Vec3[]): number => len(newellNormal(ring))

/** How far the ring's corners stray from its own best-fit plane. */
export function ringFlatness(ring: Vec3[]): number {
  const n = normalize(newellNormal(ring))
  if (len(n) === 0) return Infinity
  let worst = 0
  for (const p of ring) worst = Math.max(worst, Math.abs(dot(sub(p, ring[0]), n)))
  return worst
}

/** True when a ring doubles back through itself, as a bow tie does. */
export function isSelfIntersecting(ring: Vec3[]): boolean {
  const n = normalize(newellNormal(ring))
  if (len(n) === 0) return true
  const seed = Math.abs(n.x) <= Math.abs(n.y) && Math.abs(n.x) <= Math.abs(n.z)
    ? v3(1, 0, 0)
    : Math.abs(n.y) <= Math.abs(n.z)
      ? v3(0, 1, 0)
      : v3(0, 0, 1)
  const u = normalize(cross(seed, n))
  const v = cross(n, u)
  const flat = ring.map((p) => {
    const d = sub(p, ring[0])
    return [dot(d, u), dot(d, v)] as [number, number]
  })

  const m = flat.length
  for (let i = 0; i < m; i++) {
    const a1 = flat[i]
    const a2 = flat[(i + 1) % m]
    for (let j = i + 1; j < m; j++) {
      // Skip the shared-corner neighbours; they always "touch".
      if (j === i || (j + 1) % m === i || j === (i + 1) % m) continue
      if (properlyIntersect(a1, a2, flat[j], flat[(j + 1) % m])) return true
    }
  }
  return false
}

type P2 = [number, number]

const orient = (a: P2, b: P2, c: P2): number =>
  (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

function properlyIntersect(a1: P2, a2: P2, b1: P2, b2: P2): boolean {
  const d1 = orient(a1, a2, b1)
  const d2 = orient(a1, a2, b2)
  const d3 = orient(b1, b2, a1)
  const d4 = orient(b1, b2, a2)
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))
}
