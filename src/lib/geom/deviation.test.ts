/**
 * What the reduction costs, against shapes whose cost is known by construction.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ImportedNode } from '../import/types.ts'
import { flattenNodes } from '../import/types.ts'
import { importDxf } from '../import/dxf.ts'
import { DEFAULT_CONVERT, convertNodes } from './convert.ts'
import { NO_DEVIATION, addDeviation } from './deviation.ts'
import { nodeOutlines } from './outline.ts'
import { DEFAULT_TRANSFORM } from './transform.ts'

const metres = { ...DEFAULT_TRANSFORM, unitsPerMetre: 1, upAxis: 'z' as const }
const opts = { ...DEFAULT_CONVERT, transform: metres }

/** A level polygon at height z, fanned from its first corner (it must be convex or an L). */
function level(rings: [number, number][][], z = 0): ImportedNode {
  const p: number[] = []
  for (const r of rings) {
    for (let i = 1; i + 1 < r.length; i++) p.push(r[0][0], r[0][1], z, r[i][0], r[i][1], z, r[i + 1][0], r[i + 1][1], z)
  }
  return { id: 'n', name: 'n', tags: [], positions: Float64Array.from(p), children: [] }
}

describe('deviation', () => {
  it('a modelled rectangle written as itself costs nothing', () => {
    const { stats } = nodeOutlines(level([[[0, 0], [10, 0], [10, 8], [0, 8]]]), opts)
    expect(stats.deviation.area).toBeCloseTo(80, 9)
    expect(stats.deviation.lost).toBe(0)
    expect(stats.deviation.added).toBeCloseTo(0, 9)
    expect(stats.deviation.rms).toBeCloseTo(0, 9)
    expect(stats.deviation.max).toBeCloseTo(0, 9)
  })

  it('rectangle fit round an L adds the corner it fills in', () => {
    // A 10 x 8 L with a 4 x 3 bite out of one corner: 68 m², in three pieces that share
    // their edges whole, so the weld makes one region of them.
    const L = level([
      [[0, 0], [6, 0], [6, 5], [0, 5]],
      [[6, 0], [10, 0], [10, 5], [6, 5]],
      [[0, 5], [6, 5], [6, 8], [0, 8]],
    ])
    const exact = nodeOutlines(L, opts).stats.deviation
    expect(exact.area).toBeCloseTo(68, 9)
    expect(exact.added).toBeCloseTo(0, 9)
    const rect = nodeOutlines(L, { ...opts, fit: 'rect' }).stats.deviation
    expect(rect.added).toBeCloseTo(12, 6)
    // Every point of the L is still on the rectangle: what rectangle fit costs is area, not distance.
    expect(rect.max).toBeCloseTo(0, 9)
  })

  it('counts what falls under the minimum area as lost', () => {
    const floor = level([[[0, 0], [10, 0], [10, 8], [0, 8]]])
    const scrap = level([[[20, 0], [20.1, 0], [20.1, 0.1], [20, 0.1]]], 1)
    const node = { ...floor, positions: Float64Array.from([...floor.positions, ...scrap.positions]) }
    const d = nodeOutlines(node, opts).stats.deviation
    expect(d.area).toBeCloseTo(80.01, 9)
    expect(d.lost).toBeCloseTo(0.01, 9)
  })

  it('measures how far a region was flattened', () => {
    // A floor whose back half rises 15 mm: inside the 20 mm merge offset, so one region, and
    // its plane runs between the two.
    const p = [0, 0, 0, 10, 0, 0, 10, 4, 0, 0, 0, 0, 10, 4, 0, 0, 4, 0, 0, 4, 0, 10, 4, 0, 10, 8, 0.015, 0, 4, 0, 10, 8, 0.015, 0, 8, 0.015]
    const d = nodeOutlines({ id: 'n', name: 'n', tags: [], positions: Float64Array.from(p), children: [] }, opts).stats.deviation
    expect(d.lost).toBe(0)
    expect(d.max).toBeGreaterThan(0.002)
    expect(d.max).toBeLessThan(DEFAULT_CONVERT.planarize.offsetTolerance)
    expect(d.rms).toBeGreaterThan(0)
    expect(d.rms).toBeLessThan(d.max)
  })

  it('pools nodes by area, not by count', () => {
    const a = { ...NO_DEVIATION, area: 90, rms: 0.001, max: 0.002 }
    const b = { ...NO_DEVIATION, area: 10, lost: 5, rms: 0.01, max: 0.03 }
    const both = addDeviation(a, b)
    expect(both.area).toBe(100)
    expect(both.lost).toBe(5)
    expect(both.rms).toBeCloseTo(Math.sqrt((0.001 ** 2 * 90 + 0.01 ** 2 * 5) / 95), 12)
    expect(both.max).toBe(0.03)
    expect(addDeviation(NO_DEVIATION, NO_DEVIATION).rms).toBe(0)
  })

  it('the demo venue is written within a few millimetres, and rectangle fit says what it adds', () => {
    const scene = importDxf(readFileSync(new URL('../../../demo/demo-venue.dxf', import.meta.url), 'utf8'), 'demo-venue.dxf')
    const entries = flattenNodes(scene.nodes)
      .filter((n) => n.positions.length > 0)
      .map((n) => ({ node: n, planeType: 1, include: true, name: n.name }))
    const exact = convertNodes(entries, opts).stats.deviation
    expect(exact.lost).toBeLessThan(0.01)
    expect(exact.rms).toBeLessThan(0.005)
    // The worst point is further than either tolerance alone: the flood fill tests each
    // triangle against the plane as it stood then, and the plane goes on moving. Measured
    // 89 mm.
    expect(exact.max).toBeLessThan(0.1)
    const rect = convertNodes(entries, { ...opts, fit: 'rect' }).stats.deviation
    expect(rect.added).toBeGreaterThan(20 * exact.added)
  })
})
