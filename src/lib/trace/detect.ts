/**
 * Finding geometry in a drawing.
 *
 * Two jobs, both working on the ink mask from raster.ts:
 *
 * 1. **Select a region.** Click inside a room and get its outline. A flood fill over the
 *    paper pixels finds the enclosed area; its boundary is then recovered exactly and
 *    simplified. This is the one operation that turns "here is a picture of a plan" into
 *    "here is the shape of the stalls" without anyone tracing a hundred corners by hand.
 *
 * 2. **Detect outlines to snap to.** The same boundary walk run over the ink itself gives
 *    every drawn line's edge, so a hand-traced corner lands exactly on the wall rather
 *    than three pixels off it.
 *
 * ## How the boundary is recovered
 *
 * The same trick polygon.ts uses on triangles. Every filled pixel contributes its four
 * unit edges, directed so the pixel is always on the same side; two adjacent filled pixels
 * traverse their shared edge once in each direction, so it cancels. What is left, chained
 * end to end, is exactly the boundary — outer loop plus one loop per hole, on pixel
 * CORNERS rather than pixel centres, so a one-pixel-wide feature has a real outline
 * instead of a degenerate spike.
 *
 * Only pixels with an empty neighbour are examined, so the cost is the perimeter, not the
 * area. That matters: the alternative walks 12 million edges on an A1 sheet.
 */

import { type Pt2, dpChain, dropCollinear, pointInRing } from '../geom/polygon.ts'
import { signedArea2 } from '../geom/vec.ts'
import type { DetectedPath, Px } from './types.ts'
import type { Mask } from './raster.ts'

export interface RegionHit {
  /** Outer outline, pixel corners, simplified. */
  outline: Px[]
  /** Holes: columns, voids, anything enclosed inside the region. Largest first. */
  holes: Px[][]
  /** Filled area in square pixels, before simplification. */
  areaPx: number
  /**
   * The fill reached the edge of the sheet, so the area was not enclosed by drawn lines.
   * Almost always means ink is broken somewhere and the fill leaked out of the room.
   */
  touchedBorder: boolean
  /** Fraction of the whole sheet the fill covered. Another leak symptom. */
  coverage: number
}

export interface FloodOptions {
  /** Douglas-Peucker tolerance on the recovered outline, in pixels. */
  simplifyPx: number
  /** Give up once the fill exceeds this fraction of the sheet — it has clearly leaked. */
  maxCoverage: number
}

export const DEFAULT_FLOOD: FloodOptions = { simplifyPx: 2, maxCoverage: 0.9 }

/**
 * Flood fill the paper area containing `seed` and return its outline.
 *
 * 4-connected, scanline, so a diagonal hairline still separates two rooms — 8-connectivity
 * on the paper would let the fill squeeze diagonally between two ink pixels that a person
 * reads as a continuous wall.
 *
 * Returns null if the seed is on ink, or if the fill ran away.
 */
export function floodRegion(mask: Mask, seed: Px, opts: FloodOptions = DEFAULT_FLOOD): RegionHit | null {
  const { width: w, height: h } = mask
  const sx = Math.floor(seed[0])
  const sy = Math.floor(seed[1])
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null
  if (mask.data[sy * w + sx] !== 0) return null

  const filled = new Uint8Array(w * h)
  const limit = Math.floor(w * h * opts.maxCoverage)
  let count = 0
  let touchedBorder = false

  // Scanline fill: push spans, not pixels. A 6 megapixel sheet has ~4 million paper
  // pixels; a per-pixel stack of that size is both slow and a memory spike.
  const stack: number[] = [sx, sy]
  while (stack.length) {
    const y = stack.pop()!
    let x = stack.pop()!
    const row = y * w
    if (filled[row + x] || mask.data[row + x]) continue

    let x0 = x
    while (x0 > 0 && !filled[row + x0 - 1] && !mask.data[row + x0 - 1]) x0--
    let x1 = x
    while (x1 < w - 1 && !filled[row + x1 + 1] && !mask.data[row + x1 + 1]) x1++

    if (x0 === 0 || x1 === w - 1 || y === 0 || y === h - 1) touchedBorder = true

    for (x = x0; x <= x1; x++) {
      filled[row + x] = 1
      count++
    }
    if (count > limit) {
      return {
        outline: [],
        holes: [],
        areaPx: count,
        touchedBorder: true,
        coverage: count / (w * h),
      }
    }

    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= h) continue
      const nrow = ny * w
      let inSpan = false
      for (x = x0; x <= x1; x++) {
        const open = !filled[nrow + x] && !mask.data[nrow + x]
        if (open && !inSpan) {
          stack.push(x, ny)
          inSpan = true
        } else if (!open) {
          inSpan = false
        }
      }
    }
  }

  const loops = boundaryLoops(filled, w, h)
  if (loops.length === 0) return null
  const simplified = loops.map((l) => simplifyLoop(l, opts.simplifyPx)).filter((l) => l.length >= 3)
  if (simplified.length === 0) return null

  return {
    outline: simplified[0],
    holes: simplified.slice(1),
    areaPx: count,
    touchedBorder,
    coverage: count / (w * h),
  }
}

export interface ContourOptions {
  simplifyPx: number
  /** Drop loops shorter than this in pixels — speckle, text, dimension arrows. */
  minPerimeterPx: number
  /** Stop after this many points in total. A busy sheet can otherwise produce 200,000. */
  maxPoints: number
}

export const DEFAULT_CONTOURS: ContourOptions = {
  simplifyPx: 1.5,
  minPerimeterPx: 40,
  maxPoints: 30000,
}

/**
 * Every ink outline on the sheet, simplified, for snapping.
 *
 * These are the *edges* of the drawn lines, not their centrelines: a wall drawn as two
 * parallel strokes gives four loops. That is the right answer for snapping — the user is
 * aiming at something they can see — and recovering centrelines would mean skeletonising,
 * which is slow and fragile on dashed and hatched line work.
 */
export function traceContours(mask: Mask, opts: ContourOptions = DEFAULT_CONTOURS): DetectedPath[] {
  const loops = boundaryLoops(mask.data, mask.width, mask.height)
  const out: DetectedPath[] = []
  let points = 0
  for (const loop of loops) {
    if (loop.length < opts.minPerimeterPx) continue
    const simple = simplifyLoop(loop, opts.simplifyPx)
    if (simple.length < 3) continue
    out.push({ points: simple, closed: true })
    points += simple.length
    if (points >= opts.maxPoints) break
  }
  return out
}

/**
 * Boundary loops of a binary image, on pixel corners, largest absolute area first.
 *
 * `filled` is row-major, non-zero meaning inside. Loops come back in the winding that puts
 * the filled side on the right in image coordinates, so the outer loop has a positive
 * shoelace area and holes have a negative one.
 */
export function boundaryLoops(filled: Uint8Array, w: number, h: number): Px[][] {
  const cw = w + 1
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : filled[y * w + x])

  // Directed corner-to-corner edges. Key by start corner; a corner where two loops pinch
  // together has two outgoing edges, so the value is a list.
  const next = new Map<number, number[]>()
  const push = (ax: number, ay: number, bx: number, by: number) => {
    const a = ay * cw + ax
    const b = by * cw + bx
    const l = next.get(a)
    if (l) l.push(b)
    else next.set(a, [b])
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!filled[y * w + x]) continue
      // Clockwise round the pixel in image coordinates (x right, y down): top, right,
      // bottom, left. Only edges facing empty space survive, which is the boundary.
      if (!at(x, y - 1)) push(x, y, x + 1, y)
      if (!at(x + 1, y)) push(x + 1, y, x + 1, y + 1)
      if (!at(x, y + 1)) push(x + 1, y + 1, x, y + 1)
      if (!at(x - 1, y)) push(x, y + 1, x, y)
    }
  }

  const loops: Px[][] = []
  while (next.size) {
    const start = next.keys().next().value as number
    const loop: Px[] = []
    let cur = start
    for (let guard = 0; guard < 1e7; guard++) {
      const outs = next.get(cur)
      if (!outs || outs.length === 0) break
      const nxt = outs.pop()!
      if (outs.length === 0) next.delete(cur)
      loop.push([cur % cw, Math.floor(cur / cw)])
      cur = nxt
      if (cur === start) break
    }
    if (loop.length >= 4) loops.push(loop)
  }

  return loops.sort((a, b) => Math.abs(signedArea2(b)) - Math.abs(signedArea2(a)))
}

/**
 * Simplify a closed pixel loop.
 *
 * Douglas-Peucker on a ring anchored at an arbitrary vertex will shave off the far side of
 * the ring, so it is split first. polygon.ts splits at the two most distant vertices,
 * which is an O(n^2) scan — fine for a 40-vertex CAD outline, hopeless for a raster
 * boundary with 20,000 corners. The extreme-x pair is a good enough approximation and is
 * one linear pass.
 */
export function simplifyLoop(loop: Px[], tol: number): Px[] {
  if (loop.length <= 4) return loop
  let lo = 0
  let hi = 0
  for (let i = 1; i < loop.length; i++) {
    if (loop[i][0] < loop[lo][0]) lo = i
    if (loop[i][0] > loop[hi][0]) hi = i
  }
  if (lo === hi) return loop
  const [a, b] = lo < hi ? [lo, hi] : [hi, lo]
  const chainA = loop.slice(a, b + 1) as Pt2[]
  const chainB = [...loop.slice(b), ...loop.slice(0, a + 1)] as Pt2[]
  const sa = dpChain(chainA, tol)
  const sb = dpChain(chainB, tol)
  const merged = [...sa.slice(0, -1), ...sb.slice(0, -1)] as Px[]
  const cleaned = dropCollinear(merged as Pt2[], tol) as Px[]
  return cleaned.length >= 3 ? cleaned : (merged.length >= 3 ? merged : loop)
}

// ------------------------------------------------------------------ snapping

export type SnapKind = 'vertex' | 'edge' | 'none'

export interface SnapResult {
  point: Px
  kind: SnapKind
}

/**
 * A grid-bucketed index over detected geometry, for snapping a cursor to it.
 *
 * A corner wins over a line: a user aiming near the junction of two walls means the
 * junction, and landing 2 px down one of them leaves a sliver that survives all the way
 * into the venue file.
 */
export class SnapIndex {
  private cell: number
  private buckets = new Map<number, number[]>()
  private segs: [Px, Px][] = []

  constructor(paths: DetectedPath[], cell = 48) {
    this.cell = Math.max(4, cell)
    for (const path of paths) {
      const n = path.points.length
      const last = path.closed ? n : n - 1
      for (let i = 0; i < last; i++) {
        const a = path.points[i]
        const b = path.points[(i + 1) % n]
        const idx = this.segs.push([a, b]) - 1
        this.addToCells(a, b, idx)
      }
    }
  }

  get segmentCount(): number {
    return this.segs.length
  }

  private key(cx: number, cy: number): number {
    // Cantor-ish pairing on a 1e6 stride: cell coordinates never approach that on any
    // sheet a browser can rasterise, and it keeps the key a plain integer.
    return cx * 1000003 + cy
  }

  private addToCells(a: Px, b: Px, idx: number) {
    const c = this.cell
    const x0 = Math.floor(Math.min(a[0], b[0]) / c)
    const x1 = Math.floor(Math.max(a[0], b[0]) / c)
    const y0 = Math.floor(Math.min(a[1], b[1]) / c)
    const y1 = Math.floor(Math.max(a[1], b[1]) / c)
    // A long segment spans many cells; bounding-box registration over-reports but never
    // misses, and the candidate is distance-tested anyway.
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = this.key(x, y)
        const l = this.buckets.get(k)
        if (l) l.push(idx)
        else this.buckets.set(k, [idx])
      }
    }
  }

  private candidates(p: Px, radius: number): number[] {
    const c = this.cell
    const x0 = Math.floor((p[0] - radius) / c)
    const x1 = Math.floor((p[0] + radius) / c)
    const y0 = Math.floor((p[1] - radius) / c)
    const y1 = Math.floor((p[1] + radius) / c)
    const out = new Set<number>()
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        for (const i of this.buckets.get(this.key(x, y)) ?? []) out.add(i)
      }
    }
    return [...out]
  }

  snap(p: Px, radius: number): SnapResult {
    let bestVertex: Px | null = null
    let bestVertexD = radius
    let bestEdge: Px | null = null
    let bestEdgeD = radius

    for (const i of this.candidates(p, radius)) {
      const [a, b] = this.segs[i]
      for (const v of [a, b]) {
        const d = Math.hypot(v[0] - p[0], v[1] - p[1])
        if (d < bestVertexD) {
          bestVertexD = d
          bestVertex = v
        }
      }
      const q = closestOnSegment(p, a, b)
      const d = Math.hypot(q[0] - p[0], q[1] - p[1])
      if (d < bestEdgeD) {
        bestEdgeD = d
        bestEdge = q
      }
    }

    if (bestVertex) return { point: [bestVertex[0], bestVertex[1]], kind: 'vertex' }
    if (bestEdge) return { point: bestEdge, kind: 'edge' }
    return { point: p, kind: 'none' }
  }
}

export function closestOnSegment(p: Px, a: Px, b: Px): Px {
  const vx = b[0] - a[0]
  const vy = b[1] - a[1]
  const l2 = vx * vx + vy * vy
  if (l2 < 1e-12) return [a[0], a[1]]
  let t = ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return [a[0] + t * vx, a[1] + t * vy]
}

/** Even-odd point-in-polygon, for hit-testing a traced region. The test itself is in
 *  `geom/polygon.ts`, because a rationalisation clips its capture with the same one. */
export const pointInPolygon = (p: Px, poly: Px[]): boolean => pointInRing(p, poly)

/** Shoelace area of a pixel polygon, in square pixels. Always positive. */
export function polygonAreaPx(poly: Px[]): number {
  return Math.abs(signedArea2(poly as Pt2[])) / 2
}
