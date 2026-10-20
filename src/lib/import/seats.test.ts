/**
 * The seats check, on layouts whose answer is known by construction.
 *
 * The real case it was built for is the National Taichung Theater's published plans, which
 * state millimetres and are drawn in centimetres (`realVenues.test.ts`, local only). These
 * pin the rule: rows of a block at a seat's spacing in the drawing's REAL units, and the
 * layouts that must never trip it.
 */

import { describe, expect, it } from 'vitest'
import type { CadDocument } from './entities.ts'
import { rowSpacing, seatUnitsCheck } from './seats.ts'

/** `rows` rows of `seats`, `pitch` apart along a row and `rowPitch` between rows, as INSERTs. */
function seating(rows: number, seats: number, pitch: number, rowPitch: number, block = 'SEAT'): CadDocument {
  const entities = []
  for (let r = 0; r < rows; r++) {
    for (let s = 0; s < seats; s++) {
      entities.push({ type: 'INSERT', layer: 'SEATS', name: block, position: { x: s * pitch, y: r * rowPitch, z: 0 } })
    }
  }
  return { entities, blocks: { [block]: { entities: [] } } }
}

const MM = 0.001
const CM = 0.01

describe('the seats check', () => {
  it('finds a seating plan drawn in centimetres that says millimetres', () => {
    // 520 mm seats on 900 mm rows, drawn in centimetres: 52 and 90 units.
    const doubt = seatUnitsCheck(seating(12, 30, 52, 90, '520'), MM)!
    expect(doubt.suggested).toBeCloseTo(CM, 12)
    expect(doubt.pitchM).toBeCloseTo(0.52, 6)
    expect(doubt.block).toBe('520')
    expect(doubt.message).toMatch(/says it is in millimetres.*52 mm apart.*In centimetres they would be 0\.52 m apart/)
  })

  it('also the other way: millimetres stated as metres', () => {
    expect(seatUnitsCheck(seating(12, 30, 520, 900), 1)?.suggested).toBeCloseTo(MM, 12)
  })

  it('says nothing when the seats agree with the stated units', () => {
    // Tower Theatre's own plan: 108 seats 500 mm apart, stated and drawn in millimetres.
    expect(seatUnitsCheck(seating(6, 18, 500, 850), MM)).toBeNull()
  })

  it('says nothing about a drawing that states no units: the user is asked already', () => {
    expect(seatUnitsCheck(seating(12, 30, 52, 90), undefined)).toBeNull()
  })

  it('does not take a line of markers for seating, at any spacing', () => {
    // 156 fly-bar markers 200 mm apart in one line, as on Taichung's stage plan. Read as
    // inches they would be a seat's spacing; read as anything they are not in rows.
    const markers: CadDocument = {
      entities: Array.from({ length: 156 }, (_, i) => ({ type: 'INSERT', name: 'FLYBAR', position: { x: 0, y: i * 20 } })),
      blocks: { FLYBAR: { entities: [] } },
    }
    expect(rowSpacing(markers.entities.map((e) => e.position))).toBeNull()
    expect(seatUnitsCheck(markers, MM)).toBeNull()
  })

  it('does not judge by a handful of copies', () => {
    expect(seatUnitsCheck(seating(4, 20, 52, 90), MM)).toBeNull()
  })

  it('does not suggest a unit that would not make a seat', () => {
    // Rows of something 30 mm apart: not a seat in millimetres, nor at any power of ten.
    expect(seatUnitsCheck(seating(12, 30, 30, 60), MM)).toBeNull()
  })
})
