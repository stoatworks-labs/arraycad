/**
 * The third dimension a drawing does not have.
 *
 * A plan gives an outline and nothing else. Everything vertical is a number the user
 * types: the stalls floor at 0, the balcony front at 4.2, the orchestra pit at -2.1. So
 * every traced vertex carries its own height, and the only question is what surface those
 * heights describe.
 *
 * ## Why the default fits a plane
 *
 * ArrayCalc wants flat planes — that is the whole premise of this tool. Heights typed at
 * four corners of a raked block are *meant* to describe one flat rake, but four typed
 * numbers are only coplanar by luck: 0.0, 0.0, 2.4 and 2.5 describe a warped surface, and
 * a warped surface comes out of the planarizer as several objects with a seam down the
 * middle. Fitting a plane by least squares and putting every vertex on it gives the
 * surface the user meant, and reports how far anything had to move so a real step is not
 * quietly flattened.
 *
 * A genuinely stepped or dished surface is what `free` mode is for; it is honest about
 * costing several ArrayCalc objects.
 */

/**
 * A least-squares plane written as z = a*x + b*y + c.
 *
 * The z-explicit form, not a general plane: a surface traced from a plan is a floor, a
 * deck or a ceiling, never a vertical wall, so it always has one height per xy and this
 * form cannot represent the case that would break it.
 */
export interface HeightPlane {
  a: number
  b: number
  c: number
  /**
   * The vertices were collinear in plan (or there were fewer than three), so no unique
   * plane exists. `a` and `b` are zero and `c` is the mean height — a level surface, which
   * is the only defensible answer.
   */
  degenerate: boolean
}

export interface HeightFit extends HeightPlane {
  /** Largest distance, in metres, any vertex had to move vertically to reach the plane. */
  maxResidual: number
  meanResidual: number
}

export interface PlanPoint {
  x: number
  y: number
  z: number
}

/** Solve the 3x3 normal equations for z = a*x + b*y + c. */
export function fitHeightPlane(pts: PlanPoint[]): HeightFit {
  const n = pts.length
  const meanZ = n === 0 ? 0 : pts.reduce((s, p) => s + p.z, 0) / n
  const flat = (): HeightFit => ({
    a: 0,
    b: 0,
    c: meanZ,
    degenerate: true,
    maxResidual: n === 0 ? 0 : Math.max(...pts.map((p) => Math.abs(p.z - meanZ))),
    meanResidual: n === 0 ? 0 : pts.reduce((s, p) => s + Math.abs(p.z - meanZ), 0) / n,
  })
  if (n < 3) return flat()

  // Centre on the centroid before accumulating. A venue traced 300 m from the origin makes
  // Sxx ~ 1e5 * n while Sxy - Sx*Sy/n is the small difference of large numbers; centring
  // keeps the system conditioned.
  const cx = pts.reduce((s, p) => s + p.x, 0) / n
  const cy = pts.reduce((s, p) => s + p.y, 0) / n

  let sxx = 0
  let sxy = 0
  let syy = 0
  let sxz = 0
  let syz = 0
  for (const p of pts) {
    const dx = p.x - cx
    const dy = p.y - cy
    const dz = p.z - meanZ
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
    sxz += dx * dz
    syz += dy * dz
  }

  const det = sxx * syy - sxy * sxy
  // Scale-aware: a 0.1 m wide region is not degenerate just because its moments are small.
  const scale = Math.max(sxx, syy, 1e-12)
  if (Math.abs(det) < 1e-9 * scale * scale) return flat()

  const a = (sxz * syy - syz * sxy) / det
  const b = (syz * sxx - sxz * sxy) / det
  const c = meanZ - a * cx - b * cy

  let maxResidual = 0
  let sum = 0
  for (const p of pts) {
    const r = Math.abs(p.z - (a * p.x + b * p.y + c))
    if (r > maxResidual) maxResidual = r
    sum += r
  }
  return { a, b, c, degenerate: false, maxResidual, meanResidual: sum / n }
}

export const heightAt = (pl: HeightPlane, x: number, y: number): number => pl.a * x + pl.b * y + pl.c

/**
 * The slope of a fitted plane, for the UI.
 *
 * `gradient` is rise over run in the steepest direction; `directionDeg` is the compass
 * bearing of uphill, measured anticlockwise from venue +X, which is the direction the
 * audience faces. A rake is normally quoted as 1:n, so `oneIn` is given too.
 */
export function slopeOf(pl: HeightPlane): { gradient: number; oneIn: number; directionDeg: number } {
  const gradient = Math.hypot(pl.a, pl.b)
  return {
    gradient,
    oneIn: gradient > 1e-9 ? 1 / gradient : Infinity,
    directionDeg: gradient > 1e-9 ? (Math.atan2(pl.b, pl.a) * 180) / Math.PI : 0,
  }
}

/**
 * Heights for a linear ramp between two anchor vertices.
 *
 * Pick the front row and the back row, give each a height, and every other vertex takes
 * the height its position along that axis implies. Deliberately NOT clamped at the
 * anchors: a vertex past the back row is further up the same rake, not level with it, and
 * clamping puts a flat lip on the back of every seating block.
 *
 * Returns unchanged heights if the two anchors are the same point.
 */
export function rampHeights(
  pts: { x: number; y: number }[],
  fromIndex: number,
  toIndex: number,
  zFrom: number,
  zTo: number,
): number[] {
  const a = pts[fromIndex]
  const b = pts[toIndex]
  if (!a || !b) return pts.map(() => zFrom)
  const vx = b.x - a.x
  const vy = b.y - a.y
  const l2 = vx * vx + vy * vy
  if (l2 < 1e-12) return pts.map(() => zFrom)
  return pts.map((p) => {
    const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / l2
    return zFrom + t * (zTo - zFrom)
  })
}
