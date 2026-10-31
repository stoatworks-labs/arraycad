/**
 * A one-piece model -> the parts a venue is made of.
 *
 * Everything else in `prepare/` reads the model's NAMES, and the repetition between its
 * objects. A model that arrives as one mesh has neither: an OBJ out of Blender, a media
 * server's stock theatre, an STL. Its floor, its walls, its ceiling and every row of its
 * seating are one node, so there is nothing to prune by, nothing to type, and nothing to
 * flatten. disguise's stock theatre came out as 1,041 ArrayCalc objects, all of them
 * listening planes; its arena as 8,152.
 *
 * Most of those objects are the seating. An auditorium is modelled as STEPS — a level tread
 * per row and a vertical riser in front of it — and the coplanar merge is right to report
 * every tread and every riser as a surface of its own. That is the case `rationalise.ts`
 * exists for, except that it has to be told which triangles are a rake, and here nothing
 * says so but the shape.
 *
 * So the shape is read, and the node is split into parts:
 *
 * - **Rakes.** Treads joined by risers. A tread is a level surface no deeper than a row; a
 *   riser is a vertical one no taller than a step. Treads that risers join are one flight,
 *   and a flight with enough rows is seating. Each becomes a node of its own, tagged so the
 *   plan flattens it into an audience plane.
 * - **Floor** and **Ceiling**: the other level and gently sloping surfaces, told apart by
 *   what is above and below them. See `levelKind`.
 * - **Walls**: everything steeper.
 *
 * The parts are NAMED with the words the vocabulary already knows, so the ordinary name
 * rules type them — walls and ceilings as obstacles, the floor left as a listening plane —
 * and the tree shows them as rows a person can switch off, instead of one.
 *
 * ## A rake is seldom ONE plane
 *
 * A stalls block is a fan of curved rows, and the bowl of an arena goes round all four
 * sides of the floor: neither has a single plane through it. A flight is fitted with one
 * plane, and if its treads sit further off that plane than steps of its own height can
 * explain, it is cut in two and each half tried again. That is what a designer does by
 * hand — a fan as three or four sectors, a bowl as its sides and its corners — and it
 * stops as soon as a plane will do. Cut on triangles rather than on rows, because a level
 * row is one coplanar region however far round the bowl it goes; long tread triangles are
 * bisected first so the cut can fall between them.
 *
 * ## Units and the transform
 *
 * The questions here are about the venue — which way is up, how tall is a step — so they
 * are asked of the geometry in venue space, `applyTransform` applied forwards once. The
 * parts are then cut from the SOURCE triangles by index: nothing is transformed back, which
 * would be a second copy of `applyTransform` (see the origin-picker rule in CLAUDE.md). A
 * bisected tread is bisected in both spaces at once; a midpoint is a midpoint under any
 * affine map.
 *
 * Like the rest of preparation it runs once, at import, under the units in force then, and
 * re-runs from the raw scene on request. The parts themselves are only subsets of the
 * model's triangles, so a later units change moves them with everything else.
 */

import type { ImportedNode, ImportedScene } from '../import/types.ts'
import { DEFAULT_PLANARIZE, type Region, type WeldedMesh, findCoplanarRegions, weld } from '../geom/planarize.ts'
import { smallestEigenvector } from '../geom/rationalise.ts'
import { type SurfaceKind, findScanRegions } from '../geom/scan.ts'
import { type TransformOptions, applyTransform } from '../geom/transform.ts'
import { type Vec3, triArea, v3 } from '../geom/vec.ts'
import { categorise } from './vocabulary.ts'

/** Stamped on a rake part, so the plan knows to flatten it. */
export const RAKE_TAG = 'shape:rake'

export interface SplitOptions {
  /** Below this many triangles a node is left whole: there is no room to find in it. */
  minTriangles: number
  /** Metres. The tallest step that is still a riser between two rows. */
  maxRiser: number
  /**
   * Metres. The deepest level surface that can still be a row, measured as twice its area
   * over its perimeter — a strip's depth, whatever its length or curve.
   */
  maxTreadDepth: number
  /** Distinct row heights before a flight of steps counts as seating, not a stair. */
  minRows: number
  /** m². A flight with less tread than this is a stair, and a sector smaller is not cut. */
  minRakeArea: number
  /** Metres. Bisect tread triangles longer than this, so a sector can be cut between them. */
  maxEdge: number
  /**
   * Metres. Clear height under a level surface that makes it a ceiling — if nothing above
   * it leaves standing room. See `levelKind`.
   */
  ceilingClearance: number
  /** Metres. Standing room: space above a level surface that makes it somewhere to be. */
  headroom: number
  /**
   * How the node's surfaces are found before any of the above is asked of them. A scan's
   * treads and risers are flat only to within its noise; see `geom/scan.ts`.
   */
  surface: SurfaceKind
}

export const DEFAULT_SPLIT: SplitOptions = {
  minTriangles: 50,
  // A stadium riser is 0.4-0.6 m; a balcony front, a stage edge or a vomitory wall is not.
  maxRiser: 0.65,
  // A row is 0.8-1.2 m deep. A cross-aisle at 1.5 m still joins; a landing or a stage does
  // not, which is what keeps a stage and its steps from reading as three rows of seating.
  maxTreadDepth: 1.6,
  minRows: 4,
  minRakeArea: 10,
  // Fine enough to cut a bowl at its corner, coarse enough not to multiply a stadium's
  // treads into a hundred thousand slivers.
  maxEdge: 3,
  // The clear height under a theatre balcony is often barely over two metres; a stage, a
  // step or a dais is never that high.
  ceilingClearance: 2,
  headroom: 1.8,
  surface: 'cad',
}

export interface SplitStats {
  /** One-piece objects that were split. */
  nodesSplit: number
  /** Parts made from them. */
  parts: number
  /** Of which rakes. */
  rakes: number
}

export const EMPTY_SPLIT: SplitStats = { nodesSplit: 0, parts: 0, rakes: 0 }

/** cos 10°: level enough to stand on, or to be a tread. */
const LEVEL = Math.cos((10 * Math.PI) / 180)
/** sin 15°: upright enough to be a riser. */
const UPRIGHT = Math.sin((15 * Math.PI) / 180)
/** cos 60°: anything steeper than this is a wall. The same 60° `rationalise` stops at. */
const WALL = 0.5

/** A triangle in both spaces at once: SOURCE to emit, VENUE to measure. */
interface Tri {
  src: number[]
  ven: number[]
}

const corner = (a: number[], k: number): Vec3 => v3(a[k * 3], a[k * 3 + 1], a[k * 3 + 2])
const area9 = (a: number[]) => triArea(corner(a, 0), corner(a, 1), corner(a, 2))
const venArea = (t: Tri) => area9(t.ven)
const centroid = (a: number[]): Vec3 =>
  v3((a[0] + a[3] + a[6]) / 3, (a[1] + a[4] + a[7]) / 3, (a[2] + a[5] + a[8]) / 3)

/** Face up, in venue space, so `rationalise`'s upward capture keeps it whichever way it was wound. */
function faceUp(t: Tri): Tri {
  const v = t.ven
  const nz = (v[3] - v[0]) * (v[7] - v[1]) - (v[4] - v[1]) * (v[6] - v[0])
  if (nz >= 0) return t
  const swap = (a: number[]) => [a[0], a[1], a[2], a[6], a[7], a[8], a[3], a[4], a[5]]
  return { src: swap(t.src), ven: swap(t.ven) }
}

/** Bisect a triangle along its longest edge until none is longer than `maxEdge` (venue metres). */
function bisect(t: Tri, maxEdge: number, out: Tri[]) {
  const stack = [t]
  const limit = maxEdge * maxEdge
  while (stack.length) {
    const tri = stack.pop()!
    const v = tri.ven
    const e = [0, 1, 2].map((k) => {
      const a = k * 3
      const b = ((k + 1) % 3) * 3
      return (v[a] - v[b]) ** 2 + (v[a + 1] - v[b + 1]) ** 2 + (v[a + 2] - v[b + 2]) ** 2
    })
    const k = e[0] >= e[1] && e[0] >= e[2] ? 0 : e[1] >= e[2] ? 1 : 2
    if (e[k] <= limit) {
      out.push(tri)
      continue
    }
    // Corners k and k+1 are the long edge, m its midpoint, o the corner opposite. Both
    // halves keep the original winding.
    const halves = (a: number[]) => {
      const i = k * 3
      const j = ((k + 1) % 3) * 3
      const o = ((k + 2) % 3) * 3
      const m = [(a[i] + a[j]) / 2, (a[i + 1] + a[j + 1]) / 2, (a[i + 2] + a[j + 2]) / 2]
      const p = (s: number) => [a[s], a[s + 1], a[s + 2]]
      return [
        [...p(i), ...m, ...p(o)],
        [...m, ...p(j), ...p(o)],
      ]
    }
    const s = halves(tri.src)
    const w = halves(tri.ven)
    stack.push({ src: s[0], ven: w[0] }, { src: s[1], ven: w[1] })
  }
}

/** What one coplanar region is, measured in venue space. */
interface RegionInfo {
  region: Region
  /** |normal.z|: 1 level, 0 upright. Sign-free, because CAD winding is not to be trusted. */
  level: number
  zMin: number
  zMax: number
  /** Metres: twice the area over the perimeter. A strip's depth. */
  depth: number
}

function describe(region: Region, mesh: WeldedMesh): RegionInfo {
  let zMin = Infinity
  let zMax = -Infinity
  const edges = new Map<string, number>()
  const ix = region.indices
  for (let i = 0; i < ix.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const z = mesh.vertices[ix[i + k]].z
      if (z < zMin) zMin = z
      if (z > zMax) zMax = z
      const a = ix[i + k]
      const b = ix[i + ((k + 1) % 3)]
      const key = a < b ? `${a}_${b}` : `${b}_${a}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }
  let perimeter = 0
  for (const [key, count] of edges) {
    if (count !== 1) continue
    const [a, b] = key.split('_').map(Number)
    const p = mesh.vertices[a]
    const q = mesh.vertices[b]
    perimeter += Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z)
  }
  return {
    region,
    level: Math.abs(region.plane.normal.z),
    zMin,
    zMax,
    depth: perimeter > 0 ? (2 * region.area) / perimeter : 0,
  }
}

/**
 * What is directly over and under a point: a plan grid over the surfaces that are not
 * walls, in venue metres.
 */
export class LevelIndex {
  private cells = new Map<string, number[][]>()
  private cell: number
  /** The lowest level anything reaches: the ground, where nothing else is modelled under a point. */
  private ground = Infinity
  /** The highest: a roof is up here, and an open landing is not. */
  top = -Infinity

  constructor(tris: number[][], cell = 2) {
    this.cell = cell
    for (const v of tris) {
      this.ground = Math.min(this.ground, v[2], v[5], v[8])
      this.top = Math.max(this.top, v[2], v[5], v[8])
      const x0 = Math.floor(Math.min(v[0], v[3], v[6]) / cell)
      const x1 = Math.floor(Math.max(v[0], v[3], v[6]) / cell)
      const y0 = Math.floor(Math.min(v[1], v[4], v[7]) / cell)
      const y1 = Math.floor(Math.max(v[1], v[4], v[7]) / cell)
      for (let i = x0; i <= x1; i++) {
        for (let j = y0; j <= y1; j++) {
          const k = `${i},${j}`
          const c = this.cells.get(k)
          if (c) c.push(v)
          else this.cells.set(k, [v])
        }
      }
    }
  }

  /**
   * Metres to the nearest surface above (x, y, z), Infinity if none, and below it.
   *
   * Where nothing is modelled underneath, the ground is: a model often leaves out what it
   * stands on — the d3 arena has no arena floor — and a roof twenty metres up is not a
   * floor because nobody drew the one under it. The ground itself, with nothing below,
   * comes out at no height above it, which is what keeps it a floor.
   */
  gaps(x: number, y: number, z: number): { above: number; below: number } {
    let above = Infinity
    let below = Infinity
    for (const v of this.cells.get(`${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`) ?? []) {
      // Barycentric in plan. A triangle that is a line in plan is a wall; skip it.
      const d = (v[4] - v[7]) * (v[0] - v[6]) + (v[6] - v[3]) * (v[1] - v[7])
      if (Math.abs(d) < 1e-12) continue
      const l1 = ((v[4] - v[7]) * (x - v[6]) + (v[6] - v[3]) * (y - v[7])) / d
      const l2 = ((v[7] - v[1]) * (x - v[6]) + (v[0] - v[6]) * (y - v[7])) / d
      const l3 = 1 - l1 - l2
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue
      const zz = l1 * v[2] + l2 * v[5] + l3 * v[8]
      // A 0.1 m band either side is the surface itself and its own coplanar neighbours.
      if (zz > z + 0.1) above = Math.min(above, zz - z)
      else if (zz < z - 0.1) below = Math.min(below, z - zz)
    }
    if (below === Infinity) below = Math.max(0, z - this.ground)
    return { above, below }
  }
}

/**
 * Floor or ceiling, for a level or gently sloping surface.
 *
 * Position decides first. Anything with no room under it is somewhere to stand — the
 * ground, the stage, every step of a stair — and only a surface with a room's height of
 * clear space under it can be a ceiling at all.
 *
 * Over a room, the WINDING decides, when the model has shown it can be trusted: `walkable`
 * is which way the model's own rows of seating face, +1 up or -1 down, and a surface facing
 * the other way is the underside of something — a ceiling, a balcony soffit, a roof seen
 * from inside. A roof seen from OUTSIDE faces the walkable way and has nothing over it, so
 * that is a ceiling too.
 *
 * With no seating to judge the winding by (`walkable` null), position alone: a ceiling has
 * no standing room over it, either nothing (a roof) or only something close (a ceiling
 * under its void). That gets a ceiling under a tall roof void wrong, and a soffit under a
 * raking balcony whose underside is flat — which is why the winding is preferred where it
 * can be had. The top landing of an unroofed grandstand comes out a ceiling either way: in
 * a prediction an obstacle, rather than a missing audience.
 *
 * Voted by area over the surface.
 */
export function levelKind(
  tris: number[][],
  index: LevelIndex,
  opts: Pick<SplitOptions, 'ceilingClearance' | 'headroom'> = DEFAULT_SPLIT,
  walkable: 1 | -1 | null = null,
): 'floor' | 'ceiling' {
  let ceiling = 0
  let total = 0
  // Sampled every couple of metres, not once per triangle. A ceiling drawn as two triangles
  // has two centroids, and one of them can easily sit over a corner of the plan nobody
  // modelled — which would then outvote the whole auditorium under the other.
  const area = tris.reduce((s, v) => s + area9(v), 0)
  const edge = Math.max(2, Math.sqrt((2 * area) / 4000))
  const samples: Tri[] = []
  for (const v of tris) bisect({ src: v, ven: v }, edge, samples)
  for (const s of samples) {
    const a = venArea(s)
    const c = centroid(s.ven)
    const { above, below } = index.gaps(c.x, c.y, c.z)
    total += a
    if (below < opts.ceilingClearance) continue
    // Nothing over it, up where the roof is. Not merely nothing over it: a media server's
    // stock theatre models no roof over its auditorium at all, and its circle landings
    // have nothing above them and an audience on them.
    const roof = above === Infinity && c.z >= index.top - ROOF_BAND
    if (walkable !== null) {
      const v = s.ven
      const nz = (v[3] - v[0]) * (v[7] - v[1]) - (v[4] - v[1]) * (v[6] - v[0])
      if (Math.sign(nz) === -walkable || roof) ceiling += a
    } else if (roof || above < opts.headroom) {
      ceiling += a
    }
  }
  return total > 0 && ceiling > total / 2 ? 'ceiling' : 'floor'
}

/** Metres below the highest point of the model that still count as its roof. */
const ROOF_BAND = 2

/**
 * Which way a model's walkable surfaces face, judged by its rows of seating: +1 if at
 * least nine-tenths of the tread area faces up, -1 if as much faces down (a model wound
 * inside out throughout), null if the treads disagree and winding says nothing.
 */
function walkableFacing(treads: Tri[]): 1 | -1 | null {
  let up = 0
  let total = 0
  for (const t of treads) {
    const v = t.ven
    const nz = (v[3] - v[0]) * (v[7] - v[1]) - (v[4] - v[1]) * (v[6] - v[0])
    const a = venArea(t)
    total += a
    if (nz > 0) up += a
  }
  if (total <= 0) return null
  if (up >= 0.9 * total) return 1
  if (up <= 0.1 * total) return -1
  return null
}

/** Weighted median of [value, weight] pairs. */
function weightedMedian(xs: [number, number][]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a[0] - b[0])
  const half = s.reduce((t, x) => t + x[1], 0) / 2
  let acc = 0
  for (const [v, w] of s) {
    acc += w
    if (acc >= half) return v
  }
  return s[s.length - 1][0]
}

/** A tread triangle reduced to what cutting needs: where it is, and how much of it there is. */
interface Pt {
  x: number
  y: number
  z: number
  w: number
}

const pointsOf = (tris: Tri[]): Pt[] =>
  tris.map((t) => {
    const c = centroid(t.ven)
    return { x: c.x, y: c.y, z: c.z, w: venArea(t) }
  })

/**
 * Two-means from a starting assignment, in plan with height scaled by `zWeight`. A few
 * rounds, deterministic: the same file cuts the same way every time.
 */
function twoMeans(pts: Pt[], start: number[], zWeight: number): number[] {
  let side = start
  for (let round = 0; round < 8; round++) {
    const means = [0, 1].map((s) => {
      let sx = 0
      let sy = 0
      let sz = 0
      let sw = 0
      pts.forEach((p, i) => {
        if (side[i] !== s) return
        sx += p.x * p.w
        sy += p.y * p.w
        sz += p.z * p.w
        sw += p.w
      })
      return sw > 0 ? { x: sx / sw, y: sy / sw, z: sz / sw } : null
    })
    const [m0, m1] = means
    if (!m0 || !m1) break
    const d = (p: Pt, m: { x: number; y: number; z: number }) =>
      (p.x - m.x) ** 2 + (p.y - m.y) ** 2 + (zWeight * (p.z - m.z)) ** 2
    const next = pts.map((p) => (d(p, m0) <= d(p, m1) ? 0 : 1))
    if (next.every((s, i) => s === side[i])) break
    side = next
  }
  return side
}

/**
 * The two ways a sector that does not fit one plane can be cut.
 *
 * ALONG the plan — at the area-weighted median of its longest plan axis, settled by
 * two-means — which takes a bowl's long side from its corner and a fan into narrower fans.
 * And ACROSS the fitted plane — the treads above it from the ones below, settled by
 * two-means with height counted heavily — which takes a tier from the tier overhanging it.
 * Where tiers are stacked in plan, as at the end of an arena with its upper tier over the
 * lower, no cut in plan can separate them, and cutting in plan anyway shreds both into
 * fragments the size of the minimum.
 */
function cuts(pts: Pt[], fitNormal: Vec3, fitPoint: Vec3): number[][] {
  const w = pts.reduce((s, p) => s + p.w, 0)
  const mx = pts.reduce((s, p) => s + p.x * p.w, 0) / w
  const my = pts.reduce((s, p) => s + p.y * p.w, 0) / w
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const p of pts) {
    sxx += p.w * (p.x - mx) ** 2
    sxy += p.w * (p.x - mx) * (p.y - my)
    syy += p.w * (p.y - my) ** 2
  }
  // Major axis of a 2x2 symmetric matrix, in closed form.
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const along = pts.map((p) => (p.x - mx) * Math.cos(angle) + (p.y - my) * Math.sin(angle))
  const median = weightedMedian(along.map((a, i) => [a, pts[i].w]))
  const inPlan = twoMeans(
    pts,
    along.map((a) => (a <= median ? 0 : 1)),
    0,
  )

  const off = pts.map(
    (p) => (p.x - fitPoint.x) * fitNormal.x + (p.y - fitPoint.y) * fitNormal.y + (p.z - fitPoint.z) * fitNormal.z,
  )
  const across = twoMeans(
    pts,
    off.map((o) => (o <= 0 ? 0 : 1)),
    4,
  )
  return [inPlan, across]
}

const areaOf = (tris: Tri[]) => tris.reduce((s, t) => s + venArea(t), 0)

/**
 * The area-weighted first and second moments of a set of triangles, about a fixed point.
 *
 * The same integral `rationalise.fitPlane` takes — each triangle's centroid plus its exact
 * second moment about it — kept as sums instead of a fit, because sums ADD. Asking whether
 * two sectors fit one plane together is then the addition of two records and one 3x3
 * eigenproblem, not a pass over every triangle of both; the merge below asks it of every
 * pair of neighbours, repeatedly. About a fixed reference point near the flight, for the
 * reason `fitPlane` centres: a venue far from its origin otherwise makes every moment a
 * small difference of large numbers.
 */
interface Moments {
  ref: Vec3
  w: number
  /** Σ area·(centroid − ref). */
  m: [number, number, number]
  /** Σ second moments about ref: xx, xy, xz, yy, yz, zz. */
  s: [number, number, number, number, number, number]
}

function momentsOf(tris: Tri[], ref: Vec3): Moments {
  const out: Moments = { ref, w: 0, m: [0, 0, 0], s: [0, 0, 0, 0, 0, 0] }
  for (const t of tris) {
    const v = t.ven
    const a = venArea(t)
    if (!(a > 0)) continue
    const c = centroid(v)
    const cx = c.x - ref.x
    const cy = c.y - ref.y
    const cz = c.z - ref.z
    out.w += a
    out.m[0] += a * cx
    out.m[1] += a * cy
    out.m[2] += a * cz
    const s = out.s
    s[0] += a * cx * cx
    s[1] += a * cx * cy
    s[2] += a * cx * cz
    s[3] += a * cy * cy
    s[4] += a * cy * cz
    s[5] += a * cz * cz
    const k = a / 12
    for (let i = 0; i < 9; i += 3) {
      const ex = v[i] - c.x
      const ey = v[i + 1] - c.y
      const ez = v[i + 2] - c.z
      s[0] += k * ex * ex
      s[1] += k * ex * ey
      s[2] += k * ex * ez
      s[3] += k * ey * ey
      s[4] += k * ey * ez
      s[5] += k * ez * ez
    }
  }
  return out
}

const addMoments = (a: Moments, b: Moments): Moments => ({
  ref: a.ref,
  w: a.w + b.w,
  m: [a.m[0] + b.m[0], a.m[1] + b.m[1], a.m[2] + b.m[2]],
  s: [a.s[0] + b.s[0], a.s[1] + b.s[1], a.s[2] + b.s[2], a.s[3] + b.s[3], a.s[4] + b.s[4], a.s[5] + b.s[5]],
})

/**
 * The least-squares plane through a set of triangles, and how far its surface sits off it
 * (area-weighted RMS). For a stepped rake that is the step's own spread; see `toleranceFor`.
 */
function planeOf(mo: Moments): { rms: number; normal: Vec3; point: Vec3 } {
  const w = mo.w
  if (!(w > 0)) return { rms: Infinity, normal: v3(0, 0, 1), point: mo.ref }
  const mx = mo.m[0] / w
  const my = mo.m[1] / w
  const mz = mo.m[2] / w
  const [sxx, sxy, sxz, syy, syz, szz] = mo.s
  const c = [
    [sxx / w - mx * mx, sxy / w - mx * my, sxz / w - mx * mz],
    [sxy / w - mx * my, syy / w - my * my, syz / w - my * mz],
    [sxz / w - mx * mz, syz / w - my * mz, szz / w - mz * mz],
  ]
  const n = smallestEigenvector(c)
  const nv = [n.x, n.y, n.z]
  let lambda = 0
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) lambda += nv[i] * c[i][j] * nv[j]
  return {
    rms: Math.sqrt(Math.max(lambda, 0)),
    normal: n,
    point: v3(mo.ref.x + mx, mo.ref.y + my, mo.ref.z + mz),
  }
}

/** How badly a set of sectors fits: their RMS residuals, weighted by area. */
function misfit(parts: Tri[][], ref: Vec3): number {
  let total = 0
  let w = 0
  for (const p of parts) {
    const mo = momentsOf(p, ref)
    total += planeOf(mo).rms * mo.w
    w += mo.w
  }
  return w > 0 ? total / w : Infinity
}

/**
 * A stepped rake never fits a plane exactly: its treads sit alternately above and below the
 * incline by up to half a step, which for an even spread is an RMS of about 0.29 of the step
 * height. A sector is accepted within that, plus a margin for curved rows.
 */
const toleranceFor = (step: number) => 0.3 * step + 0.06

/**
 * Cut a flight into sectors a plane fits.
 *
 * Beyond the tolerance a sector is cut, whichever of the two cuts fits better, and each
 * half tried again. One too small to halve is accepted as it is.
 */
function sectors(tris: Tri[], step: number, opts: SplitOptions, ref: Vec3, depth = 0): Tri[][] {
  const mo = momentsOf(tris, ref)
  const fit = planeOf(mo)
  if (fit.rms <= toleranceFor(step) || depth >= 8 || mo.w < 2 * opts.minRakeArea) return [tris]

  let best: [Tri[], Tri[]] | null = null
  let bestMisfit = Infinity
  for (const side of cuts(pointsOf(tris), fit.normal, fit.point)) {
    const a = tris.filter((_, i) => side[i] === 0)
    const b = tris.filter((_, i) => side[i] === 1)
    if (areaOf(a) < opts.minRakeArea || areaOf(b) < opts.minRakeArea) continue
    const m = misfit([a, b], ref)
    if (m < bestMisfit) {
      bestMisfit = m
      best = [a, b]
    }
  }
  if (!best) return [tris]
  return [...sectors(best[0], step, opts, ref, depth + 1), ...sectors(best[1], step, opts, ref, depth + 1)]
}

/**
 * A sector's treads in the pieces that actually join.
 *
 * Two-means cuts by where triangles are, not by what touches what, so one side of a cut
 * can hold two pieces with a gangway or a whole tier between them — and a sector in two
 * pieces is a plane covering the gap between them. Treads join where they share a corner
 * in plan at heights no more than a step apart: the back edge of one row and the front edge
 * of the next, either side of their riser.
 */
function pieces(tris: Tri[], maxRiser: number): Tri[][] {
  const parent = tris.map((_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const at = new Map<string, { t: number; z: number }[]>()
  tris.forEach((t, i) => {
    for (let k = 0; k < 9; k += 3) {
      const key = `${Math.round(t.ven[k] * 100)},${Math.round(t.ven[k + 1] * 100)}`
      const list = at.get(key)
      const e = { t: i, z: t.ven[k + 2] }
      if (list) list.push(e)
      else at.set(key, [e])
    }
  })
  for (const list of at.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        if (Math.abs(list[a].z - list[b].z) > maxRiser + 0.05) continue
        const ra = find(list[a].t)
        const rb = find(list[b].t)
        if (ra !== rb) parent[rb] = ra
      }
    }
  }
  const groups = new Map<number, Tri[]>()
  tris.forEach((t, i) => {
    const r = find(i)
    const g = groups.get(r)
    if (g) g.push(t)
    else groups.set(r, [t])
  })
  return [...groups.values()]
}

/**
 * Put back together what the cutting took apart unnecessarily.
 *
 * Cutting is greedy: it halves wherever the whole does not fit, and the halves of a bowl's
 * side and its corner can each carry a piece of the other. Two NEIGHBOURING sectors whose
 * union still fits one plane are one sector, so they are merged, best fit first, until no
 * pair qualifies. Neighbours are sectors with treads within a couple of metres of each
 * other — nothing across a gangway wider than that is joined.
 */
function mergeSectors(parts: Tri[][], step: number, ref: Vec3): Tri[][] {
  const tolerance = toleranceFor(step)
  const tris: (Tri[] | null)[] = parts.map((p) => [...p])
  const moments: (Moments | null)[] = parts.map((p) => momentsOf(p, ref))

  // Neighbours, once: sectors with treads in the same or touching 2 m cells.
  const cell = 2
  const byCell = new Map<string, Set<number>>()
  parts.forEach((p, s) => {
    for (const t of p) {
      const c = centroid(t.ven)
      const k = `${Math.floor(c.x / cell)},${Math.floor(c.y / cell)},${Math.floor(c.z / cell)}`
      const set = byCell.get(k)
      if (set) set.add(s)
      else byCell.set(k, new Set([s]))
    }
  })
  const adjacent = parts.map(() => new Set<number>())
  for (const [k, here] of byCell) {
    const [i, j, l] = k.split(',').map(Number)
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (let dl = -1; dl <= 1; dl++) {
          const there = byCell.get(`${i + di},${j + dj},${l + dl}`)
          if (!there) continue
          for (const a of here) for (const b of there) if (a !== b) adjacent[a].add(b)
        }
      }
    }
  }

  for (;;) {
    let best: [number, number] | null = null
    let bestRms = tolerance
    adjacent.forEach((ns, a) => {
      const ma = moments[a]
      if (!ma) return
      for (const b of ns) {
        const mb = moments[b]
        if (b <= a || !mb) continue
        const rms = planeOf(addMoments(ma, mb)).rms
        if (rms <= bestRms) {
          bestRms = rms
          best = [a, b]
        }
      }
    })
    if (!best) break
    const [a, b] = best as [number, number]
    tris[a] = [...tris[a]!, ...tris[b]!]
    moments[a] = addMoments(moments[a]!, moments[b]!)
    tris[b] = null
    moments[b] = null
    for (const n of adjacent[b]) {
      adjacent[n].delete(b)
      if (n !== a) {
        adjacent[n].add(a)
        adjacent[a].add(n)
      }
    }
    adjacent[a].delete(a)
    adjacent[b].clear()
  }
  return tris.filter((t): t is Tri[] => t !== null)
}

/** Which sector's treads are nearest a point in plan, or -1 if none is within 3 m. */
function nearestSector(cut: Tri[][], cell = 1): (p: Vec3) => number {
  const grid = new Map<string, { x: number; y: number; s: number }[]>()
  cut.forEach((ts, s) => {
    for (const t of ts) {
      const c = centroid(t.ven)
      const k = `${Math.floor(c.x / cell)},${Math.floor(c.y / cell)}`
      const e = { x: c.x, y: c.y, s }
      const g = grid.get(k)
      if (g) g.push(e)
      else grid.set(k, [e])
    }
  })
  return (p) => {
    const i = Math.floor(p.x / cell)
    const j = Math.floor(p.y / cell)
    let best = -1
    let bestD = Infinity
    for (let di = -3; di <= 3; di++) {
      for (let dj = -3; dj <= 3; dj++) {
        for (const e of grid.get(`${i + di},${j + dj}`) ?? []) {
          const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2
          if (d < bestD) {
            bestD = d
            best = e.s
          }
        }
      }
    }
    return best
  }
}

const tri9 = (p: ArrayLike<number>, t: number): number[] => {
  const o = t * 9
  return [p[o], p[o + 1], p[o + 2], p[o + 3], p[o + 4], p[o + 5], p[o + 6], p[o + 7], p[o + 8]]
}

/**
 * Split one node, or return null when it is not a one-piece model worth splitting.
 *
 * `rakes` counts the parts tagged as seating; the rest are at most a floor, a ceiling and
 * the walls.
 */
export function splitNode(
  node: ImportedNode,
  transform: TransformOptions,
  options: Partial<SplitOptions> = {},
): { parts: ImportedNode[]; rakes: number } | null {
  const opts = { ...DEFAULT_SPLIT, ...options }
  if (node.children.length > 0 || node.positions.length / 9 < opts.minTriangles) return null
  // A name that says what the object is wins. `SEATING - STALLS` and `WALLS` are already
  // understood, and splitting them would only second-guess the draughtsman.
  if (categorise(node.name, node.tags) !== null) return null

  const venue = applyTransform(node.positions, transform)
  // A plan drawn flat has no rake, no wall and no ceiling in it: one level, nothing to
  // separate. Said before the weld, which on a seating plan of 700,000 filled seat outlines
  // is most of fifteen seconds spent learning that.
  let zLo = Infinity
  let zHi = -Infinity
  for (let i = 2; i < venue.length; i += 3) {
    if (venue[i] < zLo) zLo = venue[i]
    if (venue[i] > zHi) zHi = venue[i]
  }
  if (!(zHi - zLo > 0.05)) return null

  const mesh = weld(venue, DEFAULT_PLANARIZE.weldTolerance)
  // Nothing may be dropped as too small: these are parts of a model, not its conversion.
  const regions =
    opts.surface === 'scan'
      ? findScanRegions(mesh, { ...DEFAULT_PLANARIZE, minArea: 0, surface: 'scan' }).regions
      : findCoplanarRegions(mesh, { ...DEFAULT_PLANARIZE, minArea: 0 })
  const info = regions.map((r) => describe(r, mesh))
  const sources = mesh.sources ?? []
  const srcTri = (t: number): Tri => ({ src: tri9(node.positions, sources[t]), ven: tri9(venue, sources[t]) })

  // Which regions touch which, through a shared welded edge.
  const byEdge = new Map<string, number[]>()
  info.forEach((ri, r) => {
    const ix = ri.region.indices
    for (let i = 0; i < ix.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const a = ix[i + k]
        const b = ix[i + ((k + 1) % 3)]
        const key = a < b ? `${a}_${b}` : `${b}_${a}`
        const list = byEdge.get(key)
        if (!list) byEdge.set(key, [r])
        else if (!list.includes(r)) list.push(r)
      }
    }
  })
  const neighbours = info.map(() => new Set<number>())
  for (const list of byEdge.values()) {
    for (const a of list) for (const b of list) if (a !== b) neighbours[a].add(b)
  }

  const isTread = (ri: RegionInfo) => ri.level >= LEVEL && ri.depth <= opts.maxTreadDepth
  // No real minimum on a riser. disguise's stock theatre rakes its stalls 30 mm a row, and a
  // shallow rake is still a rake. What keeps a slab's 20 mm edge from joining its top to its
  // underside is the tread test — a slab is not a row deep — and the count of rows.
  const isRiser = (ri: RegionInfo) => {
    const h = ri.zMax - ri.zMin
    return ri.level <= UPRIGHT && h >= 0.01 && h <= opts.maxRiser
  }

  // Flights: treads that a riser joins.
  const parent = info.map((_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  info.forEach((ri, r) => {
    if (!isRiser(ri)) return
    const treads = [...neighbours[r]].filter((n) => isTread(info[n]))
    for (let i = 1; i < treads.length; i++) {
      const a = find(treads[0])
      const b = find(treads[i])
      if (a !== b) parent[b] = a
    }
  })
  const flights = new Map<number, number[]>()
  info.forEach((ri, r) => {
    if (!isTread(ri)) return
    const root = find(r)
    const f = flights.get(root)
    if (f) f.push(r)
    else flights.set(root, [r])
  })

  const inRake = new Set<number>()
  const rakeTris: Tri[][] = []
  /** The treads as wound in the file, for `walkableFacing`. */
  const asWound: Tri[] = []
  for (const treads of flights.values()) {
    const rows = new Set(treads.map((r) => Math.round(info[r].region.plane.point.z / 0.05)))
    const treadArea = treads.reduce((s, r) => s + info[r].region.area, 0)
    if (rows.size < opts.minRows || treadArea < opts.minRakeArea) continue

    const risers = new Set<number>()
    for (const t of treads) for (const n of neighbours[t]) if (isRiser(info[n])) risers.add(n)
    const step = weightedMedian([...risers].map((r) => [info[r].zMax - info[r].zMin, info[r].region.area]))

    const treadTris: Tri[] = []
    for (const r of treads) {
      inRake.add(r)
      for (const t of info[r].region.triangles ?? []) {
        const tri = srcTri(t)
        asWound.push(tri)
        bisect(faceUp(tri), opts.maxEdge, treadTris)
      }
    }
    const ref = centroid(treadTris[0].ven)
    const cut = mergeSectors(
      sectors(treadTris, step, opts, ref).flatMap((s) => pieces(s, opts.maxRiser)),
      step,
      ref,
    )
    const owner = nearestSector(cut)
    const withRisers = cut.map((ts) => [...ts])
    for (const r of risers) {
      const tris = (info[r].region.triangles ?? []).map(srcTri)
      const owners = tris.map((t) => owner(centroid(t.ven)))
      // A riser with no tread near it is not part of this flight after all.
      if (owners.some((s) => s === -1)) continue
      inRake.add(r)
      tris.forEach((t, i) => withRisers[owners[i]].push(t))
    }
    rakeTris.push(...withRisers)
  }

  // Everything that is not seating: walls by steepness, floor and ceiling by position.
  const walls: Tri[] = []
  const levelRegions: number[] = []
  info.forEach((ri, r) => {
    if (inRake.has(r)) return
    if (ri.level < WALL) for (const t of ri.region.triangles ?? []) walls.push(srcTri(t))
    else levelRegions.push(r)
  })
  const index = new LevelIndex(
    info.flatMap((ri) => (ri.level >= WALL ? (ri.region.triangles ?? []).map((t) => tri9(venue, sources[t])) : [])),
  )
  const floor: Tri[] = []
  const ceiling: Tri[] = []
  const walkable = walkableFacing(asWound)
  for (const r of levelRegions) {
    const tris = (info[r].region.triangles ?? []).map(srcTri)
    const kind = levelKind(
      tris.map((t) => t.ven),
      index,
      opts,
      walkable,
    )
    ;(kind === 'ceiling' ? ceiling : floor).push(...tris)
  }

  // Rakes in a stable order: lowest first, then along X, then Y. The same file gives the
  // same names every time, which a re-run of preparation relies on.
  const keyed = rakeTris
    .map((ts) => {
      let w = 0
      let x = 0
      let y = 0
      let z = 0
      for (const t of ts) {
        const c = centroid(t.ven)
        const a = venArea(t)
        w += a
        x += c.x * a
        y += c.y * a
        z += c.z * a
      }
      w = w || 1
      return { ts, x: x / w, y: y / w, z: z / w }
    })
    .sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y)

  const part = (suffix: string, name: string, tris: Tri[], tags: string[] = []): ImportedNode => {
    const positions = new Float64Array(tris.length * 9)
    tris.forEach((t, i) => positions.set(t.src, i * 9))
    return { id: `${node.id}/${suffix}`, name, tags: [...node.tags, ...tags], positions, children: [] }
  }
  const parts: ImportedNode[] = keyed.map((k, i) => part(`rake${i + 1}`, `Rake ${i + 1}`, k.ts, [RAKE_TAG]))
  if (floor.length) parts.push(part('floor', 'Floor', floor))
  if (ceiling.length) parts.push(part('ceiling', 'Ceiling', ceiling))
  if (walls.length) parts.push(part('walls', 'Walls', walls))

  // One part is the node again under another name: nothing was found to separate.
  if (parts.length < 2) return null
  return { parts, rakes: keyed.length }
}

/**
 * Split every one-piece model in a scene.
 *
 * The node that was split stays, as a container holding its parts under the same id and
 * name, so the tree still shows the object the file had — with its rakes, floor, ceiling
 * and walls underneath, each one row to switch off.
 */
export function splitScene(
  scene: ImportedScene,
  transform: TransformOptions,
  options: Partial<SplitOptions> = {},
): { scene: ImportedScene; stats: SplitStats } {
  const stats: SplitStats = { ...EMPTY_SPLIT }
  const walk = (nodes: ImportedNode[]): ImportedNode[] =>
    nodes.map((n) => {
      if (n.children.length > 0) return { ...n, children: walk(n.children) }
      const split = splitNode(n, transform, options)
      if (!split) return n
      stats.nodesSplit++
      stats.parts += split.parts.length
      stats.rakes += split.rakes
      return { ...n, positions: new Float64Array(0), children: split.parts }
    })
  const nodes = walk(scene.nodes)
  if (stats.nodesSplit === 0) return { scene, stats }
  return { scene: { ...scene, nodes }, stats }
}
