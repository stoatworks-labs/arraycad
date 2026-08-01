/**
 * Serialise a VenueFile back to .dbacv.
 *
 * Written by hand rather than with XMLSerializer because the goal is a file that is
 * byte-identical to what ArrayCalc itself emits: 4-space indent, attributes in
 * alphabetical order, self-closing tags with no space before `/>`, and C's `%.17g`
 * number formatting. Matching that exactly makes a diff against a real ArrayCalc export
 * meaningful — if the only differences are values you changed, the writer is honest.
 */

import { type RoomObject, type VenueFile, Shape } from './types.ts'

/**
 * Format a double the way C's `printf("%.17g")` does, which is what ArrayCalc uses.
 *
 * Precision P = 17. Let X be the base-10 exponent. If -4 <= X < P the value is written
 * fixed with P-1-X fraction digits, otherwise scientific with P-1. Trailing zeros in the
 * fraction are then stripped (no `#` flag), and a bare trailing point goes with them.
 *
 * This is why the sample file is full of things like `5.4050000000000002` — that is not
 * a precision bug in ArrayCalc, it is the exact decimal of the double nearest 5.405.
 */
export function g17(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? 'inf' : Number.isNaN(v) ? 'nan' : '-inf'
  // Negative zero prints as "0", deliberately departing from strict %.17g. No ArrayCalc
  // file has ever contained "-0" — three genuine exports, zero occurrences — whereas our
  // canonical-quad maths produces it readily from atan2(-0, x). -0 and 0 are the same
  // point, so this costs nothing and keeps a diff against a real export free of noise.
  if (v === 0) return '0'

  const P = 17
  const X = Math.floor(Math.log10(Math.abs(v)))
  // log10 is not exact at powers of ten; take the exponent from toExponential, which is.
  const exp = Number(v.toExponential().split('e')[1])
  const X2 = Number.isFinite(exp) ? exp : X

  let s: string
  if (X2 >= -4 && X2 < P) {
    s = v.toFixed(Math.max(0, P - 1 - X2))
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  } else {
    s = v.toExponential(P - 1)
    let [mant, e] = s.split('e')
    if (mant.includes('.')) mant = mant.replace(/0+$/, '').replace(/\.$/, '')
    s = `${mant}e${e}`
  }
  return s
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Attributes are emitted in alphabetical order, which is what ArrayCalc does. */
function attrs(map: Record<string, string | undefined>): string {
  return Object.keys(map)
    .filter((k) => map[k] !== undefined)
    .sort()
    .map((k) => ` ${k}="${esc(map[k]!)}"`)
    .join('')
}

function vecTag(name: string, v: { x: number; y: number; z: number }, indent: string): string {
  return `${indent}<${name} x="${g17(v.x)}" y="${g17(v.y)}" z="${g17(v.z)}"/>\n`
}

/**
 * Depth-first 1-based document index. The file's `ParentVenueObjectId` is exactly this
 * number for the parent, and 0 at the top level — there is no id attribute anywhere, so
 * it is derived on write and must never be round-tripped from the source file. Renumbering
 * happens for free every time we serialise, which is what makes pruning safe.
 */
function writeObject(
  o: RoomObject,
  parentIndex: number,
  counter: { n: number },
  depth: number,
): string {
  const myIndex = ++counter.n
  const pad = ' '.repeat(4 * depth)
  const inner = ' '.repeat(4 * (depth + 1))
  const isGroup = o.shape === Shape.Group

  const a: Record<string, string | undefined> = {
    Color: String(o.color >>> 0),
    Enabled: o.enabled ? '1' : '0',
    ListenerHeight: o.listenerHeightRaw ?? g17(o.listenerHeight),
    Locked: o.locked ? '1' : '0',
    Name: o.name,
    // Only groups carry ObjectGroup, and it is the string "true", not "1".
    ObjectGroup: isGroup ? 'true' : undefined,
    OrderIndex: String(o.orderIndex),
    ParentVenueObjectId: String(parentIndex),
    PlaneType: String(o.planeType),
    PrintColor: String(o.printColor >>> 0),
    Shape: String(o.shape),
    Transparent: o.transparent ? '1' : '0',
  }

  if (o.arc && o.shape === Shape.Arc) {
    a.InnerRadiusA = g17(o.arc.innerRadiusA)
    a.InnerRadiusB = g17(o.arc.innerRadiusB)
    a.InnerZ = g17(o.arc.innerZ)
    a.OuterRadiusA = g17(o.arc.outerRadiusA)
    a.OuterRadiusB = g17(o.arc.outerRadiusB)
    a.OuterZ = g17(o.arc.outerZ)
    a.SpanAngle = g17(o.arc.spanAngle)
    a.StartAngle = g17(o.arc.startAngle)
  }

  let out = `${pad}<RoomObject${attrs(a)}>\n`

  if (isGroup) {
    // A group writes its children FIRST and its own transform last. That ordering is not
    // cosmetic to reproduce — it is what ArrayCalc emits, and a group transform is real:
    // child origins are relative to it. In the sample, group STAGE sits at x=-4.8 and its
    // STAGE child at another -4.8, putting the stage at world x=-9.6, which is exactly
    // where the SOUNDSCAPE plane starts. Two other groups cancel their child to precisely
    // zero. Treat the chain as composing, not as decoration.
    for (const c of o.children) out += writeObject(c, myIndex, counter, depth + 1)
    out += vecTag('Origin', o.origin, inner)
    out += vecTag('Rotation', o.rotation, inner)
    out += vecTag('Scaling', o.scaling, inner)
  } else {
    out += vecTag('Origin', o.origin, inner)
    out += vecTag('Rotation', o.rotation, inner)
    out += vecTag('Scaling', o.scaling, inner)
    o.points.forEach((p, i) => {
      out += vecTag(`P${i + 1}`, p, inner)
    })
    for (const c of o.children) out += writeObject(c, myIndex, counter, depth + 1)
  }

  out += `${pad}</RoomObject>\n`
  return out
}

export function writeDbacv(v: VenueFile): string {
  let out = '<!DOCTYPE ArrayCalc>\n'
  out += `<ArrayCalc Version="${esc(v.appVersion)}">\n`
  out += `    <Project Name="${esc(v.projectName)}">\n`
  out += `        <Date>${esc(v.date)}</Date>\n`
  out += `        <Author>${esc(v.author)}</Author>\n`
  out += `        <Comments>${esc(v.projectComments)}</Comments>\n`
  out += '    </Project>\n'
  out += `    <Venue Version="${esc(v.venueVersion)}">\n`
  out += `        <Comments>${esc(v.venueComments)}</Comments>\n`

  const counter = { n: 0 }
  for (const o of v.objects) out += writeObject(o, 0, counter, 2)

  out += '    </Venue>\n'
  out += '</ArrayCalc>\n'
  return out
}

/** DD.MM.YYYY, the format ArrayCalc writes into `<Date>`. */
export function formatDbacvDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}
