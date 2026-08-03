/**
 * Many modelled objects -> one piece of geometry.
 *
 * `planarize.ts` merges triangles that SHARE AN EDGE. That is the right rule and it is why
 * a ceiling comes back as one plane, but it cannot touch the case this module exists for:
 * a drawing where every seat in the house is modelled individually. Four hundred seats do
 * not touch each other — the gap between them is real geometry, not a crack for `weld` to
 * close — so the flood fill correctly reports four hundred regions, `minArea` cannot drop
 * them (a seat pan is ~0.2 m^2), and `maxObjectsPerNode` only keeps an arbitrary biggest N.
 *
 * What a listening plane wants is the seating AREA. Getting there means deciding, on the
 * user's authority rather than the geometry's, that a scattering of separate surfaces
 * stands for one surface. That decision is what a rationalisation is.
 *
 *   capture (which triangles) -> fit one plane -> recover outlines
 *
 * The output is `RegionOutline[]`, which is what `nodeOutlines` produces and what every
 * output target already consumes — so ArrayCalc and Soundvision both pick a rationalisation
 * up with no code of their own. It joins the road at the one place the road is shared.
 *
 * The transform is applied ONCE, forwards, in `capture`, and never inverted: everything
 * from there on is venue space, which is also the space an outline is defined in. See the
 * origin-picker rule in CLAUDE.md — anything reaching back to source coordinates is a
 * second copy of `applyTransform`.
 *
 * Nothing here mutates the scene. A rationalisation is a decision keyed by node id, re-run
 * from the source geometry on every change, so it survives a units change and is undone by
 * deleting it. See AGENTS.md §4.
 */

import Delaunator from 'delaunator'
import type { ImportedNode } from '../import/types.ts'
import type { RegionOutline } from './outline.ts'
import type { Region, WeldedMesh } from './planarize.ts'
import {
  type Pt2,
  boundaryLoops,
  convexHull,
  dropCollinear,
  levelAlignedRect,
  minAreaRect,
  pointInRing,
  simplifyClosed,
} from './polygon.ts'
import { type TransformOptions, applyTransform } from './transform.ts'
import {
  type Plane,
  type Vec3,
  dot,
  normalize,
  planeBasis,
  scale,
  signedArea2,
  sub,
  toPlane2D,
  triArea,
  triNormal,
  v3,
} from './vec.ts'

/** Which triangles of the captured objects count towards the plane. */
export type CaptureFaces =
  /**
   * Only faces pointing up. A modelled seat is a solid: its back, its sides and its
   * underside are all in the soup, and averaging them puts the "seating plane" somewhere
   * inside the seat. Keeping the upward faces reduces each seat to its pan, which is the
   * surface a listening plane is actually about. The Vectorworks plug-in takes a seating
   * solid's top face for the same reason.
   */
  | 'upward'
  /** Everything captured. For a wall, a bare rake, or anything already single-sided. */
  | 'all'

/** How the captured points become an outline. */
export type OutlineMode =
  /**
   * Bridge gaps up to `gapMetres` and keep the rest. Set the gap to the row pitch and a
   * field of seats becomes one area while an aisle wider than the pitch survives as an
   * aisle. The default, and the only mode that answers the question honestly.
   */
  | 'concave'
  /** Convex hull. Right for a rectangular or fan-shaped stalls block; on a horseshoe it
   *  swallows the stage. */
  | 'hull'
  /** The polygon the user drew. The captured geometry then only supplies height and rake. */
  | 'footprint'
  /** Level-aligned bounding rectangle. What a Positioning area is required to be. */
  | 'rect'

export interface RationaliseOptions {
  transform: TransformOptions
  faces: CaptureFaces
  /** Degrees from straight up that still counts as an upward face. */
  upwardDeg: number
  /** Metres. The largest gap `concave` will bridge. Physically: row pitch. */
  gapMetres: number
  mode: OutlineMode
  /**
   * Venue-XY polygon. Required by `footprint`; in every other mode it still CLIPS the
   * capture, which is what makes "draw round the stalls" work on a DXF where every seat in
   * the house shares one layer node and the tree cannot separate them.
   */
  footprint?: Pt2[]
  /** Metres. Douglas-Peucker tolerance on the emitted outline. */
  simplifyTolerance: number
  /** m^2. Areas smaller than this are dropped as strays. */
  minArea: number
}

export const DEFAULT_RATIONALISE: RationaliseOptions = {
  transform: { unitsPerMetre: 1, upAxis: 'z', headingDeg: 0, offset: { x: 0, y: 0, z: 0 }, flipX: false },
  faces: 'upward',
  // 60 degrees: generous enough to keep the rake of a steep balcony (35 deg is already a
  // lot) while still rejecting anything that is really a wall, and every downward soffit.
  upwardDeg: 60,
  // 0.9 m is a tight-ish row pitch. Bridges seat to seat and row to row, and leaves a
  // 1.1 m aisle standing.
  gapMetres: 0.9,
  mode: 'concave',
  simplifyTolerance: 0.05,
  minArea: 0.5,
}

export interface RationaliseStats {
  membersIn: number
  trianglesIn: number
  /** Survived the face filter and the footprint clip. */
  trianglesKept: number
  /**
   * Faces that pointed the right way but fell OUTSIDE the drawn area.
   *
   * The number that decides whether replacing the members is safe. Drawing round the
   * stalls of a DXF whose every seat shares one layer means the balcony is in this count,
   * and dropping the member node would take the balcony with it.
   */
  trianglesOutside: number
  /** Separate areas emitted. More than one means the gap did not bridge them. */
  componentsOut: number
  /** Metres. How far the captured geometry sits off the single fitted plane. */
  rmsResidual: number
  maxResidual: number
  /** m^2 of real captured surface. */
  areaCaptured: number
  /**
   * m^2 of polygon emitted. For seating this is much the larger and should be — the air
   * between the seats is the point. A wild ratio means two blocks got captured as one.
   */
  areaEmitted: number
}

export interface RationaliseResult {
  /** Venue space, ready for `convert.ts` / `soundvision/convert.ts`. Empty when nothing survived. */
  outlines: RegionOutline[]
  stats: RationaliseStats
  warnings: string[]
}

const EMPTY_STATS: RationaliseStats = {
  membersIn: 0,
  trianglesIn: 0,
  trianglesKept: 0,
  trianglesOutside: 0,
  componentsOut: 0,
  rmsResidual: 0,
  maxResidual: 0,
  areaCaptured: 0,
  areaEmitted: 0,
}

/** A captured triangle: corners in venue space, plus the area that weights the fit. */
export interface Sample {
  a: Vec3
  b: Vec3
  c: Vec3
  area: number
}

const triCentroid = (s: Sample): Vec3 =>
  v3((s.a.x + s.b.x + s.c.x) / 3, (s.a.y + s.b.y + s.c.y) / 3, (s.a.z + s.b.z + s.c.z) / 3)

/**
 * Pull the triangles that count out of the member nodes, in VENUE space.
 *
 * Venue space because every question asked from here on is a question about the venue —
 * which way is up, is this inside the drawn footprint, how far apart are these in metres —
 * and because an outline is defined in venue space anyway. This is the only place in the
 * module the transform appears, and it appears forwards.
 */
export function capture(
  members: ImportedNode[],
  opts: RationaliseOptions,
): { samples: Sample[]; trianglesIn: number; trianglesOutside: number } {
  const samples: Sample[] = []
  let trianglesIn = 0
  let trianglesOutside = 0
  const minUpZ = Math.cos((Math.min(Math.max(opts.upwardDeg, 0), 89.9) * Math.PI) / 180)
  const clip = opts.footprint && opts.footprint.length >= 3 ? opts.footprint : null

  for (const node of members) {
    const p = applyTransform(node.positions, opts.transform)
    for (let i = 0; i + 8 < p.length; i += 9) {
      trianglesIn++
      const a = v3(p[i], p[i + 1], p[i + 2])
      const b = v3(p[i + 3], p[i + 4], p[i + 5])
      const c = v3(p[i + 6], p[i + 7], p[i + 8])
      const area = triArea(a, b, c)
      if (area <= 0) continue

      if (opts.faces === 'upward') {
        // Not abs(): a downward face is a soffit or the underside of a seat, and excluding
        // it is exactly what this filter is for. Only genuinely upward faces count.
        if (triNormal(a, b, c).z < minUpZ) continue
      }

      if (clip) {
        const cx = (a.x + b.x + c.x) / 3
        const cy = (a.y + b.y + c.y) / 3
        if (!pointInRing([cx, cy], clip)) {
          trianglesOutside++
          continue
        }
      }

      samples.push({ a, b, c, area })
    }
  }

  return { samples, trianglesIn, trianglesOutside }
}

export interface PlaneFit extends Plane {
  rmsResidual: number
  maxResidual: number
}

/**
 * Area-weighted least-squares plane through a set of triangles.
 *
 * The general (covariance) form, NOT the `z = ax + by + c` form `trace/heights.ts` solves.
 * They answer different questions and neither is a copy of the other: the z-explicit form
 * cannot represent a wall, which `faces: 'all'` may legitimately be handed, and this form
 * cannot be evaluated as "the height at x, y", which is all a traced corner ever needs.
 *
 * Least squares through the SURFACE, not an average of the triangle normals. On a stepped
 * rake — the normal way to model an auditorium — every seat pan is separately horizontal,
 * so an area-weighted normal average points straight up and describes a flat floor. The
 * least-squares fit finds the inclined plane through the steps, which is the audience plane
 * a designer means, and `maxResidual` then reports the step height rather than hiding it.
 * That reporting is the point: a real change in level must not be quietly flattened.
 *
 * "Surface" and not "corners" is load-bearing. Accumulating the corners treats a vertex
 * shared by six triangles as six samples, so the fit depends on how the exporter happened
 * to mesh the room — a square split along one diagonal weights that diagonal's two corners
 * twice and tilts the answer. Integrating over each triangle instead (its centroid, plus
 * the exact second moment of a uniform triangle about that centroid, carried to the global
 * centroid by the parallel-axis theorem) makes the result depend only on the SHAPE. The
 * same room exported from two packages then fits the same plane, which is the least a
 * converter can promise.
 */
export function fitPlane(samples: Sample[]): PlaneFit {
  const flat: PlaneFit = { normal: v3(0, 0, 1), point: v3(0, 0, 0), rmsResidual: 0, maxResidual: 0 }
  if (samples.length === 0) return flat

  let w = 0
  let cx = 0
  let cy = 0
  let cz = 0
  for (const s of samples) {
    const t = triCentroid(s)
    cx += t.x * s.area
    cy += t.y * s.area
    cz += t.z * s.area
    w += s.area
  }
  if (w <= 0) return flat
  const centroid = v3(cx / w, cy / w, cz / w)

  // Symmetric covariance about the centroid. Centring first for the same reason
  // `fitHeightPlane` does: a venue modelled 300 m from the origin otherwise makes every
  // moment a small difference of large numbers.
  let xx = 0
  let xy = 0
  let xz = 0
  let yy = 0
  let yz = 0
  let zz = 0
  for (const s of samples) {
    const t = triCentroid(s)
    // Parallel axis: the triangle's own spread about its centroid, plus its area sitting
    // at that centroid's offset from the global one.
    const d = sub(t, centroid)
    xx += s.area * d.x * d.x
    xy += s.area * d.x * d.y
    xz += s.area * d.x * d.z
    yy += s.area * d.y * d.y
    yz += s.area * d.y * d.z
    zz += s.area * d.z * d.z
    // A uniform triangle's second moment about its own centroid is area/12 times the sum
    // of the outer products of its corner offsets. Exact, not an approximation.
    const k = s.area / 12
    for (const p of [s.a, s.b, s.c]) {
      const e = sub(p, t)
      xx += k * e.x * e.x
      xy += k * e.x * e.y
      xz += k * e.x * e.z
      yy += k * e.y * e.y
      yz += k * e.y * e.z
      zz += k * e.z * e.z
    }
  }

  const normal = smallestEigenvector([
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ])

  let sum = 0
  let n = 0
  let maxResidual = 0
  for (const s of samples) {
    for (const p of [s.a, s.b, s.c]) {
      const r = Math.abs(dot(sub(p, centroid), normal))
      sum += r * r
      n++
      if (r > maxResidual) maxResidual = r
    }
  }

  return { normal, point: centroid, rmsResidual: n ? Math.sqrt(sum / n) : 0, maxResidual }
}

/**
 * Eigenvector of the smallest eigenvalue of a symmetric 3x3, by cyclic Jacobi.
 *
 * For a covariance matrix that is the direction of least spread — the plane normal.
 * Jacobi rather than the closed form for a symmetric cubic: the closed form loses its
 * precision exactly where this input lives, on a near-degenerate matrix built from points
 * that are very nearly coplanar, which here is the normal case and not the exception.
 */
export function smallestEigenvector(m: number[][]): Vec3 {
  const a = m.map((r) => r.slice())
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]

  for (let sweep = 0; sweep < 24; sweep++) {
    if (Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]) < 1e-18) break
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(a[p][q]) < 1e-20) continue
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1)
      const s = t * c
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p]
        const akq = a[k][q]
        a[k][p] = c * akp - s * akq
        a[k][q] = s * akp + c * akq
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k]
        const aqk = a[q][k]
        a[p][k] = c * apk - s * aqk
        a[q][k] = s * apk + c * aqk
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p]
        const vkq = v[k][q]
        v[k][p] = c * vkp - s * vkq
        v[k][q] = s * vkp + c * vkq
      }
    }
  }

  let best = 0
  for (let i = 1; i < 3; i++) if (a[i][i] < a[best][best]) best = i
  const n = normalize(v3(v[0][best], v[1][best], v[2][best]))
  // Point it up by convention. A listening plane wound the other way is the Soundvision
  // trap in AGENTS.md §5 — it silently predicts nothing — and `orientFace` only rescues a
  // face that is already near-horizontal.
  return n.z < 0 ? scale(n, -1) : n
}

/**
 * Split a 2D point set into components no two of which are further apart than `maxEdge`,
 * and return each component's triangles as vertex-index triples.
 *
 * Delaunay, then discard every triangle with an edge longer than the bridging gap. That is
 * an alpha shape with the radius expressed as a distance a person can reason about: set it
 * to the row pitch and it bridges seat to seat and row to row, and leaves an aisle wider
 * than the pitch standing as an aisle.
 *
 * Components come back separately ON PURPOSE. Two seating blocks eight metres apart are
 * two planes, and quietly bridging them produces one object covering the gangway between
 * them — which looks entirely plausible on screen and is wrong on site.
 */
export function alphaComponents(pts: Pt2[], maxEdge: number): number[][] {
  if (pts.length < 3) return []
  const flat = new Float64Array(pts.length * 2)
  for (let i = 0; i < pts.length; i++) {
    flat[i * 2] = pts[i][0]
    flat[i * 2 + 1] = pts[i][1]
  }

  const tris = new Delaunator(flat).triangles
  const triCount = tris.length / 3
  if (triCount === 0) return []

  const maxSq = maxEdge * maxEdge
  const keep = new Uint8Array(triCount)
  const edgeLenSq = (i: number, j: number) => {
    const dx = pts[i][0] - pts[j][0]
    const dy = pts[i][1] - pts[j][1]
    return dx * dx + dy * dy
  }
  for (let t = 0; t < triCount; t++) {
    const a = tris[t * 3]
    const b = tris[t * 3 + 1]
    const c = tris[t * 3 + 2]
    keep[t] = Math.max(edgeLenSq(a, b), edgeLenSq(b, c), edgeLenSq(c, a)) <= maxSq ? 1 : 0
  }

  // Union-find over surviving triangles that share an edge.
  const parent = new Int32Array(triCount)
  for (let i = 0; i < triCount; i++) parent[i] = i
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]
    while (parent[x] !== r) {
      const nx = parent[x]
      parent[x] = r
      x = nx
    }
    return r
  }

  const owner = new Map<string, number>()
  const key = (i: number, j: number) => (i < j ? `${i}_${j}` : `${j}_${i}`)
  for (let t = 0; t < triCount; t++) {
    if (!keep[t]) continue
    const a = tris[t * 3]
    const b = tris[t * 3 + 1]
    const c = tris[t * 3 + 2]
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const k = key(p, q)
      const prev = owner.get(k)
      if (prev === undefined) {
        owner.set(k, t)
      } else {
        const rx = find(prev)
        const ry = find(t)
        if (rx !== ry) parent[ry] = rx
      }
    }
  }

  const groups = new Map<number, number[]>()
  for (let t = 0; t < triCount; t++) {
    if (!keep[t]) continue
    const r = find(t)
    const g = groups.get(r)
    const triple = [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]]
    if (g) g.push(...triple)
    else groups.set(r, triple)
  }
  return [...groups.values()]
}

/** Force a ring counter-clockwise, so every emitted face faces the way the plane does. */
const ccw = (ring: Pt2[]): Pt2[] => (signedArea2(ring) < 0 ? ring.slice().reverse() : ring)
const ringArea = (ring: Pt2[]) => Math.abs(signedArea2(ring)) / 2

/** Where the fitted plane sits above a plan position. Null for a vertical plane. */
function onPlaneAtXY(x: number, y: number, pl: Plane): Vec3 | null {
  if (Math.abs(pl.normal.z) < 1e-6) return null
  const z = pl.point.z - ((x - pl.point.x) * pl.normal.x + (y - pl.point.y) * pl.normal.y) / pl.normal.z
  return v3(x, y, z)
}

/**
 * Reduce a set of members to planar outlines — usually one.
 *
 * `name` is only used in the warnings, which are the whole reason this returns anything
 * other than geometry: a rationalisation is the user asserting that scattered surfaces are
 * one surface, and the numbers that say what that assertion cost belong on screen.
 */
export function rationalise(
  members: ImportedNode[],
  name: string,
  opts: RationaliseOptions,
): RationaliseResult {
  const warnings: string[] = []
  const { samples, trianglesIn, trianglesOutside } = capture(members, opts)
  const stats: RationaliseStats = {
    ...EMPTY_STATS,
    membersIn: members.length,
    trianglesIn,
    trianglesOutside,
  }
  const nothing = (why: string): RationaliseResult => {
    warnings.push(why)
    return { outlines: [], stats, warnings }
  }

  if (samples.length === 0) {
    return nothing(
      opts.faces === 'upward'
        ? `"${name}": nothing captured — no upward-facing surface within ${opts.upwardDeg}° of vertical. Try "all faces", or widen the drawn area.`
        : `"${name}": nothing captured.`,
    )
  }

  stats.trianglesKept = samples.length
  stats.areaCaptured = samples.reduce((s, t) => s + t.area, 0)

  const fit = fitPlane(samples)
  stats.rmsResidual = fit.rmsResidual
  stats.maxResidual = fit.maxResidual

  // Said here, before any of the ways this can come back empty. A capture spanning two
  // tiers projects both of them onto one plane, where they overlap and the outline
  // recovery collapses — and "no area survived the minimum" would then be the only thing
  // on screen, which describes the symptom and hides the cause. A rake modelled as steps
  // is the common case and is not an error, but one plane through it is a claim about
  // where the audience is, so say how far that claim sits from the model either way.
  if (fit.maxResidual > 0.25) {
    warnings.push(
      `"${name}": the captured surfaces sit up to ${fit.maxResidual.toFixed(2)} m off the single plane fitted through them (RMS ${fit.rmsResidual.toFixed(2)} m). For a stepped rake that is expected; for two tiers, rationalise them separately.`,
    )
  }

  const basis = planeBasis(fit)
  const pts3: Vec3[] = []
  for (const s of samples) pts3.push(s.a, s.b, s.c)
  const pts2 = pts3.map((p) => toPlane2D(p, basis))

  let rings: { outer: Pt2[]; holes: Pt2[][] }[] = []

  if (opts.mode === 'footprint') {
    if (!opts.footprint || opts.footprint.length < 3) {
      return nothing(`"${name}": footprint mode needs a drawn area, and nothing was drawn.`)
    }
    // The drawn polygon is a plan and has no height of its own. Drop each corner onto the
    // fitted plane along Z: the user supplies the shape, the model supplies the rake.
    const lifted: Vec3[] = []
    for (const [x, y] of opts.footprint) {
      const p = onPlaneAtXY(x, y, fit)
      if (!p) {
        return nothing(
          `"${name}": the fitted plane is vertical, so a drawn plan outline cannot be laid on it. Use concave or hull instead.`,
        )
      }
      lifted.push(p)
    }
    rings = [{ outer: ccw(lifted.map((p) => toPlane2D(p, basis))), holes: [] }]
  } else if (opts.mode === 'hull') {
    rings = [{ outer: ccw(convexHull(pts2)), holes: [] }]
  } else if (opts.mode === 'rect') {
    const levelled = levelAlignedRect(pts3, fit.normal)
    const outer = levelled ? levelled.map((p) => toPlane2D(p, basis)) : minAreaRect(convexHull(pts2))
    rings = [{ outer: ccw(outer), holes: [] }]
  } else {
    const mesh: WeldedMesh = { vertices: pts3, indices: [] }
    for (const indices of alphaComponents(pts2, opts.gapMetres)) {
      // `boundaryLoops` recovers the outer ring and any holes from the directed edges with
      // no twin — the same routine the coplanar regions use, on the same shape of input. A
      // horseshoe balcony's inner void arrives as a hole for free.
      const region: Region = { indices, plane: fit, area: 0 }
      const loops = boundaryLoops(region, mesh)
      if (loops.length === 0) continue
      const to2 = (loop: number[]) => loop.map((i) => pts2[i])
      rings.push({
        // A hole is wound against its outer ring, which is what `toFaces`/earcut expects
        // and what `boundaryLoops` already relies on downstream of a coplanar region.
        outer: ccw(to2(loops[0])),
        holes: loops.slice(1).map((l) => ccw(to2(l)).reverse()),
      })
    }
    if (rings.length === 0) {
      return nothing(
        `"${name}": the captured points could not be triangulated — they are collinear, or all effectively in one place.`,
      )
    }
  }

  const outlines: RegionOutline[] = []
  for (const r of rings) {
    const outer = simplifyClosed(dropCollinear(r.outer, opts.simplifyTolerance), opts.simplifyTolerance)
    if (outer.length < 3 || ringArea(outer) < opts.minArea) continue
    const holes = r.holes
      .map((h) => simplifyClosed(dropCollinear(h, opts.simplifyTolerance), opts.simplifyTolerance))
      .filter((h) => h.length >= 3 && ringArea(h) >= opts.minArea)
    outlines.push({ basis, outer, holes })
    stats.areaEmitted += ringArea(outer) - holes.reduce((s, h) => s + ringArea(h), 0)
  }

  if (outlines.length === 0) {
    return nothing(`"${name}": every recovered area was smaller than the ${opts.minArea} m² minimum.`)
  }
  stats.componentsOut = outlines.length

  if (outlines.length > 1 && opts.mode === 'concave') {
    warnings.push(
      `"${name}": came out as ${outlines.length} separate areas — nothing bridged them at a ${opts.gapMetres} m gap. Raise the gap to merge them, or rationalise them separately.`,
    )
  }

  return { outlines, stats, warnings }
}
