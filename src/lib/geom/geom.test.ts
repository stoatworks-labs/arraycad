import { describe, expect, it } from 'vitest'
import { DEFAULT_PLANARIZE, findCoplanarRegions, weld } from './planarize.ts'
import { boundaryLoops, convexHull, dropCollinear, isConvex, minAreaRect, simplifyClosed, toFaces } from './polygon.ts'
import { applyTransform, boundsOf, guessUnits } from './transform.ts'
import { planeBasis, toPlane2D } from './vec.ts'
import { DEFAULT_CONVERT, convertNode } from './convert.ts'
import { PlaneType, Shape } from '../dbacv/types.ts'
import type { ImportedNode } from '../import/types.ts'

/** A w x d rectangle in the z = h plane, as two triangles. */
function quadXY(w: number, d: number, h = 0): number[] {
  return [0, 0, h, w, 0, h, w, d, h, 0, 0, h, w, d, h, 0, d, h]
}

/** An axis-aligned box as 12 triangles. */
function box(w: number, d: number, hgt: number): number[] {
  const p = [
    [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
    [0, 0, hgt], [w, 0, hgt], [w, d, hgt], [0, d, hgt],
  ]
  const faces = [
    [0, 2, 1], [0, 3, 2], // bottom
    [4, 5, 6], [4, 6, 7], // top
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7],
  ]
  return faces.flatMap((f) => f.flatMap((i) => p[i]))
}

const node = (positions: number[], name = 'test'): ImportedNode => ({
  id: 'n1',
  name,
  tags: [],
  positions: new Float64Array(positions),
  children: [],
})

describe('weld', () => {
  it('fuses coincident vertices', () => {
    const m = weld(new Float64Array(quadXY(10, 5)), 0.001)
    expect(m.vertices).toHaveLength(4)
    expect(m.indices).toHaveLength(6)
  })

  it('fuses across a quantisation cell boundary', () => {
    // Two triangles whose shared edge is off by 0.4 mm and straddles a 1 mm grid line.
    // A naive quantise-and-hash weld leaves these apart, which is the crack that shatters
    // a ceiling into dozens of regions.
    const tris = [
      0, 0, 0, 1.0004, 0, 0, 1.0004, 1, 0,
      0, 0, 0, 0.9996, 1, 0, 0, 1, 0,
    ]
    const m = weld(new Float64Array(tris), 0.001)
    expect(m.vertices.length).toBeLessThanOrEqual(4)
  })

  it('drops triangles that collapse when welded', () => {
    const m = weld(new Float64Array([0, 0, 0, 0.0001, 0, 0, 0.0002, 0, 0]), 0.001)
    expect(m.indices).toHaveLength(0)
  })
})

describe('findCoplanarRegions', () => {
  it('merges a split rectangle back into one region', () => {
    const m = weld(new Float64Array(quadXY(10, 5)), 0.001)
    const r = findCoplanarRegions(m, DEFAULT_PLANARIZE)
    expect(r).toHaveLength(1)
    expect(r[0].area).toBeCloseTo(50)
  })

  it('finds exactly six faces on a box', () => {
    const m = weld(new Float64Array(box(4, 3, 2)), 0.001)
    const r = findCoplanarRegions(m, DEFAULT_PLANARIZE)
    expect(r).toHaveLength(6)
    // Sorted largest first: two 4x3 faces lead.
    expect(r[0].area).toBeCloseTo(12)
    expect(r[1].area).toBeCloseTo(12)
  })

  it('keeps two parallel surfaces apart when they do not touch', () => {
    const m = weld(new Float64Array([...quadXY(10, 5, 0), ...quadXY(10, 5, 3)]), 0.001)
    expect(findCoplanarRegions(m, DEFAULT_PLANARIZE)).toHaveLength(2)
  })

  it('does not walk around a cylinder one tolerable step at a time', () => {
    // 36 facets, 10 degrees apart. Each neighbour is within the 5 degree tolerance of the
    // last only if you compare pairwise; against the accumulated region plane it is not.
    const tris: number[] = []
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2
      const b = ((i + 1) / 36) * Math.PI * 2
      const [x1, y1] = [Math.cos(a) * 5, Math.sin(a) * 5]
      const [x2, y2] = [Math.cos(b) * 5, Math.sin(b) * 5]
      tris.push(x1, y1, 0, x2, y2, 0, x1, y1, 3)
      tris.push(x2, y2, 0, x2, y2, 3, x1, y1, 3)
    }
    const m = weld(new Float64Array(tris), 0.001)
    const r = findCoplanarRegions(m, DEFAULT_PLANARIZE)
    expect(r.length).toBeGreaterThan(10)
  })

  it('drops regions below minArea', () => {
    const m = weld(new Float64Array([...quadXY(10, 5), ...quadXY(0.1, 0.1, 9)]), 0.001)
    const r = findCoplanarRegions(m, { ...DEFAULT_PLANARIZE, minArea: 0.05 })
    expect(r).toHaveLength(1)
  })
})

describe('boundaryLoops', () => {
  it('recovers the four corners of a split rectangle', () => {
    const m = weld(new Float64Array(quadXY(10, 5)), 0.001)
    const [region] = findCoplanarRegions(m, DEFAULT_PLANARIZE)
    const loops = boundaryLoops(region, m)
    expect(loops).toHaveLength(1)
    expect(loops[0]).toHaveLength(4)
  })

  it('returns the outer loop first and the hole second', () => {
    // A 10x10 plate with a 2x2 hole, triangulated as a ring of 8 quads.
    const o = [[0, 0], [10, 0], [10, 10], [0, 10]]
    const outerPts = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5]]
    const innerPts = [[4, 4], [6, 4], [6, 4], [6, 6], [6, 6], [4, 6], [4, 6], [4, 4]]
    const tris: number[] = []
    for (let i = 0; i < 8; i++) {
      const a = outerPts[i]
      const b = outerPts[(i + 1) % 8]
      const c = innerPts[(i + 1) % 8]
      const d = innerPts[i]
      tris.push(a[0], a[1], 0, b[0], b[1], 0, c[0], c[1], 0)
      tris.push(a[0], a[1], 0, c[0], c[1], 0, d[0], d[1], 0)
    }
    void o
    const m = weld(new Float64Array(tris), 0.001)
    const [region] = findCoplanarRegions(m, DEFAULT_PLANARIZE)
    const loops = boundaryLoops(region, m)
    expect(loops.length).toBe(2)
    const basis = planeBasis(region.plane)
    const areaOf = (l: number[]) => {
      const p = l.map((i) => toPlane2D(m.vertices[i], basis))
      let a = 0
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]
      return Math.abs(a / 2)
    }
    expect(areaOf(loops[0])).toBeCloseTo(100)
    expect(areaOf(loops[1])).toBeCloseTo(4)
  })
})

describe('polygon simplification', () => {
  it('drops collinear vertices', () => {
    const p: [number, number][] = [[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]]
    expect(dropCollinear(p, 0.01)).toHaveLength(4)
  })

  it('keeps the far side of a closed ring', () => {
    // A 20-vertex ring. DP anchored at one vertex would cut straight across.
    const ring: [number, number][] = []
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2
      ring.push([Math.cos(a) * 10, Math.sin(a) * 10])
    }
    const s = simplifyClosed(ring, 0.5)
    expect(s.length).toBeGreaterThanOrEqual(8)
    const xs = s.map((p) => p[0])
    expect(Math.min(...xs)).toBeLessThan(-8)
    expect(Math.max(...xs)).toBeGreaterThan(8)
  })

  it('finds the minimum-area rectangle of a rotated rectangle', () => {
    const a = Math.PI / 6
    const pts: [number, number][] = [[0, 0], [8, 0], [8, 3], [0, 3]].map(
      ([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)] as [number, number],
    )
    const r = minAreaRect(pts)
    expect(r).toHaveLength(4)
    const side = (i: number, j: number) => Math.hypot(r[i][0] - r[j][0], r[i][1] - r[j][1])
    const sides = [side(0, 1), side(1, 2)].sort((x, y) => x - y)
    expect(sides[0]).toBeCloseTo(3, 5)
    expect(sides[1]).toBeCloseTo(8, 5)
  })

  it('hulls a point cloud', () => {
    const h = convexHull([[0, 0], [5, 5], [10, 0], [10, 10], [0, 10], [5, 1]])
    expect(h).toHaveLength(4)
  })

  it('recognises convexity', () => {
    expect(isConvex([[0, 0], [4, 0], [4, 4], [0, 4]])).toBe(true)
    expect(isConvex([[0, 0], [4, 0], [1, 1], [0, 4]])).toBe(false)
  })
})

describe('toFaces', () => {
  const basis = planeBasis({ normal: { x: 0, y: 0, z: 1 }, point: { x: 0, y: 0, z: 0 } })

  it('passes a quad through as one face', () => {
    const f = toFaces([[0, 0], [4, 0], [4, 4], [0, 4]], [], basis)
    expect(f).toHaveLength(1)
    expect(f[0].points).toHaveLength(4)
  })

  it('passes a triangle through as one face', () => {
    expect(toFaces([[0, 0], [4, 0], [0, 4]], [], basis)).toHaveLength(1)
  })

  it('emits only 3- and 4-point faces for an L shape', () => {
    const l: [number, number][] = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]]
    const f = toFaces(l, [], basis)
    expect(f.length).toBeGreaterThan(0)
    for (const face of f) expect([3, 4]).toContain(face.points.length)
  })

  it('merges triangles into quads rather than leaving them all as triangles', () => {
    const l: [number, number][] = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]]
    const f = toFaces(l, [], basis)
    expect(f.some((x) => x.points.length === 4)).toBe(true)
  })
})

describe('transform', () => {
  it('scales millimetres to metres', () => {
    const out = applyTransform(new Float64Array([1000, 2000, 3000]), {
      unitsPerMetre: 0.001, upAxis: 'z', headingDeg: 0, offset: { x: 0, y: 0, z: 0 }, flipX: false,
    })
    expect(Array.from(out)).toEqual([1, 2, 3])
  })

  it('rotates Y-up to Z-up without mirroring the room', () => {
    // Source +Y (up) must land on venue +Z, and source -Z (forward) on venue +Y.
    const out = applyTransform(new Float64Array([0, 1, 0, 0, 0, -1]), {
      unitsPerMetre: 1, upAxis: 'y', headingDeg: 0, offset: { x: 0, y: 0, z: 0 }, flipX: false,
    })
    expect(out[0]).toBeCloseTo(0)
    expect(out[1]).toBeCloseTo(0)
    expect(out[2]).toBeCloseTo(1)
    expect(out[4]).toBeCloseTo(1)
    expect(out[5]).toBeCloseTo(0)
  })

  it('preserves handedness through the Y-up fix', () => {
    // The determinant of the mapping must be +1. If it is -1 the auditorium comes out
    // mirrored, which is invisible in a symmetric room until it is on site.
    const t = { unitsPerMetre: 1, upAxis: 'y' as const, headingDeg: 0, offset: { x: 0, y: 0, z: 0 }, flipX: false }
    const e = applyTransform(new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), t)
    const det =
      e[0] * (e[4] * e[8] - e[5] * e[7]) -
      e[1] * (e[3] * e[8] - e[5] * e[6]) +
      e[2] * (e[3] * e[7] - e[4] * e[6])
    expect(det).toBeCloseTo(1)
  })

  it('applies heading then offset', () => {
    const out = applyTransform(new Float64Array([1, 0, 0]), {
      unitsPerMetre: 1, upAxis: 'z', headingDeg: 90, offset: { x: 10, y: 0, z: 0 }, flipX: false,
    })
    expect(out[0]).toBeCloseTo(10)
    expect(out[1]).toBeCloseTo(1)
  })

  it('guesses units from the model span', () => {
    expect(guessUnits({ min: { x: 0, y: 0, z: 0 }, max: { x: 30000, y: 20000, z: 9000 } })).toBe(0.001)
    expect(guessUnits({ min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 20, z: 9 } })).toBe(1)
  })

  it('bounds a node tree including children', () => {
    const b = boundsOf([{ ...node([0, 0, 0]), children: [node([5, 6, 7], 'c')] }])!
    expect(b.max).toEqual({ x: 5, y: 6, z: 7 })
  })
})

describe('convertNode', () => {
  it('turns a flat rectangle into a single quad RoomObject', () => {
    const r = convertNode(node(quadXY(10, 5)), PlaneType.Audience, DEFAULT_CONVERT)
    expect(r.objects).toHaveLength(1)
    expect(r.objects[0].shape).toBe(Shape.Quad)
    expect(r.objects[0].points).toHaveLength(4)
    expect(r.stats.regionsFound).toBe(1)
  })

  it('puts points in a local frame around the origin', () => {
    const r = convertNode(node(quadXY(10, 6)), PlaneType.Audience, DEFAULT_CONVERT)
    const o = r.objects[0]
    expect(o.origin.x).toBeCloseTo(5)
    expect(o.origin.y).toBeCloseTo(3)
    // Points are offsets, so they must sum to zero about the centroid.
    expect(o.points.reduce((s, p) => s + p.x, 0)).toBeCloseTo(0)
    expect(o.points.reduce((s, p) => s + p.y, 0)).toBeCloseTo(0)
    // World position is recoverable.
    expect(o.origin.x + o.points[0].x).toBeCloseTo(0)
  })

  it('turns a box into six objects', () => {
    const r = convertNode(node(box(4, 3, 2)), PlaneType.Surface, DEFAULT_CONVERT)
    expect(r.objects).toHaveLength(6)
    expect(r.objects.every((o) => o.shape === Shape.Quad)).toBe(true)
  })

  it('rect fit collapses a ragged outline to exactly one quad', () => {
    // A rectangle with a jagged edge: exact fit needs several faces, rect fit needs one.
    const tris = [...quadXY(10, 5), 10, 0, 0, 12, 2.5, 0, 10, 5, 0]
    const exact = convertNode(node(tris), PlaneType.Audience, DEFAULT_CONVERT)
    const rect = convertNode(node(tris), PlaneType.Audience, { ...DEFAULT_CONVERT, fit: 'rect' })
    expect(rect.objects).toHaveLength(1)
    expect(rect.objects[0].shape).toBe(Shape.Quad)
    expect(exact.objects.length).toBeGreaterThanOrEqual(1)
  })

  it('assigns the listener height that matches the plane type', () => {
    const aud = convertNode(node(quadXY(4, 4)), PlaneType.Audience, DEFAULT_CONVERT)
    const srf = convertNode(node(quadXY(4, 4)), PlaneType.Surface, DEFAULT_CONVERT)
    expect(aud.objects[0].listenerHeight).toBe(1.2)
    expect(srf.objects[0].listenerHeight).toBe(0.01)
  })

  it('honours the per-node object cap, keeping the largest regions', () => {
    const r = convertNode(node(box(4, 3, 2)), PlaneType.Surface, {
      ...DEFAULT_CONVERT,
      maxObjectsPerNode: 2,
    })
    expect(r.objects).toHaveLength(2)
    expect(r.stats.regionsDropped).toBe(4)
  })

  it('handles an empty node without throwing', () => {
    const r = convertNode(node([]), PlaneType.Audience, DEFAULT_CONVERT)
    expect(r.objects).toHaveLength(0)
  })
})
