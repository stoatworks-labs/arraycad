/**
 * Guards against the ways the pipeline can be handed something it cannot use.
 *
 * The UI debounces its settings, so for one interval after an import the conversion is
 * called with settings that describe the PREVIOUS file — or, on the first import, a
 * placeholder with no transform at all. state.ts now refuses to convert in that window;
 * these tests pin the behaviour the conversion layer must have regardless.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_CONVERT, convertNode, convertNodes } from './convert.ts'
import { applyTransform, boundsOf, guessUnits } from './transform.ts'
import { DEFAULT_PLANARIZE, findCoplanarRegions, weld } from './planarize.ts'
import { boundaryLoops } from './polygon.ts'
import { PlaneType } from '../dbacv/types.ts'
import type { ImportedNode } from '../import/types.ts'

const node = (positions: number[], name = 'n'): ImportedNode => ({
  id: 'n1',
  name,
  tags: [],
  positions: new Float64Array(positions),
  children: [],
})

describe('degenerate input', () => {
  it('converts an empty node to nothing', () => {
    expect(convertNode(node([]), PlaneType.Audience, DEFAULT_CONVERT).objects).toHaveLength(0)
  })

  it('survives a lone degenerate triangle', () => {
    const r = convertNode(node([0, 0, 0, 0, 0, 0, 0, 0, 0]), PlaneType.Audience, DEFAULT_CONVERT)
    expect(r.objects).toHaveLength(0)
  })

  it('survives a triangle stream with a trailing partial triangle', () => {
    // 1.5 triangles: the loop must stop at the last complete one rather than read past.
    const r = convertNode(node([0, 0, 0, 4, 0, 0, 4, 3, 0, 9, 9]), PlaneType.Audience, DEFAULT_CONVERT)
    expect(r.objects).toHaveLength(1)
  })

  it('survives all-collinear geometry that encloses no area', () => {
    const r = convertNode(node([0, 0, 0, 1, 0, 0, 2, 0, 0]), PlaneType.Audience, DEFAULT_CONVERT)
    expect(r.objects).toHaveLength(0)
  })

  it('does not emit a group for a single object', () => {
    const r = convertNodes(
      [{ node: node([0, 0, 0, 10, 0, 0, 10, 5, 0]), planeType: PlaneType.Audience, include: true, name: 'One' }],
      DEFAULT_CONVERT,
    )
    expect(r.objects).toHaveLength(1)
    expect(r.objects[0].children).toHaveLength(0)
    expect(r.objects[0].name).toBe('One')
  })

  it('emits nothing at all when everything is excluded', () => {
    const r = convertNodes(
      [{ node: node([0, 0, 0, 10, 0, 0, 10, 5, 0]), planeType: PlaneType.Audience, include: false, name: 'x' }],
      DEFAULT_CONVERT,
    )
    expect(r.objects).toHaveLength(0)
    expect(r.stats.trianglesIn).toBe(0)
  })

  it('boundsOf returns null rather than an infinite box for empty input', () => {
    expect(boundsOf([])).toBeNull()
    expect(boundsOf([node([])])).toBeNull()
  })

  it('guessUnits handles a zero-size model', () => {
    expect(guessUnits({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } })).toBe(1)
  })

  it('a zero scale collapses the model without producing NaN', () => {
    const out = applyTransform(new Float64Array([1, 2, 3]), {
      unitsPerMetre: 0,
      upAxis: 'z',
      headingDeg: 0,
      offset: { x: 0, y: 0, z: 0 },
      flipX: false,
    })
    expect([...out].every(Number.isFinite)).toBe(true)
  })

  it('boundaryLoops does not hang on a region pinched at a shared vertex', () => {
    // Two triangles meeting at one corner only: the boundary walk reaches a vertex with
    // two outgoing edges and must not loop for ever.
    const tris = [0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 2, 1, 0, 2, 2, 0]
    const m = weld(new Float64Array(tris), 0.001)
    const regions = findCoplanarRegions(m, { ...DEFAULT_PLANARIZE, minArea: 0 })
    for (const r of regions) expect(() => boundaryLoops(r, m)).not.toThrow()
  })
})
