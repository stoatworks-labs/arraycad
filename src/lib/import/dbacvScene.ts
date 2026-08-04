/**
 * Import a .dbacv as if it were a CAD file.
 *
 * Two reasons this exists. It lets an existing ArrayCalc venue be opened, pruned and
 * retyped — which is a real job in itself — and it is the strongest possible test of the
 * viewer, because a venue that draws correctly here and matches ArrayCalc's own picture
 * proves the geometry interpretation is right.
 *
 * RoomObjects are tessellated into triangles for display. Group transforms compose down
 * the tree; see write.ts for the evidence that they must.
 */

import { type RoomObject, type Vec3, Shape } from '../dbacv/types.ts'
import { parseDbacv } from '../dbacv/read.ts'
import type { ImportedNode, ImportedScene } from './types.ts'

let seq = 0
const nextId = () => `dba${++seq}`

interface Xf {
  ox: number
  oy: number
  oz: number
  /** Degrees. */
  rx: number
  ry: number
  rz: number
  sx: number
  sy: number
  sz: number
}

const IDENTITY: Xf = { ox: 0, oy: 0, oz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1 }

/** Apply scale, then XYZ rotation, then translation. */
function apply(p: Vec3, t: Xf): Vec3 {
  let { x, y, z } = { x: p.x * t.sx, y: p.y * t.sy, z: p.z * t.sz }
  const d = Math.PI / 180
  if (t.rx) {
    const c = Math.cos(t.rx * d)
    const s = Math.sin(t.rx * d)
    ;[y, z] = [y * c - z * s, y * s + z * c]
  }
  if (t.ry) {
    const c = Math.cos(t.ry * d)
    const s = Math.sin(t.ry * d)
    ;[x, z] = [x * c + z * s, -x * s + z * c]
  }
  if (t.rz) {
    const c = Math.cos(t.rz * d)
    const s = Math.sin(t.rz * d)
    ;[x, y] = [x * c - y * s, x * s + y * c]
  }
  return { x: x + t.ox, y: y + t.oy, z: z + t.oz }
}

function compose(parent: Xf, o: RoomObject): Xf {
  const local = apply(o.origin, { ...parent, ox: 0, oy: 0, oz: 0 })
  return {
    ox: parent.ox + local.x,
    oy: parent.oy + local.y,
    oz: parent.oz + local.z,
    rx: parent.rx + o.rotation.x,
    ry: parent.ry + o.rotation.y,
    rz: parent.rz + o.rotation.z,
    sx: parent.sx * o.scaling.x,
    sy: parent.sy * o.scaling.y,
    sz: parent.sz * o.scaling.z,
  }
}

const push = (out: number[], p: Vec3) => out.push(p.x, p.y, p.z)

function tri(out: number[], a: Vec3, b: Vec3, c: Vec3) {
  push(out, a)
  push(out, b)
  push(out, c)
}

/**
 * Tessellate an elliptical annulus sector (Shape.Arc).
 *
 * The parameters describe two concentric ellipses — inner and outer, each with its own
 * pair of semi-axes and its own z — swept between StartAngle and StartAngle + SpanAngle.
 * Interpolating z from inner to outer across the ring is what makes this a RAKE: on the
 * fixture's seating tiers InnerZ and OuterZ differ by the rise of the tier.
 */
function tessellateArc(o: RoomObject, xf: Xf, out: number[]): void {
  const a = o.arc
  if (!a) return
  const steps = Math.max(4, Math.ceil(Math.abs(a.spanAngle) / 5))
  const d = Math.PI / 180
  for (let i = 0; i < steps; i++) {
    const t0 = (a.startAngle + (a.spanAngle * i) / steps) * d
    const t1 = (a.startAngle + (a.spanAngle * (i + 1)) / steps) * d
    const at = (ang: number, ra: number, rb: number, z: number): Vec3 =>
      apply({ x: Math.cos(ang) * ra, y: Math.sin(ang) * rb, z }, xf)
    const i0 = at(t0, a.innerRadiusA, a.innerRadiusB, a.innerZ)
    const i1 = at(t1, a.innerRadiusA, a.innerRadiusB, a.innerZ)
    const o0 = at(t0, a.outerRadiusA, a.outerRadiusB, a.outerZ)
    const o1 = at(t1, a.outerRadiusA, a.outerRadiusB, a.outerZ)
    tri(out, i0, o0, o1)
    tri(out, i0, o1, i1)
  }
}

/** Tessellate one RoomObject's own geometry (not its children) into `out`. */
export function tessellate(o: RoomObject, xf: Xf, out: number[]): void {
  const p = o.points.map((q) => apply(q, xf))
  switch (o.shape) {
    case Shape.Triangle:
      if (p.length >= 3) tri(out, p[0], p[1], p[2])
      break
    case Shape.Quad:
      if (p.length >= 4) {
        tri(out, p[0], p[1], p[2])
        tri(out, p[0], p[2], p[3])
      }
      break
    case Shape.Box:
      if (p.length >= 8) {
        const faces = [
          [0, 1, 2, 3], // bottom
          [4, 5, 6, 7], // top
          [0, 1, 5, 4],
          [1, 2, 6, 5],
          [2, 3, 7, 6],
          [3, 0, 4, 7],
        ]
        for (const f of faces) {
          tri(out, p[f[0]], p[f[1]], p[f[2]])
          tri(out, p[f[0]], p[f[2]], p[f[3]])
        }
      }
      break
    case Shape.Arc:
      tessellateArc(o, xf, out)
      break
    case Shape.Group:
      break
  }
}

function toNode(o: RoomObject, parent: Xf): ImportedNode {
  const xf = compose(parent, o)
  const tris: number[] = []
  tessellate(o, xf, tris)
  return {
    id: nextId(),
    name: o.name,
    tags: [`shape:${Shape[o.shape]}`, `planeType:${o.planeType}`],
    positions: new Float64Array(tris),
    suggestedPlaneType: o.shape === Shape.Group ? undefined : o.planeType,
    children: o.children.map((c) => toNode(c, xf)),
  }
}

export function importDbacvAsScene(
  xml: string,
  filename: string,
  parser?: DOMParser,
): ImportedScene {
  const venue = parseDbacv(xml, parser)
  return {
    format: 'ArrayCalc venue',
    alreadyAVenue: true,
    sourceName: filename.replace(/\.[^.]+$/, ''),
    unitsPerMetre: 1,
    upAxis: 'z',
    nodes: venue.objects.map((o) => toNode(o, IDENTITY)),
    warnings: [
      'Re-importing a venue tessellates every object into triangles and rebuilds it from ' +
        'planes. Arc segments and boxes come back as flat quads, so a round trip through ' +
        'here is not lossless — use it to prune and retype, not to preserve.',
    ],
  }
}

/** Parse without tessellating, for the "keep original geometry" export path. */
export function importDbacvExact(xml: string, parser?: DOMParser) {
  return parseDbacv(xml, parser)
}
