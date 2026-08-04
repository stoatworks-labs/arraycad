/**
 * The decisions layer: how a plan lands on a scene, and what must never happen to one.
 *
 * `state.ts` is where the immutability rule actually lives — the scene goes in, decisions
 * sit beside it, and conversion is a pure function of the two. These are the tests for the
 * places where that could quietly go wrong.
 */

import { describe, expect, it } from 'vitest'
import { PlaneType } from './lib/dbacv/types.ts'
import type { ImportedNode, ImportedScene } from './lib/import/types.ts'
import { DEFAULT_SETTINGS, applyPlan, conversionEntries, newRationalisation, rationalisedAreas, rationalisationsFromPlan, seedDecisions } from './state.ts'
import { preparePlan } from './lib/prepare/index.ts'

let seq = 0
const node = (name: string, positions: number[]): ImportedNode => ({
  id: `n${++seq}`,
  name,
  tags: [],
  positions: Float64Array.from(positions),
  children: [],
})

const scene = (nodes: ImportedNode[]): ImportedScene => ({
  format: 'test',
  sourceName: 'test',
  nodes,
  warnings: [],
})

const settings = { ...DEFAULT_SETTINGS, transform: { ...DEFAULT_SETTINGS.transform, unitsPerMetre: 1 } }

/** One big level rectangle: a deck as a CAD package draws it, in two triangles. */
const deck = (w: number, d: number, z = 0) => [0, 0, z, w, 0, z, w, d, z, 0, 0, z, w, d, z, 0, d, z]

describe('applying a plan', () => {
  it('excludes and types without touching anything else', () => {
    const s = scene([node('DIMENSIONS', deck(10, 10)), node('STAGE', deck(8, 6, 1))])
    const plan = preparePlan(s, settings.transform)
    const decisions = applyPlan(seedDecisions(s), plan)

    expect(decisions[s.nodes[0].id].include).toBe(false)
    expect(decisions[s.nodes[1].id].include).toBe(true)
    expect(decisions[s.nodes[1].id].planeType).toBe(PlaneType.Stage)
    // The name is the user's to change and a plan has no opinion on it.
    expect(decisions[s.nodes[1].id].name).toBe('STAGE')
  })

  it('is a no-op with no plan, so an unprepared scene behaves as it always did', () => {
    const s = scene([node('DIMENSIONS', deck(10, 10))])
    const seeded = seedDecisions(s)
    expect(applyPlan(seeded, null)).toEqual(seeded)
  })
})

describe('a rationalisation that produces nothing', () => {
  /**
   * The failure this guards against is silent and total: a deck named as seating is
   * captured, no two of its corners are within the bridging gap, the alpha shape comes back
   * empty — and the objects it was standing in for have already been taken out of the
   * venue. The audience simply is not there, and the object count looks tidier than ever.
   */
  it('does not take its source objects out of the venue', () => {
    const s = scene([node('SEATING', deck(20, 16))])
    const rat = { ...newRationalisation('r1', 'Seating', [s.nodes[0].id]), gapMetres: 0.9 }

    const { areas, effective, warnings } = rationalisedAreas(s, [rat], settings)
    expect(areas).toEqual([])
    expect(effective).toEqual([])
    expect(warnings.join(' ')).toMatch(/left in the venue/)

    const entries = conversionEntries(s, seedDecisions(s), effective)
    expect(entries[0].include).toBe(true)
  })

  it('and one that does produce something still replaces them', () => {
    // The same deck, bridged widely enough to be captured.
    const s = scene([node('SEATING', deck(20, 16))])
    const rat = { ...newRationalisation('r1', 'Seating', [s.nodes[0].id]), gapMetres: 30 }

    const { areas, effective } = rationalisedAreas(s, [rat], settings)
    expect(areas.length).toBe(1)
    expect(conversionEntries(s, seedDecisions(s), effective)[0].include).toBe(false)
  })
})

describe('rationalisations from a plan', () => {
  it('are ordinary ones, carrying the measured gap', () => {
    const seats: ImportedNode[] = []
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) {
        const [x, y] = [r * 0.9, c * 0.55]
        seats.push(node(`Seat.${r * 6 + c}`, [x, y, 1, x + 0.48, y, 1, x + 0.48, y + 0.45, 1]))
      }
    }
    const s = scene(seats)
    const plan = preparePlan(s, settings.transform)
    const rats = rationalisationsFromPlan(plan)

    expect(rats.length).toBe(1)
    expect(rats[0].memberIds.length).toBe(36)
    expect(rats[0].gapMetres).toBeCloseTo(plan.seating[0].gapMetres, 6)
    expect(rats[0].replaceMembers).toBe(true)
  })
})
