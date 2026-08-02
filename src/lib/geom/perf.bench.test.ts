/**
 * Not a correctness test — a guard on the shape of the cost curve.
 *
 * The conversion runs synchronously on the browser's main thread, so a big model freezes
 * the UI while it works. This pins roughly how big "big" is, and fails if the welder ever
 * regresses to the quadratic-feeling behaviour it had when it probed all 27 grid cells
 * before checking the one the vertex actually landed in.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_CONVERT, convertNode } from './convert.ts'
import { PlaneType } from '../dbacv/types.ts'

/** A raked deck of rows x cols quads, every vertex shared with its neighbours. */
function rakedDeck(rows: number, cols: number): Float64Array {
  const out: number[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const z0 = r * 0.1
      const z1 = (r + 1) * 0.1
      out.push(c, r, z0, c + 1, r, z0, c + 1, r + 1, z1)
      out.push(c, r, z0, c + 1, r + 1, z1, c, r + 1, z1)
    }
  }
  return new Float64Array(out)
}

const node = (positions: Float64Array) => ({
  id: 'n',
  name: 'deck',
  tags: [] as string[],
  positions,
  children: [],
})

describe('conversion cost', () => {
  it('scales close to linearly in triangle count', () => {
    const time = (rows: number) => {
      const positions = rakedDeck(rows, rows)
      const t0 = performance.now()
      convertNode(node(positions) as never, PlaneType.Listening, DEFAULT_CONVERT)
      return performance.now() - t0
    }

    time(20) // warm up, so the first run does not carry JIT cost
    const small = Math.max(time(50), 1)
    const large = Math.max(time(100), 1)

    // 4x the triangles. Linear would be 4x the time; allow generous headroom for noise
    // and for the region-merge step, but catch a genuinely superlinear regression.
    expect(large / small).toBeLessThan(12)
  })

  it('handles a 45k-triangle deck in a time a person will tolerate', () => {
    const t0 = performance.now()
    const r = convertNode(node(rakedDeck(150, 150)) as never, PlaneType.Listening, DEFAULT_CONVERT)
    const ms = performance.now() - t0
    process.stdout.write(`  [perf] 45,000 triangles converted in ${ms.toFixed(0)} ms\n`)
    expect(r.stats.trianglesIn).toBe(45000)
    // Deliberately loose. Machines vary by more than an order of magnitude and this is
    // a smoke guard against a catastrophic regression, not a benchmark to police.
    expect(ms).toBeLessThan(20000)
  })
})
