/**
 * 3DSOLID import: ACIS bodies reduced to their outer volume.
 *
 * The fixtures are written here rather than cut out of a real drawing, and in the shapes the
 * real one had: a truss section is a body whose vertices sit in its own frame and whose
 * `transform` record places it, in a DXF R2004 the SAT text is ciphered, and in a DWG the
 * same body arrives as SAB bytes — including from a reader that labelled SAB as text.
 */

import { describe, expect, it } from 'vitest'
import { acisPoints, decodeSat, satPoints } from './acis.ts'
import { importDxf } from './dxf.ts'

/** The inverse of `decodeSat`, per ezdxf's `crypt.encode`. */
function encodeSat(line: string): string {
  let out = ''
  for (const ch of line) {
    const c = ch.charCodeAt(0)
    if (ch === ' ') out += ' '
    else if (ch === '_') out += '@'
    else if (ch === '@') out += '_'
    else if (c >= 0x41 && c <= 0x5e) out += String.fromCharCode(0x5e - (c - 0x41)) + (ch === 'A' ? ' ' : '')
    else out += String.fromCharCode(c ^ 0x5f)
  }
  return out
}

const CORNERS = [
  [0, 0, 0], [3000, 0, 0], [3000, 290, 0], [0, 290, 0],
  [0, 0, 290], [3000, 0, 290], [3000, 290, 290], [0, 290, 290],
]

/** A 3 m x 290 mm box truss section as SAT: vertices in its own frame, placed by `transform`. */
function boxSat(matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1], t = [10000, 20000, 6000]): string[] {
  return [
    '700 0 1 0 ',
    '@33 Open Design Alliance ACIS Builder @14 ACIS 208.00 NT @24 Mon Sep 28 16:08:15 2026 ',
    '1 9.9999999999999995e-007 1e-010 ',
    'body $-1 -1 $-1 $1 $-1 $2 #',
    'lump $-1 -1 $-1 $-1 $3 $0 #',
    `transform $-1 -1 ${matrix.join(' ')} ${t.join(' ')} 1 no_rotate no_reflect no_shear #`,
    ...CORNERS.map(([x, y, z]) => `point $-1 -1 $-1 ${x} ${y} ${z} #`),
    'End-of-ACIS-data ',
  ]
}

const bbox = (p: { x: number; y: number; z: number }[]) => [
  Math.min(...p.map((q) => q.x)), Math.max(...p.map((q) => q.x)),
  Math.min(...p.map((q) => q.y)), Math.max(...p.map((q) => q.y)),
  Math.min(...p.map((q) => q.z)), Math.max(...p.map((q) => q.z)),
]

/** SAB for the same box, with the matrix as one literal string the way ODA writes it. */
function boxSab(signature = 'ACIS BinaryFile'): Uint8Array {
  const out: number[] = []
  const ascii = (s: string) => { for (const c of s) out.push(c.charCodeAt(0)) }
  const i32 = (n: number) => { const b = new DataView(new ArrayBuffer(4)); b.setInt32(0, n, true); out.push(...new Uint8Array(b.buffer)) }
  const f64 = (n: number) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, n, true); out.push(...new Uint8Array(b.buffer)) }
  const str = (s: string) => { out.push(0x07, s.length); ascii(s) }
  const type = (s: string) => { out.push(0x0d, s.length); ascii(s) }
  const ptr = (n: number) => { out.push(0x0c); i32(n) }
  const int = (n: number) => { out.push(0x04); i32(n) }
  ascii(signature)
  for (const n of [20800, 0, 0, 0]) i32(n)
  str('Open Design Alliance ACIS Builder'); str('ACIS 208.00 NT'); str('Mon Sep 28 16:15:54 2026')
  for (const n of [1, 1e-6, 1e-10]) { out.push(0x06); f64(n) }
  type('body'); ptr(-1); int(-1); ptr(-1); ptr(1); ptr(-1); ptr(2); out.push(0x11)
  type('transform'); ptr(-1); int(-1)
  str('1 0 0 0 1 0 0 0 1 10000 20000 6000 1 no_rotate no_reflect no_shear'); out.push(0x11)
  for (const [x, y, z] of CORNERS) {
    type('point'); ptr(-1); int(-1); ptr(-1); out.push(0x13); f64(x); f64(y); f64(z); out.push(0x11)
  }
  return new Uint8Array(out)
}

describe('ACIS reader', () => {
  it('round-trips the AutoCAD cipher, including the A-plus-space case', () => {
    for (const s of ['body $-1 -1 $-1 $1 $-1 $2 #', 'ACIS 208.00 NT', 'End-of-ACIS-data']) {
      expect(decodeSat(encodeSat(s))).toBe(s)
    }
  })

  it('places plain SAT vertices with the body transform', () => {
    expect(bbox(satPoints(boxSat()))).toEqual([10000, 13000, 20000, 20290, 6000, 6290])
  })

  it('reads the ciphered SAT a DXF R2004 carries', () => {
    expect(bbox(satPoints(boxSat().map(encodeSat)))).toEqual([10000, 13000, 20000, 20290, 6000, 6290])
  })

  it('applies a rotation in the transform (a section running along Y)', () => {
    // Rows are the images of the axes: x -> +Y, y -> -X.
    const p = satPoints(boxSat([0, 1, 0, -1, 0, 0, 0, 0, 1]))
    expect(bbox(p)).toEqual([10000 - 290, 10000, 20000, 23000, 6000, 6290])
  })

  it('samples tube-end circles so the hull reaches the outside of the chord', () => {
    const sat = boxSat().slice(0, -1)
    // A 24 mm tube end at the origin, axis along X: a single vertex would miss its radius.
    sat.push('ellipse-curve $-1 -1 $-1 0 500 500 1 0 0 0 24 0 1 I I #', 'End-of-ACIS-data ')
    const b = bbox(satPoints(sat))
    expect(b[2]).toBe(20000)
    expect(b[3]).toBeCloseTo(20524)
    expect(b[5]).toBeCloseTo(6524)
  })

  it('reads SAB, whatever the reader said the encoding was', () => {
    expect(bbox(acisPoints(boxSab()))).toEqual([10000, 13000, 20000, 20290, 6000, 6290])
    expect(bbox(acisPoints(boxSab('ASM BinaryFile4')))).toEqual([10000, 13000, 20000, 20290, 6000, 6290])
  })

  it('reads SAT handed over as bytes', () => {
    const bytes = new TextEncoder().encode(boxSat().join('\n'))
    expect(bbox(acisPoints(bytes))).toEqual([10000, 13000, 20000, 20290, 6000, 6290])
  })

  it('returns nothing, rather than throwing, for bytes it cannot read', () => {
    expect(acisPoints(new Uint8Array([1, 2, 3, 4]))).toEqual([])
    expect(satPoints(['not a body'])).toEqual([])
  })
})

/** A DXF 3DSOLID entity: SAT lines as group code 1, the way AutoCAD writes R2004. */
const solid3d = (layer: string, sat: string[]) => [
  '0', '3DSOLID', '8', layer, '100', 'AcDbModelerGeometry', '70', '1',
  ...sat.flatMap((l) => ['1', l]),
]

const dxf = (entities: string[]) =>
  ['0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF'].join('\n')

describe('DXF 3DSOLID', () => {
  it('imports a truss section as its outer volume, on its own layer', () => {
    const s = importDxf(dxf(solid3d('TRUSS', boxSat().map(encodeSat))), 'rig.dxf')
    const truss = s.nodes.find((n) => n.name === 'TRUSS')
    expect(truss).toBeDefined()
    const p = truss!.positions
    // A box hull: six faces of two triangles each.
    expect(p.length / 9).toBe(12)
    const pts = []
    for (let i = 0; i < p.length; i += 3) pts.push({ x: p[i], y: p[i + 1], z: p[i + 2] })
    expect(bbox(pts)).toEqual([10000, 13000, 20000, 20290, 6000, 6290])
    expect(s.warnings.some((w) => /1 3D solid .*TRUSS.*outer volume/.test(w))).toBe(true)
  })

  it('says so when a solid carries no readable body (DXF R2013+ keeps it elsewhere)', () => {
    const s = importDxf(
      dxf([
        '0', '3DFACE', '8', 'FLOOR', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0',
        '12', '1', '22', '1', '32', '0', '13', '0', '23', '1', '33', '0',
        '0', '3DSOLID', '8', 'TRUSS', '100', 'AcDbModelerGeometry', '70', '1', '2', '{00000000-0000-0000-0000-000000000000}',
      ]),
      'rig.dxf',
    )
    expect(s.nodes.map((n) => n.name)).toEqual(['FLOOR'])
    expect(s.warnings.some((w) => /1 3D solid .*TRUSS.*left out/.test(w))).toBe(true)
  })
})
