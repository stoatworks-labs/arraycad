/**
 * ArrayCalc's canonical Shape=1 quad, and how to build one.
 *
 * THIS IS A HARD FORMAT REQUIREMENT, not a stylistic choice, and getting it wrong is
 * silent and destructive. An earlier version of this project wrote quads with the origin
 * at the centroid and the points spread symmetrically around it — the obvious encoding,
 * and one that round-trips perfectly through our own reader. ArrayCalc 12.8.2 imported
 * those quads and collapsed every one of them to ZERO DEPTH: a 4 x 3 m plane became a
 * 3 m line. It reported nothing except an unrelated warning about one object.
 *
 * The real form, confirmed on all 26 quads in the reference venue and by a round trip
 * through ArrayCalc:
 *
 *     origin   at the MIDPOINT OF THE NEAR EDGE, not the centroid
 *     rotation about Z only
 *     P1 = (0,      +wNear/2, 0)      P2 = (depth, +wFar/2, rise)
 *     P4 = (0,      -wNear/2, 0)      P3 = (depth, -wFar/2, rise)
 *
 * so a quad is a SYMMETRIC TRAPEZOID: near edge and far edge both LEVEL and parallel,
 * both bisected by the local X axis, with the far edge free to sit at a different height.
 * `rise` is where the tilt lives — and `depth` may be ZERO, which is precisely how
 * ArrayCalc stores a vertical plane. Every rail front in the reference venue is a quad
 * with depth 0 and a negative rise.
 *
 * So most planes are expressible: horizontal, vertical, and raked. What is NOT is a
 * sheared parallelogram, an asymmetric trapezoid, or a quad with no level edge at all.
 * `canonicalQuad` returns null for those and the caller emits two triangles instead —
 * triangles have no such constraint, and ArrayCalc returned every one of ours
 * byte-identical.
 */

import type { Vec3 } from './types.ts'

export interface CanonicalQuad {
  origin: Vec3
  /** Degrees about Z. ArrayCalc quads in the reference venue never rotate about X or Y. */
  rotationZ: number
  /** P1..P4 in ArrayCalc's order and winding. */
  points: [Vec3, Vec3, Vec3, Vec3]
}

const EPS = 1e-6

/**
 * Express four world-space points as a canonical ArrayCalc quad, or return null.
 *
 * Tries all four rotations of the ring in both directions, because the caller's winding
 * is arbitrary and only one alignment will satisfy ArrayCalc's convention.
 */
export function canonicalQuad(pts: Vec3[], tolerance = 1e-4): CanonicalQuad | null {
  if (pts.length !== 4) return null

  const found: CanonicalQuad[] = []
  for (const ring of [pts, [...pts].reverse()]) {
    for (let r = 0; r < 4; r++) {
      // P1..P4 with the near edge P4->P1 and the far edge P2->P3.
      const got = tryCanonical(ring[r], ring[(r + 1) % 4], ring[(r + 2) % 4], ring[(r + 3) % 4], tolerance)
      if (got) found.push(got)
    }
  }
  if (found.length === 0) return null

  // Prefer a non-negative depth. Both are geometrically identical, but ArrayCalc writes
  // depth >= 0 on all 26 quads in the reference venue, so matching it keeps our output
  // indistinguishable from theirs.
  return found.find((q) => q.points[1].x >= -EPS) ?? found[0]
}

function tryCanonical(p1: Vec3, p2: Vec3, p3: Vec3, p4: Vec3, tol: number): CanonicalQuad | null {
  // Both edges must be LEVEL. The local frame rotates about Z only, so the near and far
  // edges are always horizontal; the plane's tilt lives entirely in `rise`.
  if (Math.abs(p1.z - p4.z) > tol) return null
  if (Math.abs(p2.z - p3.z) > tol) return null

  // The near edge sets the local +Y axis; local +X is that turned -90 degrees.
  const e0x = p1.x - p4.x
  const e0y = p1.y - p4.y
  const wNear = Math.hypot(e0x, e0y)
  if (wNear < EPS) return null
  const yx = e0x / wNear
  const yy = e0y / wNear
  const xx = yy
  const xy = -yx

  // The far edge must be parallel to the near edge and point the same way, or the local
  // Y coordinates of P2/P3 could not simply be +/-wFar/2.
  const e1x = p2.x - p3.x
  const e1y = p2.y - p3.y
  const wFar = Math.hypot(e1x, e1y)
  if (wFar > EPS) {
    if (Math.abs(e1x * yy - e1y * yx) > tol) return null
    if (e1x * yx + e1y * yy < 0) return null
  }

  const m0x = (p1.x + p4.x) / 2
  const m0y = (p1.y + p4.y) / 2
  const m1x = (p2.x + p3.x) / 2
  const m1y = (p2.y + p3.y) / 2
  const dx = m1x - m0x
  const dy = m1y - m0y

  // The far edge must sit square in front of the near one, or the quad is sheared.
  if (Math.abs(dx * yx + dy * yy) > tol) return null

  const depth = dx * xx + dy * xy
  const rise = p2.z - p1.z
  // Depth may be ZERO: that is exactly how ArrayCalc stores a vertical plane, and the
  // reference venue's rail fronts are all depth 0 with a negative rise. Only a quad with
  // neither depth nor rise is degenerate.
  if (Math.abs(depth) < EPS && Math.abs(rise) < EPS) return null

  return {
    origin: { x: m0x, y: m0y, z: p1.z },
    rotationZ: (Math.atan2(xy, xx) * 180) / Math.PI,
    points: [
      { x: 0, y: wNear / 2, z: 0 },
      { x: depth, y: wFar / 2, z: rise },
      { x: depth, y: -wFar / 2, z: rise },
      { x: 0, y: -wNear / 2, z: 0 },
    ],
  }
}

/**
 * Split a quad into the two triangles ArrayCalc will accept unchanged.
 *
 * The fallback whenever `canonicalQuad` says no. Two objects instead of one is the price
 * of geometry that actually survives the import.
 */
export function quadToTriangles(pts: Vec3[]): [Vec3[], Vec3[]] {
  return [
    [pts[0], pts[1], pts[2]],
    [pts[0], pts[2], pts[3]],
  ]
}
