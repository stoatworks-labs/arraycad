/**
 * A scanned mesh -> planar regions.
 *
 * `planarize.ts` rests on a fact about CAD: a flat wall is made of triangles that are EXACTLY
 * coplanar, so a triangle is either in its region's plane or it is not, and five degrees is a
 * generous tolerance. A scan breaks that. A LiDAR or photogrammetry mesh of the same wall is
 * every triangle tilted by the scanner's noise — 5 mm of it on 5 cm triangles already scatters
 * the normals past five degrees — so the flood fill stops at the first triangle, every region
 * falls under `minArea`, and the venue comes back empty. Loosening the tolerances does not
 * rescue it: at 45° and 0.5 m the floor comes back, and a 1:2 rake beside it comes back as part
 * of the floor. `scan.test.ts` holds both measurements.
 *
 * So for a scan the test changes from "is this triangle in the plane" to "is it within the
 * NOISE of the plane", and the noise is measured off the mesh rather than assumed:
 *
 *   local planes -> noise -> grow from the flattest seeds -> absorb the rims -> merge -> leftovers
 *
 * - **Local planes.** Every triangle gets a normal fitted through the triangles around it —
 *   a patch a few edges across, on the same side of any sharp edge — instead of its own,
 *   which is mostly noise. How far each triangle's centroid sits off its patch's plane is the
 *   noise sample, and the median of those, scaled to a standard deviation, is the scan's
 *   noise. A median, because the samples at the edges of the room are curvature, not noise,
 *   and there are fewer of them.
 * - **Growing.** From the flattest place nobody has claimed, a region takes a neighbour while
 *   its local normal agrees with the region's FITTED plane and its centroid lies inside the
 *   noise band of it — three standard deviations, never less than `offsetTolerance`, because
 *   a real floor is not flat to the scanner's precision either. The plane is refitted from
 *   running moments as the region grows, which is what keeps it from walking round a curve:
 *   the test is against the region, never the neighbour, as in `planarize.ts`.
 * - **Absorbing.** The rounding where two surfaces meet, and the odd spike, belong to no
 *   plane by the normal test. They go to whichever neighbouring region they lie closest to,
 *   within twice the band, ring by ring — otherwise every region is a swiss cheese, and every
 *   hole is an object in the venue.
 * - **Merging.** A noisy patch can stop a region growing across it, leaving two regions of one
 *   floor. Neighbours whose union still fits one plane inside the noise are joined.
 * - **Leftovers.** Whatever is still unclaimed — a riser too thin for its own patch, a chair
 *   the scanner caught — becomes a region per connected piece, so `split.ts` loses nothing.
 * - **Level and plumb.** A region whose plane is within half the band of level (or plumb)
 *   across its whole extent is set exactly so, or its outline has no level edge to be a quad on.
 *
 * The output is the same `Region[]` `findCoplanarRegions` returns, which is what lets the
 * outline, the converters and the one-piece split take it without code of their own.
 *
 * Every array here is typed and every loop is over typed arrays: a phone scan of a room is a
 * few hundred thousand triangles, and the object-per-vector style of `planarize.ts` would
 * spend more time allocating than measuring.
 */

import type { ImportedNode } from '../import/types.ts'
import { type PlanarizeOptions, type Region, type WeldedMesh, weld } from './planarize.ts'
import { type TransformOptions, applyTransform } from './transform.ts'
import { v3 } from './vec.ts'

/** What a mesh is made of, which decides how its planes are found. */
export type SurfaceKind =
  /** Modelled: flat surfaces are exactly flat. `findCoplanarRegions`. */
  | 'cad'
  /** Scanned: flat surfaces are flat to within the scanner's noise. `findScanRegions`. */
  | 'scan'

/** What a scan was measured to be, for the panel to report and the outline to use. */
export interface ScanReport {
  /** Metres. Standard deviation of a triangle's centroid about its surface. */
  noise: number
  /** Metres. How far off a region's plane a triangle may sit and still grow into it. */
  band: number
  /** Degrees. How far a triangle's local normal may turn from the region's. */
  angle: number
  /** Metres. Median edge length: the scale the scanner meshed at. */
  edge: number
}

/** Below this many grown triangles a region is too small to trust its own plane. */
const MIN_TRIS = 12
/** A neighbour joins a local patch only if its own normal is within 60° of the patch's. */
const GATE = 0.5
/** Neither tolerance may be widened past these by a noisy estimate. */
const MAX_ANGLE = 30
const MAX_BAND_FACTOR = 5
/** A standard deviation from a median absolute deviation, for normally distributed noise. */
const MAD_TO_SIGMA = 1.4826

/** Triangles sharing a welded edge, as compressed rows: `list[start[t] .. start[t + 1]]`. */
interface Adjacency {
  start: Int32Array
  list: Int32Array
  /** Every welded edge's length, once each. */
  edgeLengths: Float64Array
}

function adjacency(indices: number[], vertices: WeldedMesh['vertices']): Adjacency {
  const triCount = indices.length / 3
  const nv = vertices.length
  const first = new Map<number, number>()
  const pa: number[] = []
  const pb: number[] = []
  const lengths: number[] = []
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t * 3 + k]
      const b = indices[t * 3 + ((k + 1) % 3)]
      // Exact in a double: nv² stays under 2^53 for any mesh that fits in memory.
      const key = a < b ? a * nv + b : b * nv + a
      const owner = first.get(key)
      if (owner === undefined) {
        first.set(key, t)
        const p = vertices[a]
        const q = vertices[b]
        lengths.push(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z))
      } else if (owner !== t) {
        // A third triangle on one edge is non-manifold; pairing it with the first keeps it
        // connected without inventing a pair between the second and third.
        pa.push(owner)
        pb.push(t)
      }
    }
  }
  const start = new Int32Array(triCount + 1)
  for (let i = 0; i < pa.length; i++) {
    start[pa[i] + 1]++
    start[pb[i] + 1]++
  }
  for (let t = 0; t < triCount; t++) start[t + 1] += start[t]
  const fill = start.slice(0, triCount)
  const list = new Int32Array(pa.length * 2)
  for (let i = 0; i < pa.length; i++) {
    list[fill[pa[i]]++] = pb[i]
    list[fill[pb[i]]++] = pa[i]
  }
  return { start, list, edgeLengths: Float64Array.from(lengths) }
}

/** Median of a copy, NaN-free. Zero for an empty input. */
function median(values: Float64Array): number {
  if (values.length === 0) return 0
  const s = values.slice().sort()
  const m = s.length >> 1
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m])
}

/**
 * Eigen-decomposition of a symmetric 3x3 by cyclic Jacobi, into `out`: the smallest
 * eigenvalue's unit vector at 0..2, then the smallest and middle eigenvalues at 3 and 4.
 *
 * Jacobi for the reason `rationalise.smallestEigenvector` gives — the input is nearly
 * degenerate by design — and a copy of its own here because this one runs once per triangle
 * and must not allocate.
 */
const jac = new Float64Array(9)
const vec = new Float64Array(9)
function eigen3(xx: number, xy: number, xz: number, yy: number, yz: number, zz: number, out: Float64Array): void {
  const a = jac
  const v = vec
  a[0] = xx
  a[1] = xy
  a[2] = xz
  a[3] = xy
  a[4] = yy
  a[5] = yz
  a[6] = xz
  a[7] = yz
  a[8] = zz
  v.fill(0)
  v[0] = v[4] = v[8] = 1
  const scale = Math.abs(xx) + Math.abs(yy) + Math.abs(zz) || 1
  for (let sweep = 0; sweep < 32; sweep++) {
    if (Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]) <= 1e-22 * scale) break
    for (let pq = 0; pq < 3; pq++) {
      const p = pq === 2 ? 1 : 0
      const q = pq === 0 ? 1 : 2
      const apq = a[p * 3 + q]
      if (Math.abs(apq) <= 1e-30 * scale) continue
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq)
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1)
      const s = t * c
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p]
        const akq = a[k * 3 + q]
        a[k * 3 + p] = c * akp - s * akq
        a[k * 3 + q] = s * akp + c * akq
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k]
        const aqk = a[q * 3 + k]
        a[p * 3 + k] = c * apk - s * aqk
        a[q * 3 + k] = s * apk + c * aqk
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p]
        const vkq = v[k * 3 + q]
        v[k * 3 + p] = c * vkp - s * vkq
        v[k * 3 + q] = s * vkp + c * vkq
      }
    }
  }
  let lo = 0
  if (a[4] < a[lo * 4]) lo = 1
  if (a[8] < a[lo * 4]) lo = 2
  let hi = lo === 0 ? 1 : 0
  for (let i = 0; i < 3; i++) if (i !== lo && a[i * 4] > a[hi * 4]) hi = i
  const mid = 3 - lo - hi
  const nx = v[lo]
  const ny = v[3 + lo]
  const nz = v[6 + lo]
  const n = Math.hypot(nx, ny, nz) || 1
  out[0] = nx / n
  out[1] = ny / n
  out[2] = nz / n
  out[3] = Math.max(a[lo * 4], 0)
  out[4] = Math.max(a[mid * 4], 0)
}

/**
 * Running moments of a set of triangles' SURFACE: area, Σ area·centroid, and the second
 * moment — each triangle's area at its centroid plus its own spread about it.
 *
 * The own spread is what `rationalise.fitPlane` calls load-bearing, and here it is found
 * the hard way: a modelled box has two triangles a face, two centroids say nothing about
 * which plane they span, and without it a floor and a wall fitted one plane well enough to
 * merge.
 */
const MOMENTS = 10
function addMoment(m: Float64Array, o: number, p: Prepared, t: number): void {
  const w = p.area[t]
  const x = p.centroid[t * 3]
  const y = p.centroid[t * 3 + 1]
  const z = p.centroid[t * 3 + 2]
  const s = p.spread
  m[o] += w
  m[o + 1] += w * x
  m[o + 2] += w * y
  m[o + 3] += w * z
  m[o + 4] += w * x * x + s[t * 6]
  m[o + 5] += w * x * y + s[t * 6 + 1]
  m[o + 6] += w * x * z + s[t * 6 + 2]
  m[o + 7] += w * y * y + s[t * 6 + 3]
  m[o + 8] += w * y * z + s[t * 6 + 4]
  m[o + 9] += w * z * z + s[t * 6 + 5]
}

/**
 * The plane of a set of moments into `plane` (normal 0..2, point 3..5) and its RMS
 * residual, or -1 when the moments hold too little to say.
 */
const eig = new Float64Array(5)
function planeOf(m: ArrayLike<number>, o: number, plane: Float64Array): number {
  const w = m[o]
  if (!(w > 0)) return -1
  const mx = m[o + 1] / w
  const my = m[o + 2] / w
  const mz = m[o + 3] / w
  eigen3(
    m[o + 4] / w - mx * mx,
    m[o + 5] / w - mx * my,
    m[o + 6] / w - mx * mz,
    m[o + 7] / w - my * my,
    m[o + 8] / w - my * mz,
    m[o + 9] / w - mz * mz,
    eig,
  )
  plane[0] = eig[0]
  plane[1] = eig[1]
  plane[2] = eig[2]
  plane[3] = mx
  plane[4] = my
  plane[5] = mz
  return Math.sqrt(eig[3])
}

/** A mesh as flat typed arrays, its centroids relative to the middle of its box. */
interface Prepared {
  triCount: number
  origin: [number, number, number]
  area: Float64Array
  /** Unit normal of each triangle as wound, 3 per triangle. */
  normal: Float64Array
  /** Centroid of each triangle, 3 per triangle, relative to `origin`. */
  centroid: Float64Array
  /**
   * Each triangle's second moment about its own centroid, xx xy xz yy yz zz: exactly
   * area/12 of the sum of its corners' outer products about the centroid.
   */
  spread: Float64Array
  adj: Adjacency
}

function prepare(mesh: WeldedMesh): Prepared {
  const { vertices, indices } = mesh
  const triCount = indices.length / 3
  let lx = Infinity
  let ly = Infinity
  let lz = Infinity
  let hx = -Infinity
  let hy = -Infinity
  let hz = -Infinity
  for (const p of vertices) {
    if (p.x < lx) lx = p.x
    if (p.y < ly) ly = p.y
    if (p.z < lz) lz = p.z
    if (p.x > hx) hx = p.x
    if (p.y > hy) hy = p.y
    if (p.z > hz) hz = p.z
  }
  // A venue can sit hundreds of metres from its origin, and every moment is a sum of squares.
  const origin: [number, number, number] = vertices.length
    ? [(lx + hx) / 2, (ly + hy) / 2, (lz + hz) / 2]
    : [0, 0, 0]
  const area = new Float64Array(triCount)
  const normal = new Float64Array(triCount * 3)
  const centroid = new Float64Array(triCount * 3)
  const spread = new Float64Array(triCount * 6)
  for (let t = 0; t < triCount; t++) {
    const a = vertices[indices[t * 3]]
    const b = vertices[indices[t * 3 + 1]]
    const c = vertices[indices[t * 3 + 2]]
    const ux = b.x - a.x
    const uy = b.y - a.y
    const uz = b.z - a.z
    const vx = c.x - a.x
    const vy = c.y - a.y
    const vz = c.z - a.z
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const l = Math.hypot(nx, ny, nz)
    area[t] = 0.5 * l
    if (l > 0) {
      normal[t * 3] = nx / l
      normal[t * 3 + 1] = ny / l
      normal[t * 3 + 2] = nz / l
    }
    const gx = (a.x + b.x + c.x) / 3
    const gy = (a.y + b.y + c.y) / 3
    const gz = (a.z + b.z + c.z) / 3
    centroid[t * 3] = gx - origin[0]
    centroid[t * 3 + 1] = gy - origin[1]
    centroid[t * 3 + 2] = gz - origin[2]
    const k = area[t] / 12
    for (const q of [a, b, c]) {
      const ex = q.x - gx
      const ey = q.y - gy
      const ez = q.z - gz
      spread[t * 6] += k * ex * ex
      spread[t * 6 + 1] += k * ex * ey
      spread[t * 6 + 2] += k * ex * ez
      spread[t * 6 + 3] += k * ey * ey
      spread[t * 6 + 4] += k * ey * ez
      spread[t * 6 + 5] += k * ez * ez
    }
  }
  return { triCount, origin, area, normal, centroid, spread, adj: adjacency(indices, vertices) }
}

/** Each triangle's normal averaged with its neighbours on the same side of a sharp edge. */
function ringNormals(p: Prepared): Float64Array {
  const { triCount, area, normal, adj } = p
  const out = new Float64Array(triCount * 3)
  for (let t = 0; t < triCount; t++) {
    const tx = normal[t * 3]
    const ty = normal[t * 3 + 1]
    const tz = normal[t * 3 + 2]
    let sx = tx * area[t]
    let sy = ty * area[t]
    let sz = tz * area[t]
    for (let j = adj.start[t]; j < adj.start[t + 1]; j++) {
      const s = adj.list[j]
      const d = tx * normal[s * 3] + ty * normal[s * 3 + 1] + tz * normal[s * 3 + 2]
      if (Math.abs(d) < GATE) continue
      // Neighbours wound the other way are the same surface; see `planarize.ts`.
      const w = (d < 0 ? -1 : 1) * area[s]
      sx += w * normal[s * 3]
      sy += w * normal[s * 3 + 1]
      sz += w * normal[s * 3 + 2]
    }
    const l = Math.hypot(sx, sy, sz)
    if (l > 0) {
      out[t * 3] = sx / l
      out[t * 3 + 1] = sy / l
      out[t * 3 + 2] = sz / l
    }
  }
  return out
}

interface LocalPlanes {
  /** Fitted normal of each triangle's patch, wound as the triangle is. 3 per triangle. */
  normal: Float64Array
  /** Signed distance of each triangle's centroid from its patch's plane. */
  residual: Float64Array
  /** RMS residual of each patch: how flat the place round each triangle is. */
  rms: Float64Array
  /**
   * Patch triangle count times its in-plane spread along its narrower direction (m²). The
   * tilt a noise σ puts on the fitted normal is about σ / √(this).
   */
  leverage: Float64Array
}

/**
 * Fit a plane through the patch round every triangle: the triangles reachable across edges
 * whose centroids lie within `radius`, at most `cap` of them, gated by `ring` so a patch
 * stops at a sharp edge rather than averaging the wall into the floor.
 */
function localPlanes(p: Prepared, ring: Float64Array, radius: number, cap: number): LocalPlanes {
  const { triCount, area, centroid, adj } = p
  const normal = new Float64Array(triCount * 3)
  const residual = new Float64Array(triCount)
  const rms = new Float64Array(triCount)
  const leverage = new Float64Array(triCount)
  const stamp = new Int32Array(triCount).fill(-1)
  const queue = new Int32Array(cap * 4 + 4)
  const r2 = radius * radius
  for (let t = 0; t < triCount; t++) {
    const rx = ring[t * 3]
    const ry = ring[t * 3 + 1]
    const rz = ring[t * 3 + 2]
    const ox = centroid[t * 3]
    const oy = centroid[t * 3 + 1]
    const oz = centroid[t * 3 + 2]
    let head = 0
    let tail = 0
    let count = 0
    let w = 0
    let sx = 0
    let sy = 0
    let sz = 0
    let xx = 0
    let xy = 0
    let xz = 0
    let yy = 0
    let yz = 0
    let zz = 0
    stamp[t] = t
    queue[tail++] = t
    while (head < tail && count < cap) {
      const s = queue[head++]
      const dx = centroid[s * 3] - ox
      const dy = centroid[s * 3 + 1] - oy
      const dz = centroid[s * 3 + 2] - oz
      // The seed's own ring always counts, however coarse the mesh, so a CAD triangle bigger
      // than the radius still gets its coplanar partner.
      const inside = s === t || dx * dx + dy * dy + dz * dz <= r2 || head <= 4
      if (!inside) continue
      const a = area[s]
      w += a
      sx += a * dx
      sy += a * dy
      sz += a * dz
      xx += a * dx * dx
      xy += a * dx * dy
      xz += a * dx * dz
      yy += a * dy * dy
      yz += a * dy * dz
      zz += a * dz * dz
      count++
      for (let j = adj.start[s]; j < adj.start[s + 1]; j++) {
        const n = adj.list[j]
        if (stamp[n] === t || tail >= queue.length) continue
        stamp[n] = t
        const d = rx * ring[n * 3] + ry * ring[n * 3 + 1] + rz * ring[n * 3 + 2]
        if (Math.abs(d) < GATE) continue
        queue[tail++] = n
      }
    }
    const raw = p.normal
    let nx = rx
    let ny = ry
    let nz = rz
    let mx = 0
    let my = 0
    let mz = 0
    if (count >= 3 && w > 0) {
      mx = sx / w
      my = sy / w
      mz = sz / w
      eigen3(xx / w - mx * mx, xy / w - mx * my, xz / w - mx * mz, yy / w - my * my, yz / w - my * mz, zz / w - mz * mz, eig)
      // Centroids on a line, or all in one spot, fix no plane: keep the ring's normal.
      if (eig[4] > 1e-12 * (xx / w + yy / w + zz / w + 1e-30)) {
        nx = eig[0]
        ny = eig[1]
        nz = eig[2]
        rms[t] = Math.sqrt(eig[3])
        leverage[t] = count * eig[4]
      }
    }
    if (nx * raw[t * 3] + ny * raw[t * 3 + 1] + nz * raw[t * 3 + 2] < 0) {
      nx = -nx
      ny = -ny
      nz = -nz
    }
    normal[t * 3] = nx
    normal[t * 3 + 1] = ny
    normal[t * 3 + 2] = nz
    // The patch mean is relative to this triangle's centroid, so the residual is minus its
    // offset along the normal.
    residual[t] = -(mx * nx + my * ny + mz * nz)
  }
  return { normal, residual, rms, leverage }
}

/** The scan's noise: a robust standard deviation of centroids about their local planes. */
function noiseOf(p: Prepared, local: LocalPlanes): number {
  const samples: number[] = []
  for (let t = 0; t < p.triCount; t++) if (p.area[t] > 0 && local.leverage[t] > 0) samples.push(Math.abs(local.residual[t]))
  return MAD_TO_SIGMA * median(Float64Array.from(samples))
}

/**
 * Find the planar regions of a scanned mesh.
 *
 * `opts.offsetTolerance` and `opts.angleTolerance` are FLOORS here, not limits: the measured
 * noise widens both, so the same settings serve a survey scanner and a phone. See the module
 * comment for the steps.
 */
export function findScanRegions(
  mesh: WeldedMesh,
  opts: PlanarizeOptions,
): { regions: Region[]; report: ScanReport } {
  const p = prepare(mesh)
  const { triCount, area, centroid, adj } = p
  const edge = median(adj.edgeLengths)
  const empty = { regions: [], report: { noise: 0, band: opts.offsetTolerance, angle: opts.angleTolerance, edge } }
  if (triCount === 0) return empty

  // Local planes over a patch about three edges across, then again over a wider one when the
  // noise turns out large against it: the tilt noise leaves on a fitted normal falls with the
  // patch's size, and a patch smaller than the noise is wide is a measurement of the noise.
  const ring = ringNormals(p)
  let radius = 3 * edge
  let local = localPlanes(p, ring, radius, 48)
  let noise = noiseOf(p, local)
  if (8 * noise > 1.5 * radius) {
    radius = Math.min(8 * noise, 10 * edge)
    local = localPlanes(p, ring, radius, 192)
    noise = noiseOf(p, local)
  }

  const band = Math.min(Math.max(3 * noise, opts.offsetTolerance), MAX_BAND_FACTOR * Math.max(opts.offsetTolerance, 1e-3))
  const tilts: number[] = []
  for (let t = 0; t < triCount; t++) if (local.leverage[t] > 0) tilts.push(noise / Math.sqrt(local.leverage[t]))
  const tilt = (median(Float64Array.from(tilts)) * 180) / Math.PI
  const angle = Math.min(Math.max(opts.angleTolerance, 3 * tilt), MAX_ANGLE)
  const cosAngle = Math.cos((angle * Math.PI) / 180)
  const report: ScanReport = { noise, band, angle, edge }

  // ---- Growing ----------------------------------------------------------------------------
  const label = new Int32Array(triCount).fill(-1)
  const order = new Uint32Array(triCount)
  for (let t = 0; t < triCount; t++) order[t] = t
  // Flattest first, and of equally flat places the larger triangle. A stable sort on typed
  // keys, so the same mesh always grows the same regions in the same order.
  order.sort((a, b) => local.rms[a] - local.rms[b] || area[b] - area[a] || a - b)

  let fit = new Float64Array(MOMENTS * 64)
  let planes = new Float64Array(6 * 64)
  const grown: number[] = []
  const queue = new Int32Array(triCount)
  const plane = new Float64Array(6)
  const ln = local.normal

  const accepts = (t: number, nx: number, ny: number, nz: number, px: number, py: number, pz: number) =>
    label[t] === -1 &&
    area[t] > 0 &&
    Math.abs(ln[t * 3] * nx + ln[t * 3 + 1] * ny + ln[t * 3 + 2] * nz) >= cosAngle &&
    Math.abs((centroid[t * 3] - px) * nx + (centroid[t * 3 + 1] - py) * ny + (centroid[t * 3 + 2] - pz) * nz) <= band

  for (const seed of order) {
    if (label[seed] !== -1 || !(area[seed] > 0)) continue
    const r = grown.length
    if ((r + 1) * MOMENTS > fit.length) {
      const f = new Float64Array(fit.length * 2)
      f.set(fit)
      fit = f
      const q = new Float64Array(planes.length * 2)
      q.set(planes)
      planes = q
    }
    const o = r * MOMENTS
    // Start from the seed's patch, not the seed: its own normal is mostly noise.
    let nx = ln[seed * 3]
    let ny = ln[seed * 3 + 1]
    let nz = ln[seed * 3 + 2]
    const res = local.residual[seed]
    let px = centroid[seed * 3] - res * nx
    let py = centroid[seed * 3 + 1] - res * ny
    let pz = centroid[seed * 3 + 2] - res * nz
    let count = 0
    let nextFit = MIN_TRIS
    const take = (t: number) => {
      label[t] = r
      addMoment(fit, o, p, t)
      count++
    }
    const refit = () => {
      if (planeOf(fit, o, plane) < 0) return
      // Keep the sign the region started with, or a refit flips which side is in front.
      const s = plane[0] * nx + plane[1] * ny + plane[2] * nz < 0 ? -1 : 1
      nx = s * plane[0]
      ny = s * plane[1]
      nz = s * plane[2]
      px = plane[3]
      py = plane[4]
      pz = plane[5]
    }
    take(seed)
    let head = 0
    let tail = 0
    queue[tail++] = seed
    // Grow, refit with everything the region now holds, and grow again from all of it: a
    // triangle turned away while the plane was a guess from a dozen triangles may fit the
    // plane two thousand of them describe.
    for (let pass = 0; pass < 3; pass++) {
      let added = 0
      while (head < tail) {
        const t = queue[head++]
        for (let j = adj.start[t]; j < adj.start[t + 1]; j++) {
          const n = adj.list[j]
          if (!accepts(n, nx, ny, nz, px, py, pz)) continue
          take(n)
          added++
          queue[tail++] = n
          if (count >= nextFit) {
            refit()
            nextFit = Math.ceil(count * 1.25) + 4
          }
        }
      }
      if (count >= MIN_TRIS) refit()
      if (pass > 0 && added === 0) break
      head = 0
    }
    planes[r * 6] = nx
    planes[r * 6 + 1] = ny
    planes[r * 6 + 2] = nz
    planes[r * 6 + 3] = px
    planes[r * 6 + 4] = py
    planes[r * 6 + 5] = pz
    grown.push(count)
  }

  // ---- Absorbing --------------------------------------------------------------------------
  // A region of fewer than MIN_TRIS is too small to know its own plane, so its triangles are
  // as claimable as unclaimed ones. Sources are the regions that are not.
  const hard = (r: number) => r >= 0 && grown[r] >= MIN_TRIS
  const reach = 2 * band
  const distanceTo = (r: number, t: number) =>
    Math.abs(
      (centroid[t * 3] - planes[r * 6 + 3]) * planes[r * 6] +
        (centroid[t * 3 + 1] - planes[r * 6 + 4]) * planes[r * 6 + 1] +
        (centroid[t * 3 + 2] - planes[r * 6 + 5]) * planes[r * 6 + 2],
    )
  let frontier: number[] = []
  for (let t = 0; t < triCount; t++) {
    if (hard(label[t]) || !(area[t] > 0)) continue
    for (let j = adj.start[t]; j < adj.start[t + 1]; j++) {
      if (hard(label[adj.list[j]])) {
        frontier.push(t)
        break
      }
    }
  }
  while (frontier.length) {
    const claims: number[] = []
    for (const t of frontier) {
      if (hard(label[t])) continue
      let best = -1
      let bestD = reach
      for (let j = adj.start[t]; j < adj.start[t + 1]; j++) {
        const r = label[adj.list[j]]
        if (!hard(r)) continue
        const d = distanceTo(r, t)
        if (d <= bestD) {
          bestD = d
          best = r
        }
      }
      if (best >= 0) claims.push(t, best)
    }
    // Applied after the round, so the order the frontier was walked decides nothing.
    const next = new Set<number>()
    for (let i = 0; i < claims.length; i += 2) {
      const t = claims[i]
      label[t] = claims[i + 1]
      for (let j = adj.start[t]; j < adj.start[t + 1]; j++) {
        const n = adj.list[j]
        if (!hard(label[n]) && area[n] > 0) next.add(n)
      }
    }
    frontier = [...next]
  }

  // ---- Leftovers --------------------------------------------------------------------------
  // What no region could take, each connected piece its own region. A small region that lost
  // only some triangles to absorbing keeps the rest, as its own piece.
  const pieceOf = new Int32Array(triCount).fill(-1)
  let regionCount = grown.length
  for (let t = 0; t < triCount; t++) {
    if (!(area[t] > 0) || hard(label[t]) || pieceOf[t] !== -1) continue
    const start = label[t]
    const id = regionCount++
    let head = 0
    let tail = 0
    queue[tail++] = t
    pieceOf[t] = id
    while (head < tail) {
      const s = queue[head++]
      for (let j = adj.start[s]; j < adj.start[s + 1]; j++) {
        const n = adj.list[j]
        if (pieceOf[n] !== -1 || !(area[n] > 0) || hard(label[n]) || label[n] !== start) continue
        pieceOf[n] = id
        queue[tail++] = n
      }
    }
    for (let i = 0; i < tail; i++) label[queue[i]] = id
  }

  // Final moments over every member — grown, absorbed and leftover alike.
  const moments = new Float64Array(regionCount * MOMENTS)
  for (let t = 0; t < triCount; t++) {
    const r = label[t]
    if (r < 0) continue
    addMoment(moments, r * MOMENTS, p, t)
  }

  // ---- Merging ----------------------------------------------------------------------------
  const parent = new Int32Array(regionCount)
  for (let r = 0; r < regionCount; r++) parent[r] = r
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  const pairs = new Set<number>()
  for (let t = 0; t < triCount; t++) {
    const a = label[t]
    if (a < 0) continue
    for (let j = adj.start[t]; j < adj.start[t + 1]; j++) {
      const b = label[adj.list[j]]
      if (b < 0 || b === a) continue
      pairs.add(a < b ? a * regionCount + b : b * regionCount + a)
    }
  }
  const merged = new Float64Array(MOMENTS)
  /** Mean square distance of region `r`'s centroids from the plane in `plane`. */
  const meanSquareOff = (r: number): number => {
    const o = r * MOMENTS
    const w = moments[o]
    const nx = plane[0]
    const ny = plane[1]
    const nz = plane[2]
    const along =
      (nx * nx * moments[o + 4] +
        2 * nx * ny * moments[o + 5] +
        2 * nx * nz * moments[o + 6] +
        ny * ny * moments[o + 7] +
        2 * ny * nz * moments[o + 8] +
        nz * nz * moments[o + 9]) /
      w
    const mean = (nx * moments[o + 1] + ny * moments[o + 2] + nz * moments[o + 3]) / w
    const at = nx * plane[3] + ny * plane[4] + nz * plane[5]
    return along - 2 * at * mean + at * at
  }
  /**
   * RMS of the union's plane when the two may join, otherwise -1.
   *
   * Judged by distance, not by comparing normals. The patches a noisy floor leaves behind
   * are exactly the ones the noise tilted — measured, 5° to 10° on a 20 mm scan, several
   * times what their size predicts — so a normal test keeps them out however it is widened.
   * What a patch of the floor does do is lie within the noise of the floor's plane, and a
   * ramp, a riser or a tier of a raked fan does not, however small: its own triangles are
   * held to the band, so it cannot ride in on a big neighbour's area.
   */
  const joinScore = (a: number, b: number): number => {
    for (let k = 0; k < MOMENTS; k++) merged[k] = moments[a * MOMENTS + k] + moments[b * MOMENTS + k]
    const rms = planeOf(merged, 0, plane)
    if (rms < 0 || rms > band / 2) return -1
    if (meanSquareOff(a) > band * band || meanSquareOff(b) > band * band) return -1
    return rms
  }
  for (let round = 0; round < 64; round++) {
    const scored: { a: number; b: number; s: number }[] = []
    const seen = new Set<number>()
    for (const key of pairs) {
      const a = find(Math.floor(key / regionCount))
      const b = find(key % regionCount)
      if (a === b) continue
      const k = a < b ? a * regionCount + b : b * regionCount + a
      if (seen.has(k)) continue
      seen.add(k)
      const s = joinScore(a, b)
      if (s >= 0) scored.push({ a, b, s })
    }
    if (scored.length === 0) break
    scored.sort((x, y) => x.s - y.s || x.a - y.a || x.b - y.b)
    let joins = 0
    for (const { a: a0, b: b0 } of scored) {
      const a = find(a0)
      const b = find(b0)
      if (a === b) continue
      // Scored against the regions as they were; either may have grown since.
      if ((a !== a0 || b !== b0) && joinScore(a, b) < 0) continue
      const [keep, gone] = a < b ? [a, b] : [b, a]
      for (let k = 0; k < MOMENTS; k++) moments[keep * MOMENTS + k] += moments[gone * MOMENTS + k]
      parent[gone] = keep
      joins++
    }
    if (joins === 0) break
  }

  // ---- Out --------------------------------------------------------------------------------
  const members = new Map<number, number[]>()
  for (let t = 0; t < triCount; t++) {
    if (label[t] < 0) continue
    const r = find(label[t])
    const list = members.get(r)
    if (list) list.push(t)
    else members.set(r, [t])
  }
  const { indices } = mesh
  const [ox, oy, oz] = p.origin
  const regions: Region[] = []
  /** Do triangles `t` and `s` run along the edge they share in the same direction? */
  const sameWay = (t: number, s: number): boolean => {
    for (let k = 0; k < 3; k++) {
      const a = indices[t * 3 + k]
      const b = indices[t * 3 + ((k + 1) % 3)]
      for (let m = 0; m < 3; m++) {
        if (indices[s * 3 + m] !== a) continue
        if (indices[s * 3 + ((m + 1) % 3)] === b) return true
        if (indices[s * 3 + ((m + 2) % 3)] === b) return false
      }
    }
    return false
  }
  const dotPlane = (t: number) => p.normal[t * 3] * plane[0] + p.normal[t * 3 + 1] * plane[1] + p.normal[t * 3 + 2] * plane[2]
  const inRegion = new Int32Array(triCount).fill(-1)
  const seen = new Int32Array(triCount).fill(-1)
  const flip = new Uint8Array(triCount)
  for (const [r, tris] of members) {
    planeOf(moments, r * MOMENTS, plane)
    // Area as the plane sees it. Noise crumples a scanned floor, and the crumpled surface is
    // larger than the floor — by a tenth at 10 mm on 5 cm triangles.
    let total = 0
    for (const t of tris) total += area[t] * Math.abs(dotPlane(t))
    if (total < opts.minArea) continue

    // Winding. `planarize.ts` turns each triangle to agree with the region's normal, which is
    // right for CAD and wrong here: noise folds the odd scanned triangle over, its normal
    // points backwards, and turning it round leaves an edge running the same way on both
    // sides — which `boundaryLoops` reads as outline, so a floor came back as 114 loops. So
    // winding is carried across shared edges instead, each piece of the region agreeing with
    // itself and then, as a piece, with the plane.
    for (const t of tris) inRegion[t] = r
    for (const start of tris) {
      if (seen[start] === r) continue
      seen[start] = r
      flip[start] = 0
      let head = 0
      let tail = 0
      queue[tail++] = start
      let facing = 0
      while (head < tail) {
        const t = queue[head++]
        facing += area[t] * dotPlane(t) * (flip[t] ? -1 : 1)
        for (let j = adj.start[t]; j < adj.start[t + 1]; j++) {
          const n = adj.list[j]
          if (inRegion[n] !== r || seen[n] === r) continue
          seen[n] = r
          flip[n] = flip[t] ^ (sameWay(t, n) ? 1 : 0)
          queue[tail++] = n
        }
      }
      if (facing < 0) for (let i = 0; i < tail; i++) flip[queue[i]] ^= 1
    }
    // Every triangle now faces along the fitted normal. Which way the region faces is the way
    // most of its surface was wound in the file: a scan is wound consistently, and of a CAD
    // soup put through this, the majority is the best guess.
    let wound = 0
    for (const t of tris) wound += area[t] * Math.sign(dotPlane(t))
    const s = wound < 0 ? -1 : 1
    let nx = s * plane[0]
    let ny = s * plane[1]
    let nz = s * plane[2]
    // Level and plumb, where the scan cannot tell otherwise. A scanned floor fits a plane a
    // hundredth of a degree off level — noise, and enough to give it a "level direction" at
    // random, so its rectangle has no level edge and cannot be one ArrayCalc quad. Where
    // turning the plane to exactly level (or a wall to exactly plumb) moves no part of the
    // region by more than half the band, the difference is the scanner's. A floor that really
    // falls 5 mm a metre moves its far end further than that, and keeps its fall.
    let reach = 0
    for (const t of tris) {
      const d = Math.hypot(centroid[t * 3] - plane[3], centroid[t * 3 + 1] - plane[4], centroid[t * 3 + 2] - plane[5])
      if (d > reach) reach = d
    }
    const across = Math.hypot(nx, ny)
    if (across * reach <= band / 2) {
      nx = 0
      ny = 0
      nz = nz < 0 ? -1 : 1
    } else if (Math.abs(nz) * reach <= band / 2) {
      nx /= across
      ny /= across
      nz = 0
    }
    const regionIndices: number[] = []
    for (const t of tris) {
      const a = indices[t * 3]
      const b = indices[t * 3 + 1]
      const c = indices[t * 3 + 2]
      if ((flip[t] === 1) !== (s < 0)) regionIndices.push(a, c, b)
      else regionIndices.push(a, b, c)
    }
    regions.push({
      indices: regionIndices,
      plane: { normal: v3(nx, ny, nz), point: v3(plane[3] + ox, plane[4] + oy, plane[5] + oz) },
      area: total,
      triangles: tris,
    })
  }
  return { regions: regions.sort((a, b) => b.area - a.area), report }
}

/** What `guessSurface` saw, for the panel to explain itself with. */
export interface SurfaceGuess {
  kind: SurfaceKind
  /** Share of the surface whose triangles have an exactly coplanar neighbour. */
  coplanarShare: number
}

/** cos 0.5°: a neighbour this close to parallel was modelled flat, not scanned flat. */
const COPLANAR = Math.cos((0.5 * Math.PI) / 180)
/** Below this share of coplanar surface, a mesh is a scan. */
const SCAN_SHARE = 0.2

/**
 * Is this model a scan? A guess, from how its triangles meet.
 *
 * A modeller meshes a flat face into triangles that are exactly coplanar with their
 * neighbours — even a curved one, faceted, comes in coplanar pairs. A scanner never does:
 * noise tilts every triangle against every neighbour. So the share of the surface (by area,
 * so a library chair of ten thousand triangles does not outvote the floor it stands on) whose
 * triangles have an exactly coplanar neighbour is near one for CAD and near zero for a scan.
 *
 * Reads at most `maxTriangles`, taken from the start of each object, because it runs at
 * import and only needs enough of the mesh to see how it was built.
 */
export function guessSurface(
  nodes: ImportedNode[],
  transform: TransformOptions,
  weldTolerance: number,
  maxTriangles = 200_000,
): SurfaceGuess {
  const leaves: ImportedNode[] = []
  const walk = (ns: ImportedNode[]) => {
    for (const n of ns) {
      if (n.positions.length >= 9) leaves.push(n)
      walk(n.children)
    }
  }
  walk(nodes)
  const total = leaves.reduce((s, n) => s + n.positions.length / 9, 0)
  if (total === 0) return { kind: 'cad', coplanarShare: 1 }
  const keep = Math.min(1, maxTriangles / total)
  let coplanar = 0
  let all = 0
  for (const node of leaves) {
    const tris = Math.max(1, Math.floor((node.positions.length / 9) * keep))
    const positions = applyTransform(node.positions.subarray(0, tris * 9), transform)
    const mesh = weld(positions, weldTolerance)
    const p = prepare(mesh)
    for (let t = 0; t < p.triCount; t++) {
      const a = p.area[t]
      if (!(a > 0)) continue
      all += a
      for (let j = p.adj.start[t]; j < p.adj.start[t + 1]; j++) {
        const s = p.adj.list[j]
        const d =
          p.normal[t * 3] * p.normal[s * 3] + p.normal[t * 3 + 1] * p.normal[s * 3 + 1] + p.normal[t * 3 + 2] * p.normal[s * 3 + 2]
        if (Math.abs(d) >= COPLANAR) {
          coplanar += a
          break
        }
      }
    }
  }
  const coplanarShare = all > 0 ? coplanar / all : 1
  return { kind: coplanarShare < SCAN_SHARE ? 'scan' : 'cad', coplanarShare }
}
