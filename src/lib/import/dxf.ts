/**
 * DXF importer.
 *
 * DXF is what a venue actually hands you, and it is the awkward one: it is an entity list,
 * not a mesh, and most venue drawings are 2D plans with no z at all. Two jobs here — turn
 * the 3D entities into triangles, and turn flat closed outlines into planes at an
 * elevation the user supplies, which is how a seating block or a balcony gets into
 * ArrayCalc from a plan drawing.
 *
 * Entities handled: 3DFACE, POLYLINE (polyface mesh and plain), LWPOLYLINE, SOLID, CIRCLE,
 * ARC, and INSERT including its row/column array. Field names below are taken from
 * dxf-parser's own entity handlers, not from the DXF spec — the two disagree in places
 * and the parser is what we are actually reading.
 */

import DxfParser from 'dxf-parser'
import { type ImportedNode, type ImportedScene, ImportError } from './types.ts'

let seq = 0
const nextId = () => `dxf${++seq}`

interface P3 {
  x: number
  y: number
  z: number
}

const pt = (v: { x?: number; y?: number; z?: number } | undefined): P3 => ({
  x: v?.x ?? 0,
  y: v?.y ?? 0,
  z: v?.z ?? 0,
})

/**
 * DXF $INSUNITS code -> metres per unit.
 *
 * Code 0 is "unitless" and is by far the most common value in drawings that arrive from
 * the trade. It tells us nothing, so it maps to undefined and the user picks.
 */
const INSUNITS: Record<number, number | undefined> = {
  0: undefined,
  1: 0.0254, // inches
  2: 0.3048, // feet
  3: 1609.344, // miles
  4: 0.001, // millimetres
  5: 0.01, // centimetres
  6: 1, // metres
  7: 1000, // kilometres
  8: 2.54e-8, // microinches
  9: 2.54e-5, // mils
  10: 0.9144, // yards
  11: 1e-10, // angstroms
  12: 1e-9, // nanometres
  13: 1e-6, // microns
  14: 0.1, // decimetres
  15: 10, // decametres
  16: 100, // hectometres
}

function fanTriangulate(loop: P3[], out: number[]): void {
  if (loop.length < 3) return
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

export interface DxfOptions {
  /**
   * SOURCE UNITS, not metres. Height given to a closed flat outline, so a plan-only
   * drawing still produces something usable: 0 leaves it as a floor, non-zero turns it
   * into a vertical band — a wall. Both are wanted, which is why it is a setting.
   */
  extrudeFlatTo: number
  /** Treat open polylines as closed. Off by default: most open paths are dimension lines. */
  includeOpenPaths: boolean
}

export const DEFAULT_DXF_OPTIONS: DxfOptions = { extrudeFlatTo: 0, includeOpenPaths: false }

/* eslint-disable @typescript-eslint/no-explicit-any */
type Entity = any

function emitPath(verts: P3[], closed: boolean, out: number[], opts: DxfOptions): void {
  if (verts.length < 3) return
  if (!closed && !opts.includeOpenPaths) return

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
  fanTriangulate(verts, out)
}

function emitEntity(
  e: Entity,
  ctx: Ctx,
  out: number[],
  blocks: Record<string, Entity>,
  opts: DxfOptions,
  warn: Set<string>,
): void {
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

      emitPath(
        verts.map((v) => xform(pt(v), ctx)),
        Boolean(e.shape),
        out,
        opts,
      )
      break
    }

    case 'LWPOLYLINE': {
      const z = e.elevation ?? 0
      const verts: P3[] = (e.vertices ?? []).map((v: Entity) =>
        xform({ x: v.x ?? 0, y: v.y ?? 0, z }, ctx),
      )
      if ((e.vertices ?? []).some((v: Entity) => v.bulge)) {
        warn.add('Some polylines have curved (bulged) segments; those were read as straight.')
      }
      emitPath(verts, Boolean(e.shape), out, opts)
      break
    }

    case 'CIRCLE':
    case 'ARC': {
      const c = pt(e.center)
      const r = e.radius ?? 0
      if (r <= 0) break
      // dxf-parser has already converted these to radians.
      const start = e.startAngle ?? 0
      const sweep = e.type === 'CIRCLE' ? Math.PI * 2 : (e.angleLength ?? Math.PI * 2)
      const steps = Math.max(8, Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * 36))
      const loop: P3[] = []
      for (let i = 0; i <= steps; i++) {
        const a = start + (sweep * i) / steps
        loop.push(xform({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r, z: c.z }, ctx))
      }
      fanTriangulate(loop, out)
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
          for (const sub of block.entities) emitEntity(sub, inner, out, blocks, opts, warn)
        }
      }
      break
    }

    case 'LINE':
    case 'TEXT':
    case 'MTEXT':
    case 'ATTDEF':
    case 'DIMENSION':
    case 'POINT':
      break

    case 'SPLINE':
      warn.add('SPLINE entities were skipped. Convert splines to polylines and re-export.')
      break

    case 'ELLIPSE':
      warn.add('ELLIPSE entities were skipped. Convert them to polylines and re-export.')
      break

    default:
      if (e.type) warn.add(`Skipped unsupported DXF entity type ${e.type}.`)
  }
}

export function importDxf(
  text: string,
  filename: string,
  options: Partial<DxfOptions> = {},
): ImportedScene {
  const opts = { ...DEFAULT_DXF_OPTIONS, ...options }
  let dxf: Entity
  try {
    dxf = new DxfParser().parseSync(text)
  } catch (e) {
    throw new ImportError(
      `Could not parse this DXF: ${(e as Error).message}`,
      'Save it as ASCII DXF (R2013 or earlier is safest). Binary DXF and DWG cannot be read ' +
        'here — from AutoCAD use SAVEAS and pick a DXF format.',
    )
  }
  if (!dxf?.entities) throw new ImportError('That DXF has no ENTITIES section.')

  const warn = new Set<string>()
  const blocks: Record<string, Entity> = dxf.blocks ?? {}

  // Group by layer: in a venue drawing the layer IS the semantic object — SEATING,
  // BALCONY, CEILING — which makes it the right handle for pruning and type assignment.
  const byLayer = new Map<string, number[]>()
  for (const e of dxf.entities) {
    const layer = String(e.layer ?? '0')
    let bucket = byLayer.get(layer)
    if (!bucket) {
      bucket = []
      byLayer.set(layer, bucket)
    }
    emitEntity(e, IDENTITY, bucket, blocks, opts, warn)
  }

  const nodes: ImportedNode[] = []
  for (const [layer, tris] of [...byLayer].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (tris.length === 0) continue
    nodes.push({
      id: nextId(),
      name: layer,
      tags: [`layer:${layer}`],
      positions: new Float64Array(tris),
      children: [],
    })
  }

  if (nodes.length === 0) {
    throw new ImportError(
      'That DXF parsed but produced no surfaces.',
      'It is most likely a 2D drawing made of open lines. Either close the outlines you ' +
        'want as polylines, or switch on "treat open paths as closed" and set an ' +
        'extrusion height.',
    )
  }

  const insunits = dxf.header?.$INSUNITS
  const unitsPerMetre = typeof insunits === 'number' ? INSUNITS[insunits] : undefined
  if (unitsPerMetre === undefined) {
    warn.add('This DXF does not declare its units ($INSUNITS is 0 or absent). Set them yourself.')
  }

  return {
    format: 'DXF',
    sourceName: filename.replace(/\.[^.]+$/, ''),
    unitsPerMetre,
    // DXF world coordinates are Z-up; nothing in the header says otherwise.
    upAxis: 'z',
    nodes,
    warnings: [...warn],
  }
}
