/**
 * Just enough of ACIS SAT to say where a 3DSOLID is.
 *
 * A 3DSOLID is not drawing geometry. It is an ACIS boundary-representation body — faces on
 * planes, cones, tori and NURBS patches, trimmed by loops of edges — carried through the
 * DXF as an opaque blob. Tessellating that properly is a solid modeller's job. What a venue
 * import needs from one is far less: in practice the 3DSOLIDs in a venue drawing are truss,
 * and the speakers are flown from the truss, so its position and outer volume matter and
 * the tube detail inside it does not.
 *
 * So this reads the body's vertices and the circles its tubes end in, places them with the
 * body's own transform, and hands back the point cloud. `entities.ts` wraps that in its
 * convex hull, which for a straight truss section or a corner block IS its outer volume.
 *
 Both encodings are read: SAT (text, what a DXF R2000–R2004 carries, ciphered) and SAB
 * (the binary form, what a DWG carries — whatever the reader's "is binary" flag claims). SAB
 * is turned into the same token lists SAT splits into, so one reader serves both.
 *
 * WHAT IS NOT HANDLED, on purpose:
 *   - DXF R2013 and later, which moves the body out of the entity into an ACDSDATA section.
 *     Those entities arrive with no body at all and the caller says so.
 *   - Concave solids. The hull of an L-shaped body fills in the inside of the L.
 */

import type { Vec3 } from '../geom/vec.ts'

/**
 * Undo AutoCAD's "encryption" of the SAT text in a DXF 3DSOLID (R2000–R2004).
 *
 * It is a substitution cipher: most bytes are XORed with 0x5F, 0x41–0x5E map onto each other
 * in reverse, and a plaintext 'A' is written as 0x5E followed by a space that must then be
 * skipped. Same table as ezdxf's `crypt.decode`, which is where it was checked against.
 */
export function decodeSat(line: string): string {
  let out = ''
  let skip = false
  for (let i = 0; i < line.length; i++) {
    if (skip) {
      skip = false
      continue
    }
    const c = line.charCodeAt(i)
    if (c === 0x20) out += ' '
    else if (c === 0x40) out += '_'
    else if (c === 0x5f) out += '@'
    else if (c >= 0x41 && c <= 0x5e) {
      out += String.fromCharCode(0x41 + (0x5e - c))
      skip = c === 0x5e
    } else out += String.fromCharCode(c ^ 0x5f)
  }
  return out
}

/**
 * Plain SAT starts with its version line: a number such as `700` or `20800` and three more
 * integers. The ciphered form never does, because every digit XORs to a letter or symbol.
 */
const isPlainSat = (text: string) => /^\s*\d+ \d+ \d+ \d+/.test(text)

const NUM = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i

/** Numbers that follow the last `$` pointer in a record — where every geometry record keeps its data. */
function dataAfterPointers(tokens: string[]): number[] {
  let i = tokens.length - 1
  while (i >= 0 && !tokens[i].startsWith('$')) i--
  const out: number[] = []
  for (let j = i + 1; j < tokens.length && NUM.test(tokens[j]); j++) out.push(Number(tokens[j]))
  return out
}

/** Segments per circle when a tube end is sampled. The hull only needs the outline. */
const CIRCLE_STEPS = 16

/**
 * The points a solid is made of, in the coordinates of the entity that holds it.
 *
 * `lines` are the SAT lines as the DXF gives them (group codes 1 and 3), ciphered or not.
 * Returns an empty array when there is nothing readable, never throws: a solid that cannot
 * be read is a warning, not a failed import.
 */
export function satPoints(lines: string[]): Vec3[] {
  if (lines.length === 0) return []
  let text = lines.join('\n')
  if (!isPlainSat(text)) text = lines.map(decodeSat).join('\n')
  if (!isPlainSat(text)) return []
  return pointsFromRecords(text.split('#').map((r) => r.trim().split(/\s+/)))
}

const SAB_SIGNATURE = 'ACIS BinaryFile'
/** The same format under Autodesk's own modeller's name, written by R2018 and later. */
const ASM_SIGNATURE = 'ASM BinaryFile4'

/**
 * A solid body as the bytes a DWG reader hands over: SAB, or SAT text.
 *
 * acad-ts reports a DWG body's encoding through `isBinaryAcisData`, and on a real R2004
 * DWG written by AutoCAD LT 2026 it said text for a body that starts `ACIS BinaryFile`.
 * The bytes are the authority, so they are what is checked.
 */
export function acisPoints(bytes: Uint8Array): Vec3[] {
  if (bytes.length === 0) return []
  const head = String.fromCharCode(...bytes.subarray(0, SAB_SIGNATURE.length))
  if (head === SAB_SIGNATURE || head === ASM_SIGNATURE) {
    try {
      return pointsFromRecords(sabRecords(bytes))
    } catch {
      return []
    }
  }
  return satPoints(new TextDecoder('latin1').decode(bytes).split(/\r?\n/))
}

/**
 * SAB -> the token lists SAT would have split into.
 *
 * Tag values from ezdxf's `acis/sab.py`. Pointers become `$n`, vectors their three numbers,
 * and strings are split into words, because ODA writes a transform's whole matrix and its
 * flags as one literal string. Entity type parts arrive as separate tags and are joined
 * with '-', which is how SAT spells them (`ellipse-curve`).
 */
function sabRecords(bytes: Uint8Array): string[][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const latin1 = new TextDecoder('latin1')
  let i = SAB_SIGNATURE.length + 16 // signature, then version, records, entities, flags
  const byte = () => bytes[i++]
  const int = () => ((i += 4), view.getInt32(i - 4, true))
  const dbl = () => ((i += 8), view.getFloat64(i - 8, true))
  const str = (n: number) => ((i += n), latin1.decode(bytes.subarray(i - n, i)))
  // Header: product, ACIS version and date as strings, then units and two tolerances.
  for (let k = 0; k < 3; k++) if (byte() === 0x07) str(byte())
  for (let k = 0; k < 3; k++) if (byte() === 0x06) dbl()

  const records: string[][] = []
  let rec: string[] = []
  let type: string[] = []
  while (i < bytes.length) {
    const tag = byte()
    switch (tag) {
      case 0x04: // int
      case 0x15: // enum
        rec.push(String(int()))
        break
      case 0x06: // double
      case 0x17:
        rec.push(String(dbl()))
        break
      case 0x07: // string, 8-bit length
        rec.push(...str(byte()).trim().split(/\s+/))
        break
      case 0x12: // string, 32-bit length
        rec.push(...str(int()).trim().split(/\s+/))
        break
      case 0x0c: // pointer
        rec.push(`$${int()}`)
        break
      case 0x0a:
        rec.push('T')
        break
      case 0x0b:
        rec.push('F')
        break
      case 0x0e: // first part(s) of a compound entity type
        type.push(str(byte()))
        break
      case 0x0d: // last part of the entity type
        type.push(str(byte()))
        rec.push(type.join('-'))
        type = []
        break
      case 0x13: // location
      case 0x14: // direction
        rec.push(String(dbl()), String(dbl()), String(dbl()))
        break
      case 0x0f: // subtype start / end: structure only
      case 0x10:
        rec.push(tag === 0x0f ? '{' : '}')
        break
      case 0x11: // record end
        records.push(rec)
        rec = []
        break
      default:
        // Unknown tag: its length is unknown too, so nothing after it can be trusted.
        return records
    }
  }
  return records
}

function pointsFromRecords(records: string[][]): Vec3[] {
  const raw: Vec3[] = []
  // Row-vector affine map, as ACIS writes it: p' = scale * (p x M) + t.
  let m: number[] | null = null
  let t = { x: 0, y: 0, z: 0 }
  let s = 1

  for (const tokens of records) {
    // Some writers prefix every record with its own index, "-12 point ...".
    const k = /^-\d+$/.test(tokens[0] ?? '') ? 1 : 0
    const type = tokens[k]
    switch (type) {
      case 'point': {
        const d = dataAfterPointers(tokens)
        if (d.length >= 3) raw.push({ x: d[0], y: d[1], z: d[2] })
        break
      }
      case 'ellipse-curve': {
        // centre, normal, major axis (its length is the major radius), radius ratio. Tube
        // ends are circles and carry exactly one vertex, so without these a truss chord
        // contributes a single point and the hull comes out a tube-radius short all round.
        const d = dataAfterPointers(tokens)
        if (d.length < 10) break
        const c = { x: d[0], y: d[1], z: d[2] }
        const n = { x: d[3], y: d[4], z: d[5] }
        const u = { x: d[6], y: d[7], z: d[8] }
        const a = Math.hypot(u.x, u.y, u.z)
        const nl = Math.hypot(n.x, n.y, n.z)
        if (a < 1e-12 || nl < 1e-12) break
        const b = a * d[9]
        // minor direction = normal x major, unit length
        const vx = (n.y * u.z - n.z * u.y) / (nl * a)
        const vy = (n.z * u.x - n.x * u.z) / (nl * a)
        const vz = (n.x * u.y - n.y * u.x) / (nl * a)
        for (let i = 0; i < CIRCLE_STEPS; i++) {
          const th = (i / CIRCLE_STEPS) * Math.PI * 2
          const ca = Math.cos(th)
          const sb = Math.sin(th) * b
          raw.push({ x: c.x + u.x * ca + vx * sb, y: c.y + u.y * ca + vy * sb, z: c.z + u.z * ca + vz * sb })
        }
        break
      }
      case 'transform': {
        if (m) break // one body, one transform; a second would belong to something else
        // The 13 numbers (3x3, translation, scale) sit just before the rotate/reflect/shear
        // flags; everything ahead of them is pointers and history that vary by version.
        const flag = tokens.findIndex((w, i) => i > k && /^(no_)?rotate$/.test(w))
        const d = (flag > 0 ? tokens.slice(flag - 13, flag).map(Number) : dataAfterPointers(tokens).slice(-13))
        if (d.length === 13 && d.every(Number.isFinite)) {
          m = d.slice(0, 9)
          t = { x: d[9], y: d[10], z: d[11] }
          s = d[12] || 1
        }
        break
      }
    }
  }

  if (!m) return raw
  const M = m
  return raw.map((p) => ({
    x: s * (p.x * M[0] + p.y * M[3] + p.z * M[6]) + t.x,
    y: s * (p.x * M[1] + p.y * M[4] + p.z * M[7]) + t.y,
    z: s * (p.x * M[2] + p.y * M[5] + p.z * M[8]) + t.z,
  }))
}
