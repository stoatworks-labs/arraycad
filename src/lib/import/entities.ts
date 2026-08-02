/**
 * The shared half of every vector-CAD importer: entities -> triangles.
 *
 * DXF and DWG are the same drawing model wearing different clothes. DXF is that model
 * written out as tagged text; DWG is it written out as a bitstream. Once a parser has
 * turned either one into an entity list, everything that follows — expanding blocks,
 * flattening curves, chaining loose segments back into rings, filling them, and bucketing
 * the result by layer — is identical, and it is by far the larger and more delicate half.
 *
 * So it lives here once. `dxf.ts` and `dwg.ts` are each only a translation from their own
 * parser's shape into `CadDocument`, and neither owns any geometry. A second copy of this
 * reduction would drift from the first the way the TypeScript and Python writers already
 * did once (AGENTS.md section 6).
 *
 * The central problem it solves: a plan drawing contains no surfaces. A seating block is
 * not a closed polyline — it is forty separate LINE and ARC entities whose endpoints
 * happen to coincide. Recovering the rings from those is `chain.ts`, and without it a
 * seating plan imports as nothing at all.
 */

import earcut from 'earcut'
import { type ImportedNode, ImportError } from './types.ts'
import { chainSegments, newellNormal, ringArea } from './chain.ts'
import type { Vec3 } from '../geom/vec.ts'
import { add, cross, dot, len, normalize, scale, sub, v3 } from '../geom/vec.ts'

let seq = 0
const nextId = () => `dxf${++seq}`

type P3 = Vec3

const pt = (v: { x?: number; y?: number; z?: number } | undefined): P3 => ({
  x: v?.x ?? 0,
  y: v?.y ?? 0,
  z: v?.z ?? 0,
})

/** Segments per full turn when a curve is flattened. */
const ARC_RESOLUTION = 72

function fanTriangulate(loop: P3[], out: number[]): void {
  if (loop.length < 3) return
  // A triangle is already a triangle. Fanning one about its own centroid tiles it with
  // three slivers that mean the same thing and cost three times as much, and it makes the
  // triangle count depend on which parser delivered the face.
  if (loop.length === 3) {
    for (const p of loop) out.push(p.x, p.y, p.z)
    return
  }
  let cx = 0
  let cy = 0
  let cz = 0
  for (const p of loop) {
    cx += p.x
    cy += p.y
    cz += p.z
  }
  cx /= loop.length
  cy /= loop.length
  cz /= loop.length
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]
    const b = loop[(i + 1) % loop.length]
    out.push(cx, cy, cz, a.x, a.y, a.z, b.x, b.y, b.z)
  }
}

/**
 * Triangulate a closed ring properly, in its own plane.
 *
 * A fan about the centroid is only correct for a convex ring. An auditorium outline is
 * deeply concave, and a centroid fan of one lays triangles across the empty middle of the
 * room — which then merge into a single coplanar region whose recovered boundary is the
 * convex hull, not the room. Chaining makes concave rings the common case, so the fill has
 * to be a real triangulation.
 */
function fillLoop(ring: P3[], out: number[]): void {
  if (ring.length < 3) return
  const nv = newellNormal(ring)
  const nl = len(nv)
  if (nl < 1e-18) return
  const n = scale(nv, 1 / nl)

  let extent = 0
  for (const p of ring) extent = Math.max(extent, len(sub(p, ring[0])))
  // A ring that is not flat cannot be projected without folding it. Fan it instead: it is
  // wrong in a different way, but it is wrong locally rather than inventing a surface.
  for (const p of ring) {
    if (Math.abs(dot(sub(p, ring[0]), n)) > Math.max(1e-9, extent * 1e-3)) {
      fanTriangulate(ring, out)
      return
    }
  }

  const ax = Math.abs(n.x)
  const ay = Math.abs(n.y)
  const az = Math.abs(n.z)
  const seed = ax <= ay && ax <= az ? v3(1, 0, 0) : ay <= az ? v3(0, 1, 0) : v3(0, 0, 1)
  const u = normalize(cross(seed, n))
  const v = cross(n, u)

  const flat: number[] = []
  for (const p of ring) {
    const d = sub(p, ring[0])
    flat.push(dot(d, u), dot(d, v))
  }
  const idx = earcut(flat, [], 2)
  if (idx.length === 0) {
    fanTriangulate(ring, out)
    return
  }
  for (const k of idx) {
    const p = ring[k]
    out.push(p.x, p.y, p.z)
  }
}

const same = (a: P3, b: P3) => a.x === b.x && a.y === b.y && a.z === b.z

/** A 4-corner face. A 4th vertex equal to the 3rd marks a triangle, per the DXF spec. */
function quadOrTri(a: P3, b: P3, c: P3, d: P3, out: number[]): void {
  out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
  if (!same(d, c) && !same(d, a)) out.push(a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z)
}

interface Ctx {
  ox: number
  oy: number
  oz: number
  sx: number
  sy: number
  sz: number
  /** Degrees. */
  rot: number
  depth: number
}

const IDENTITY: Ctx = { ox: 0, oy: 0, oz: 0, sx: 1, sy: 1, sz: 1, rot: 0, depth: 0 }

function xform(p: P3, c: Ctx): P3 {
  const r = (c.rot * Math.PI) / 180
  const x = p.x * c.sx
  const y = p.y * c.sy
  return {
    x: x * Math.cos(r) - y * Math.sin(r) + c.ox,
    y: x * Math.sin(r) + y * Math.cos(r) + c.oy,
    z: p.z * c.sz + c.oz,
  }
}

export interface CadOptions {
  /**
   * SOURCE UNITS, not metres. Height given to a closed flat outline, so a plan-only
   * drawing still produces something usable: 0 leaves it as a floor, non-zero turns it
   * into a vertical band — a wall. Both are wanted, which is why it is a setting.
   */
  extrudeFlatTo: number
  /**
   * Force-close paths that did not chain into a ring. Off by default: what is left over
   * after chaining is mostly dimension lines and leaders, and closing those invents
   * surfaces that are not in the drawing.
   */
  includeOpenPaths: boolean
  /**
   * Chain loose LINE/ARC/open-polyline segments into closed rings. This is what makes a
   * 2D plan importable; leave it on unless a drawing chains into nonsense.
   */
  chainSegments: boolean
  /**
   * SOURCE UNITS. Endpoints this close are the same node when chaining. 0 means derive it
   * from the drawing's own extent, which is right far more often than any fixed value —
   * the same drawing exports in inches or in millimetres.
   */
  chainTolerance: number
}

export const DEFAULT_CAD_OPTIONS: CadOptions = {
  extrudeFlatTo: 0,
  includeOpenPaths: false,
  chainSegments: true,
  chainTolerance: 0,
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Entity = any

/** Where a layer's geometry accumulates while its entities are walked. */
interface Sink {
  /** Triangle soup: 9 numbers per triangle. */
  tris: number[]
  /** Open paths awaiting chaining, in world space. */
  paths: P3[][]
}

/**
 * Points along an arc, in the entity's own coordinates.
 *
 * `sweep` is signed; the caller is responsible for having worked out the direction, which
 * differs between ARC (always counter-clockwise) and a polyline bulge (signed).
 */
function arcPoints(cx: number, cy: number, cz: number, r: number, start: number, sweep: number): P3[] {
  const steps = Math.max(2, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * ARC_RESOLUTION))
  const out: P3[] = []
  for (let i = 0; i <= steps; i++) {
    const a = start + (sweep * i) / steps
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r, z: cz })
  }
  return out
}

/**
 * Flatten one bulged polyline segment.
 *
 * A bulge is the tangent of a quarter of the included angle, negative when the arc runs
 * clockwise. The centre sits on the chord's perpendicular bisector at a signed distance
 * of half the chord times cot(theta/2) along the chord's LEFT normal — which is zero for a
 * semicircle and flips sign for a reflex arc, so the one expression covers every case.
 *
 * Returns the intermediate points only; the caller already has the two endpoints.
 */
function bulgePoints(p1: P3, p2: P3, bulge: number): P3[] {
  const theta = 4 * Math.atan(bulge)
  if (!Number.isFinite(theta) || Math.abs(theta) < 1e-12) return []
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const chord = Math.hypot(dx, dy)
  if (chord < 1e-12) return []

  const half = theta / 2
  const sinHalf = Math.sin(half)
  if (Math.abs(sinHalf) < 1e-12) return []
  const r = chord / (2 * sinHalf)
  const d = (chord / 2) * (Math.cos(half) / sinHalf)
  const ux = dx / chord
  const uy = dy / chord
  const cx = (p1.x + p2.x) / 2 - uy * d
  const cy = (p1.y + p2.y) / 2 + ux * d

  const startAngle = Math.atan2(p1.y - cy, p1.x - cx)
  const pts = arcPoints(cx, cy, p1.z, Math.abs(r), startAngle, theta)
  return pts.slice(1, -1)
}

/** de Boor evaluation of a B-spline at parameter `t`. */
function deBoor(cps: P3[], knots: number[], degree: number, t: number): P3 {
  const n = cps.length - 1
  let span = degree
  while (span < n && knots[span + 1] <= t) span++

  const d: P3[] = []
  for (let j = 0; j <= degree; j++) d.push(cps[Math.min(Math.max(span - degree + j, 0), n)])
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = span - degree + j
      const denom = knots[i + degree - r + 1] - knots[i]
      const alpha = denom === 0 ? 0 : (t - knots[i]) / denom
      d[j] = add(scale(d[j - 1], 1 - alpha), scale(d[j], alpha))
    }
  }
  return d[degree]
}

/**
 * Flatten a SPLINE.
 *
 * Curved balcony fronts arrive as splines constantly, so skipping them loses exactly the
 * edge the venue cares about. Where the knot vector is present the curve is evaluated
 * properly; where it is not, the fit points are the draughtsman's own approximation and
 * are a better fallback than the control polygon, which cuts corners the curve does not.
 */
function splinePoints(e: Entity): P3[] {
  const cps: P3[] = (e.controlPoints ?? []).map(pt)
  const fits: P3[] = (e.fitPoints ?? []).map(pt)
  const degree: number = e.degreeOfSplineCurve ?? 3
  const knots: number[] = e.knotValues ?? []

  if (cps.length > degree && knots.length === cps.length + degree + 1) {
    const t0 = knots[degree]
    const t1 = knots[cps.length]
    if (t1 > t0) {
      const steps = Math.max(16, Math.min(256, cps.length * 8))
      const out: P3[] = []
      for (let i = 0; i <= steps; i++) {
        // Nudge off the very end: at t === t1 the span search runs one past the last
        // usable span and de Boor reads an undefined knot.
        const t = t0 + ((t1 - t0) * i) / steps
        out.push(deBoor(cps, knots, degree, Math.min(t, t1 - (t1 - t0) * 1e-9)))
      }
      return out
    }
  }
  if (fits.length >= 2) return fits
  return cps
}

/** Flatten an ELLIPSE or elliptical arc. */
function ellipsePoints(e: Entity): P3[] {
  const c = pt(e.center)
  const major = pt(e.majorAxisEndPoint)
  const ratio: number = e.axisRatio ?? 1
  const a = Math.hypot(major.x, major.y, major.z)
  if (a < 1e-12) return []
  const start: number = e.startAngle ?? 0
  const end: number = e.endAngle ?? Math.PI * 2
  let sweep = end - start
  if (sweep <= 1e-12) sweep += Math.PI * 2

  // The minor axis is the major turned a quarter turn in the ellipse's own plane. DXF
  // gives the plane only through the extrusion direction, and for the plan drawings this
  // matters for that is always +Z.
  const u = { x: major.x / a, y: major.y / a, z: major.z / a }
  const v = { x: -u.y, y: u.x, z: 0 }
  const b = a * ratio

  const steps = Math.max(8, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * ARC_RESOLUTION))
  const out: P3[] = []
  for (let i = 0; i <= steps; i++) {
    const t = start + (sweep * i) / steps
    const ca = Math.cos(t) * a
    const sb = Math.sin(t) * b
    out.push({
      x: c.x + u.x * ca + v.x * sb,
      y: c.y + u.y * ca + v.y * sb,
      z: c.z + u.z * ca,
    })
  }
  return out
}

const isClosedSweep = (sweep: number) => Math.abs(Math.abs(sweep) - Math.PI * 2) < 1e-9

/**
 * A path that is already closed gets filled; one that is not goes to the chainer.
 *
 * Extrusion applies only to a genuinely flat ring, because a vertical band raised off a
 * ring that is not level is not a wall, it is a ribbon.
 */
function emitRing(verts: P3[], out: number[], opts: CadOptions): void {
  if (verts.length < 3) return
  if (opts.extrudeFlatTo !== 0) {
    const flat = verts.every((p) => Math.abs(p.z - verts[0].z) < 1e-9)
    if (flat) {
      const top = verts.map((p) => ({ ...p, z: p.z + opts.extrudeFlatTo }))
      for (let i = 0; i < verts.length; i++) {
        const j = (i + 1) % verts.length
        quadOrTri(verts[i], verts[j], top[j], top[i], out)
      }
      return
    }
  }
  fillLoop(verts, out)
}

/** Send an open path to the chainer, or fill it now if chaining is switched off. */
function emitOpen(verts: P3[], sink: Sink, opts: CadOptions): void {
  if (verts.length < 2) return
  if (opts.chainSegments) {
    sink.paths.push(verts)
    return
  }
  if (opts.includeOpenPaths) emitRing(verts, sink.tris, opts)
}

function emitEntity(
  e: Entity,
  ctx: Ctx,
  sink: Sink,
  blocks: Record<string, Entity>,
  opts: CadOptions,
  warn: Set<string>,
): void {
  const out = sink.tris

  switch (e.type) {
    case '3DFACE': {
      const v: P3[] = (e.vertices ?? []).map((p: P3) => xform(pt(p), ctx))
      if (v.length >= 4) quadOrTri(v[0], v[1], v[2], v[3], out)
      else if (v.length === 3) fanTriangulate(v, out)
      break
    }

    case 'SOLID': {
      const v: P3[] = (e.points ?? []).filter(Boolean).map((p: P3) => xform(pt(p), ctx))
      // A SOLID's vertex order is 1,2,4,3 — a Z, not a ring. Walking it in file order
      // makes a bow tie whose two halves cancel to zero area and vanish at the minArea
      // check, so the entity silently disappears.
      if (v.length >= 4) quadOrTri(v[0], v[1], v[3], v[2], out)
      else if (v.length === 3) fanTriangulate(v, out)
      break
    }

    case 'LINE': {
      const a = xform(pt(e.vertices?.[0] ?? e.start), ctx)
      const b = xform(pt(e.vertices?.[1] ?? e.end), ctx)
      emitOpen([a, b], sink, opts)
      break
    }

    case 'POLYLINE': {
      const verts: Entity[] = e.vertices ?? []

      // dxf-parser gives a VERTEX faceA..faceD (group codes 71-74) only on face records.
      // Presence of faceA is therefore the discriminator between a face record and a
      // coordinate vertex — more reliable than the 64/128 flag combination, which real
      // files set inconsistently.
      const faceRecords = verts.filter((v) => v.faceA !== undefined)
      if (faceRecords.length > 0) {
        const coords = verts.filter((v) => v.faceA === undefined)
        for (const f of faceRecords) {
          // Indices are 1-based; a negative index means the edge is invisible, not that
          // the vertex differs, so take the magnitude.
          const idx = [f.faceA, f.faceB, f.faceC, f.faceD]
            .filter((n): n is number => typeof n === 'number' && n !== 0)
            .map((n) => Math.abs(n) - 1)
            .filter((i) => i >= 0 && i < coords.length)
          if (idx.length < 3) continue
          const p = idx.map((i) => xform(pt(coords[i]), ctx))
          if (p.length >= 4) quadOrTri(p[0], p[1], p[2], p[3], out)
          else fanTriangulate(p, out)
        }
        break
      }

      if (e.is3dPolygonMesh) {
        // An M x N polygon mesh needs group codes 71/72 for its row and column counts, and
        // dxf-parser discards those. Without them the vertex list cannot be re-gridded, so
        // say so rather than emit a wrong surface.
        warn.add(
          'A 3D polygon mesh (M x N POLYLINE) was skipped — its grid dimensions are not ' +
            'available from the parser. Explode it to 3DFACEs and re-export.',
        )
        break
      }

      const closed = Boolean(e.shape)
      const path = flattenBulged(verts.map(pt), verts, closed, ctx)
      if (closed) emitRing(path, out, opts)
      else emitOpen(path, sink, opts)
      break
    }

    case 'POLYFACE': {
      // Already reduced to corner lists by whichever importer produced it, because the
      // two parsers describe a polyface mesh in quite different ways and neither shape is
      // worth carrying this far in.
      for (const face of e.faces ?? []) {
        const p: P3[] = face.map((q: P3) => xform(pt(q), ctx))
        if (p.length >= 4) quadOrTri(p[0], p[1], p[2], p[3], out)
        else if (p.length === 3) fanTriangulate(p, out)
      }
      break
    }

    case 'LWPOLYLINE': {
      const z = e.elevation ?? 0
      const raw: Entity[] = e.vertices ?? []
      const local: P3[] = raw.map((v: Entity) => ({ x: v.x ?? 0, y: v.y ?? 0, z }))
      const closed = Boolean(e.shape)
      const path = flattenBulged(local, raw, closed, ctx)
      if (closed) emitRing(path, out, opts)
      else emitOpen(path, sink, opts)
      break
    }

    case 'CIRCLE': {
      const c = pt(e.center)
      const r = e.radius ?? 0
      if (r <= 0) break
      const loop = arcPoints(c.x, c.y, c.z, r, 0, Math.PI * 2)
      loop.pop() // the closing point repeats the first
      emitRing(loop.map((p) => xform(p, ctx)), out, opts)
      break
    }

    case 'ARC': {
      const c = pt(e.center)
      const r = e.radius ?? 0
      if (r <= 0) break
      // dxf-parser has already converted these to radians.
      const start = e.startAngle ?? 0
      // An ARC with no end angle (group code 51) is malformed. Treating the gap as a full
      // turn silently fills in a whole disc, which on a venue plan is a solid circle of
      // seating tens of metres across that nobody drew. Writers do get this wrong — one
      // seen in the wild puts the end angle in group code 60, which is the visibility
      // flag — so say so rather than invent the geometry.
      if (e.angleLength === undefined) {
        warn.add(
          'An ARC has no end angle (group code 51) and was skipped. The drawing was written ' +
            'with a malformed arc; re-export it from CAD.',
        )
        break
      }
      // A DXF arc ALWAYS sweeps counter-clockwise from start to end, so an arc that runs
      // past zero (start 340 degrees, end 20) has a sweep of +40. dxf-parser stores a bare
      // `endAngle - startAngle` and hands back -320 instead, which draws the complement of
      // the arc — the long way round the circle, covering none of the same ground. Its own
      // CIRCLE handler normalises this and its ARC handler does not, so it has to be done
      // here. On a curved seating plan this is most of the arcs.
      let sweep = e.angleLength
      if (sweep <= 0) sweep += Math.PI * 2
      const pts = arcPoints(c.x, c.y, c.z, r, start, sweep).map((p) => xform(p, ctx))
      // An arc is a boundary, not a region. Filling it as a pie sector — which is what a
      // centroid fan does — invents a wedge of floor that is not in the drawing, and on a
      // seat-back arc the wedge is a sliver of near-zero area that is dropped later
      // anyway. Both outcomes are wrong; it belongs in the chain.
      if (isClosedSweep(sweep)) emitRing(pts.slice(0, -1), out, opts)
      else emitOpen(pts, sink, opts)
      break
    }

    case 'ELLIPSE': {
      const pts = ellipsePoints(e).map((p) => xform(p, ctx))
      if (pts.length < 2) break
      const start: number = e.startAngle ?? 0
      const end: number = e.endAngle ?? Math.PI * 2
      if (isClosedSweep(end - start)) emitRing(pts.slice(0, -1), out, opts)
      else emitOpen(pts, sink, opts)
      break
    }

    case 'SPLINE': {
      const pts = splinePoints(e).map((p) => xform(p, ctx))
      if (pts.length < 2) break
      if (e.closed) emitRing(pts, out, opts)
      else emitOpen(pts, sink, opts)
      break
    }

    case 'INSERT': {
      // A block that references itself, directly or through a chain, recurses for ever.
      // Real drawings do contain these.
      if (ctx.depth > 16) {
        warn.add('Block nesting past 16 levels was truncated — there may be a circular reference.')
        break
      }
      const block = blocks[e.name]
      if (!block?.entities) break

      const p = pt(e.position)
      // A block's own base point is subtracted before placement, otherwise every instance
      // of a block drawn away from its own origin lands at the wrong offset.
      const basePoint = pt(block.position)
      const cols = Math.max(1, e.columnCount ?? 1)
      const rows = Math.max(1, e.rowCount ?? 1)
      const colSpacing = e.columnSpacing ?? 0
      const rowSpacing = e.rowSpacing ?? 0
      if (cols * rows > 10000) {
        warn.add(`Block "${e.name}" is arrayed ${cols}x${rows} times; that was skipped as runaway.`)
        break
      }

      for (let ci = 0; ci < cols; ci++) {
        for (let ri = 0; ri < rows; ri++) {
          const local = xform(
            {
              x: p.x - basePoint.x + ci * colSpacing,
              y: p.y - basePoint.y + ri * rowSpacing,
              z: p.z - basePoint.z,
            },
            ctx,
          )
          const inner: Ctx = {
            ox: local.x,
            oy: local.y,
            oz: local.z,
            sx: ctx.sx * (e.xScale ?? 1),
            sy: ctx.sy * (e.yScale ?? 1),
            sz: ctx.sz * (e.zScale ?? 1),
            rot: ctx.rot + (e.rotation ?? 0),
            depth: ctx.depth + 1,
          }
          for (const sub of block.entities) emitEntity(sub, inner, sink, blocks, opts, warn)
        }
      }
      break
    }

    case 'TEXT':
    case 'MTEXT':
    case 'ATTDEF':
    case 'ATTRIB':
    case 'DIMENSION':
    case 'LEADER':
    case 'POINT':
    case 'SEQEND':
    case 'VIEWPORT':
      break

    default:
      if (e.type) warn.add(`Skipped unsupported DXF entity type ${e.type}.`)
  }
}

/**
 * Expand a polyline's bulged segments into arcs, then place the result in world space.
 *
 * `raw` is the parser's own vertex list, which carries the bulge; `local` is the same
 * vertices already reduced to points. They stay in step by index.
 */
function flattenBulged(local: P3[], raw: Entity[], closed: boolean, ctx: Ctx): P3[] {
  const out: P3[] = []
  const n = local.length
  if (n === 0) return out
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const a = local[i]
    const b = local[(i + 1) % n]
    out.push(a)
    const bulge = raw[i]?.bulge
    if (typeof bulge === 'number' && bulge !== 0) out.push(...bulgePoints(a, b, bulge))
  }
  if (!closed) out.push(local[n - 1])
  return out.map((p) => xform(p, ctx))
}

/** Longest diagonal of everything collected, used to size the chain tolerance. */
function extentOf(sinks: Iterable<Sink>): number {
  let mnx = Infinity
  let mny = Infinity
  let mnz = Infinity
  let mxx = -Infinity
  let mxy = -Infinity
  let mxz = -Infinity
  const see = (x: number, y: number, z: number) => {
    if (x < mnx) mnx = x
    if (y < mny) mny = y
    if (z < mnz) mnz = z
    if (x > mxx) mxx = x
    if (y > mxy) mxy = y
    if (z > mxz) mxz = z
  }
  for (const s of sinks) {
    for (let i = 0; i + 2 < s.tris.length; i += 3) see(s.tris[i], s.tris[i + 1], s.tris[i + 2])
    for (const path of s.paths) for (const p of path) see(p.x, p.y, p.z)
  }
  if (!Number.isFinite(mnx)) return 0
  return Math.hypot(mxx - mnx, mxy - mny, mxz - mnz)
}


/**
 * What an importer must hand over: an entity list and the blocks it refers to.
 *
 * Deliberately the DXF entity vocabulary — 'LINE', 'ARC', `vertices`, `bulge` — because
 * that vocabulary is the interchange language every CAD format is described in, and DWG's
 * own model maps onto it one for one. It is a translation target, not a file format.
 */
export interface CadBlock {
  /** The block's own base point, subtracted before an INSERT places it. */
  position?: { x?: number; y?: number; z?: number }
  entities?: Entity[]
}

export interface CadDocument {
  entities: Entity[]
  blocks: Record<string, CadBlock>
}

/**
 * Entities -> one node per layer.
 *
 * Grouping by layer is not a convenience: in a venue drawing the layer IS the semantic
 * object — SEATING, BALCONY, CEILING — which makes it the right handle for pruning and
 * for assigning plane types.
 */
export function buildNodes(
  doc: CadDocument,
  options: Partial<CadOptions>,
  warn: Set<string>,
): ImportedNode[] {
  const opts = { ...DEFAULT_CAD_OPTIONS, ...options }
  const blocks = doc.blocks ?? {}

  const byLayer = new Map<string, Sink>()
  for (const e of doc.entities) {
    const layer = String(e.layer ?? '0')
    let sink = byLayer.get(layer)
    if (!sink) {
      sink = { tris: [], paths: [] }
      byLayer.set(layer, sink)
    }
    emitEntity(e, IDENTITY, sink, blocks, opts, warn)
  }

  if (opts.chainSegments) {
    // One tolerance for the whole drawing, not per layer: a layer holding a single short
    // wall would otherwise get a tolerance so tight that nothing welds.
    const extent = extentOf(byLayer.values())
    const tolerance = opts.chainTolerance > 0 ? opts.chainTolerance : Math.max(1e-9, extent * 1e-6)

    let chained = 0
    let leftOver = 0
    for (const sink of byLayer.values()) {
      if (sink.paths.length === 0) continue
      const { loops, open } = chainSegments(sink.paths, { tolerance })
      for (const ring of loops) {
        // A ring of no area is a path doubled back on itself, not a surface.
        if (ringArea(ring) <= 0) continue
        emitRing(ring, sink.tris, opts)
        chained++
      }
      leftOver += open.length
      if (opts.includeOpenPaths) {
        for (const path of open) emitRing(path, sink.tris, opts)
      }
    }
    if (chained > 0) {
      warn.add(
        `Recovered ${chained} closed outline${chained === 1 ? '' : 's'} by joining loose lines ` +
          'and arcs. Check the result against the drawing before exporting.',
      )
    }
    if (leftOver > 0 && !opts.includeOpenPaths) {
      warn.add(
        `${leftOver} path${leftOver === 1 ? '' : 's'} did not join up into a closed outline and ` +
          'were left out. Switch on "treat open paths as closed" if any of them were wanted.',
      )
    }
  }

  const nodes: ImportedNode[] = []
  for (const [layer, sink] of [...byLayer].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (sink.tris.length === 0) continue
    nodes.push({
      id: nextId(),
      name: layer,
      tags: [`layer:${layer}`],
      positions: new Float64Array(sink.tris),
      children: [],
    })
  }
  return nodes
}

/** The same dead end for every vector format, so the advice is written once. */
export function noSurfacesError(format: string): ImportError {
  return new ImportError(
    `That ${format} parsed but produced no surfaces.`,
    'It is most likely a 2D drawing whose lines do not join up into closed shapes. Either ' +
      'close the outlines you want as polylines, or switch on "treat open paths as closed" ' +
      'and set an extrusion height.',
  )
}
