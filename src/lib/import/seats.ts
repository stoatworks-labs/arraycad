/**
 * Do the drawing's seats agree with the units it states?
 *
 * A DWG or DXF states its units in `$INSUNITS`, and the importers take it at its word —
 * they report what the format states and never guess (CLAUDE.md). Usually that is right.
 * The National Taichung Theater's published plans are the case where it is not: every one
 * says millimetres and is drawn in centimetres, so its 2,007-seat Grand Theater arrives a
 * tenth of its size, an 88 m building as 8.8 m, and nothing about the geometry looks
 * broken. A plan of a room has no other scale on it to disagree with.
 *
 * A theatre plan does have one: its seats. A seat is half a metre wide in every venue in
 * the world, and a seating plan places the same seat block hundreds of times along rows. So
 * the spacing between neighbouring copies along a row is a measurement of half a metre made
 * in the drawing's real units. Taichung's `520` block (a 520 mm seat) sits 46 units from
 * the next: 46 mm as stated, 46 cm as drawn.
 *
 * What makes a repeated block SEATING is read from the layout, not from the block, whose
 * extent real drawings pad with sight lines and attribute frames: copies in ROWS, where the
 * nearest copy off the line of the row — the seat behind — is between 1.3 and 2.8 times as
 * far as the nearest along it. That ratio is the row pitch over the seat pitch, it holds at
 * any scale, and a line of fly-bar markers or lighting symbols, with nothing off its own
 * line, never has it.
 *
 * This only ever WARNS. It does not change the units: a layout like seating is evidence,
 * not proof, and the setting stays the user's. And it suggests only metric powers of ten:
 * a 0.2 m fly-bar pitch read as inches is a plausible seat, and a warning that fires on a
 * correct drawing teaches people to ignore it.
 */

import { UNIT_PRESETS } from '../geom/transform.ts'
import type { CadDocument } from './entities.ts'

export interface UnitsDoubt {
  /** Metres per unit the drawing states. */
  stated: number
  /** Metres per unit its seating implies. */
  suggested: number
  /** The block laid out as seating, its copies, and their spacing in the SUGGESTED units. */
  block: string
  count: number
  pitchM: number
  /** The warning, for the import notes. */
  message: string
}

/** Metres, centre to centre, along a row: a seat is 450-600 mm wide plus the gap. */
const SEAT_PITCH = [0.42, 0.75] as const
/** Row pitch over seat pitch: 0.8-1.1 m rows over 0.45-0.6 m seats, with room either side. */
const ROW_RATIO = [1.3, 2.8] as const
const MIN_COPIES = 100
const POWERS = [10, 100, 1000, 0.1, 0.01, 0.001]
/** cos 45°: a neighbour further off the row's line than this is in another row. */
const OFF_ROW = Math.SQRT1_2

/**
 * The spacing along a row and the spacing to the next row, as medians over a sample of a
 * few hundred copies. Null when the copies are not laid out in rows at all.
 */
export function rowSpacing(pts: { x: number; y: number }[]): { seat: number; row: number } | null {
  const step = Math.max(1, Math.ceil(pts.length / 300))
  const along: number[] = []
  const across: number[] = []
  for (let i = 0; i < pts.length; i += step) {
    const p = pts[i]
    let d1 = Infinity
    let ux = 0
    let uy = 0
    for (const q of pts) {
      const d = Math.hypot(q.x - p.x, q.y - p.y)
      if (d > 1e-9 && d < d1) {
        d1 = d
        ux = (q.x - p.x) / d
        uy = (q.y - p.y) / d
      }
    }
    if (!Number.isFinite(d1)) continue
    let r = Infinity
    for (const q of pts) {
      const dx = q.x - p.x
      const dy = q.y - p.y
      const d = Math.hypot(dx, dy)
      if (d <= 1e-9 || d >= r) continue
      if (Math.abs((dx * ux + dy * uy) / d) < OFF_ROW) r = d
    }
    along.push(d1)
    if (Number.isFinite(r)) across.push(r)
  }
  // Most copies have to have a row behind or in front: a row of seats with nothing off its
  // line is a lone row, and a lone row of anything is not evidence of seating.
  if (along.length === 0 || across.length < along.length / 2) return null
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  const seat = median(along)
  const row = median(across)
  const ratio = row / seat
  return ratio >= ROW_RATIO[0] && ratio <= ROW_RATIO[1] ? { seat, row } : null
}

const unitName = (perMetre: number) =>
  UNIT_PRESETS.find((u) => Math.abs(u.unitsPerMetre - perMetre) < perMetre * 1e-9)?.label.toLowerCase()

const isSeatPitch = (m: number) => m >= SEAT_PITCH[0] && m <= SEAT_PITCH[1]

/**
 * The doubt, or null when the seating agrees with the stated units, when there is no
 * seating to judge by, or when the drawing states no units at all (the user is asked then).
 */
export function seatUnitsCheck(doc: CadDocument, stated: number | undefined): UnitsDoubt | null {
  if (!stated) return null
  const copies = new Map<string, { x: number; y: number }[]>()
  for (const e of doc.entities) {
    if (e?.type !== 'INSERT' || !e.name) continue
    if ((e.columnCount ?? 1) > 1 || (e.rowCount ?? 1) > 1) continue
    const list = copies.get(e.name) ?? []
    list.push({ x: e.position?.x ?? 0, y: e.position?.y ?? 0 })
    copies.set(e.name, list)
  }

  const candidates = [...copies].filter(([, l]) => l.length >= MIN_COPIES).sort((a, b) => b[1].length - a[1].length)
  for (const [block, list] of candidates) {
    const rows = rowSpacing(list)
    if (!rows) continue
    // Laid out as seating, and seat-sized at the stated units: all is well.
    if (isSeatPitch(rows.seat * stated)) return null
    for (const f of POWERS) {
      const suggested = stated * f
      const name = unitName(suggested)
      if (!name || !isSeatPitch(rows.seat * suggested)) continue
      const statedName = unitName(stated) ?? `units of ${stated} m`
      return {
        stated,
        suggested,
        block,
        count: list.length,
        pitchM: rows.seat * suggested,
        message:
          `This drawing says it is in ${statedName}, but its ${list.length} copies of "${block}" are laid ` +
          `out in rows like seating, ${(rows.seat * stated * 1000).toFixed(0)} mm apart at that scale. ` +
          `In ${name} they would be ${(rows.seat * suggested).toFixed(2)} m apart — a seat. Check a ` +
          `dimension you know, and set Source units to ${name} if it agrees.`,
      }
    }
  }
  return null
}
