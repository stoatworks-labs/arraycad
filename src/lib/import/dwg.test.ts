/**
 * DWG import.
 *
 * These build acad-ts entity objects directly rather than reading a .dwg fixture. The
 * parsing is acad-ts's job and is not ours to test; what IS ours is the translation into
 * `CadDocument`, and the two things it can silently get wrong — angles arrive in radians
 * where DXF uses degrees, and `Arc.sweep` is the negative of the DXF sweep — are exactly
 * what a fixture-based test would leave uncovered while still passing.
 *
 * Using the real classes matters: the mapper dispatches on `constructor.name` and reads
 * acad-ts's own property names, so a rename upstream has to fail here.
 */

import { describe, expect, it } from 'vitest'
import { Arc, BlockRecord, Circle, Insert, Layer, Line, XYZ } from '@node-projects/acad-ts'
import { buildDwgScene } from './dwg.ts'
import { countTriangles } from './types.ts'
import { DEFAULT_PLANARIZE, findCoplanarRegions, weld } from '../geom/planarize.ts'

/* eslint-disable @typescript-eslint/no-explicit-any */

const layer = (name: string) => {
  const l = new Layer(name)
  return l
}

function line(l: Layer, x1: number, y1: number, x2: number, y2: number): any {
  const e = new Line()
  e.startPoint = new XYZ(x1, y1, 0)
  e.endPoint = new XYZ(x2, y2, 0)
  e.layer = l
  return e
}

function arc(l: Layer, cx: number, cy: number, r: number, startRad: number, endRad: number): any {
  const e = new Arc()
  e.center = new XYZ(cx, cy, 0)
  e.radius = r
  e.startAngle = startRad
  e.endAngle = endRad
  e.layer = l
  return e
}

/** A document shaped the way acad-ts's reader returns one. */
const doc = (entities: any[], blockRecords: any[] = [], insUnits = 6) => ({
  modelSpace: { entities },
  blockRecords,
  header: { insUnits },
})

const regionsOf = (scene: { nodes: { positions: Float64Array }[] }) =>
  findCoplanarRegions(weld(scene.nodes[0].positions, 0.001), DEFAULT_PLANARIZE)

describe('DWG import', () => {
  it('chains loose lines into a room outline, as the DXF path does', () => {
    const l = layer('STAGE')
    const s = buildDwgScene(
      doc([
        line(l, 0, 0, 10, 0),
        line(l, 10, 0, 10, 6),
        line(l, 10, 6, 0, 6),
        line(l, 0, 6, 0, 0),
      ]),
      'a.dwg',
    )
    expect(s.format).toBe('DWG')
    expect(s.nodes[0].name).toBe('STAGE')
    const regions = regionsOf(s)
    expect(regions).toHaveLength(1)
    expect(regions[0].area).toBeCloseTo(60)
  })

  it('sweeps an arc counter-clockwise, not backwards', () => {
    // acad-ts's own `sweep` getter is start-minus-end. Trusting it would draw every arc
    // the long way round the circle, which on a curved seating plan is most of them.
    const l = layer('APRON')
    const s = buildDwgScene(
      doc([line(l, -5, 0, 5, 0), arc(l, 0, 0, 5, 0, Math.PI)]),
      'a.dwg',
    )
    const regions = regionsOf(s)
    expect(regions).toHaveLength(1)
    expect(regions[0].area).toBeCloseTo((Math.PI * 25) / 2, 0)
  })

  it('sweeps an arc that runs past zero the short way round', () => {
    const l = layer('A')
    const s = buildDwgScene(
      doc([line(l, 0, -5, 5, 0), arc(l, 0, 0, 5, (3 * Math.PI) / 2, Math.PI * 2)]),
      'a.dwg',
    )
    const regions = regionsOf(s)
    expect(regions).toHaveLength(1)
    expect(regions[0].area).toBeCloseTo((Math.PI * 25) / 4 - 12.5, 0)
  })

  it('reads INSERT rotation as radians and places the block accordingly', () => {
    // The single most damaging unit slip available here: acad-ts reports radians and the
    // shared code, following DXF group code 50, expects degrees. Left unconverted, a
    // quarter turn becomes 90 radians and every seat in the house faces somewhere random.
    const seatLayer = layer('SEATING')
    const block = new BlockRecord('SEAT')
    const bl = layer('SEATING')
    ;(block as any).entities = [
      line(bl, 0, 0, 4, 0),
      line(bl, 4, 0, 4, 2),
      line(bl, 4, 2, 0, 2),
      line(bl, 0, 2, 0, 0),
    ]

    const ins: any = new Insert()
    ins.block = block
    ins.insertPoint = new XYZ(100, 50, 0)
    ins.rotation = Math.PI / 2 // a quarter turn
    ins.layer = seatLayer

    const s = buildDwgScene(doc([ins], [block]), 'a.dwg')
    const m = weld(s.nodes[0].positions, 0.001)
    const xs = m.vertices.map((v) => v.x)
    const ys = m.vertices.map((v) => v.y)
    // Rotated a quarter turn about the origin then moved to (100, 50): the 4x2 block
    // becomes 2 wide and 4 tall.
    expect(Math.min(...xs)).toBeCloseTo(98)
    expect(Math.max(...xs)).toBeCloseTo(100)
    expect(Math.min(...ys)).toBeCloseTo(50)
    expect(Math.max(...ys)).toBeCloseTo(54)
  })

  it('reads INSUNITS', () => {
    const l = layer('X')
    const square = [
      line(l, 0, 0, 10, 0),
      line(l, 10, 0, 10, 6),
      line(l, 10, 6, 0, 6),
      line(l, 0, 6, 0, 0),
    ]
    expect(buildDwgScene(doc(square, [], 1), 'a.dwg').unitsPerMetre).toBeCloseTo(0.0254)
    expect(buildDwgScene(doc(square, [], 4), 'a.dwg').unitsPerMetre).toBe(0.001)
    const unitless = buildDwgScene(doc(square, [], 0), 'a.dwg')
    expect(unitless.unitsPerMetre).toBeUndefined()
    expect(unitless.warnings.join(' ')).toMatch(/does not declare its units/)
  })

  it('fills a CIRCLE and groups by layer', () => {
    const grills = layer('GRILLS')
    const c: any = new Circle()
    c.center = new XYZ(0, 0, 0)
    c.radius = 2
    c.layer = grills
    const s = buildDwgScene(doc([c]), 'a.dwg')
    expect(s.nodes).toHaveLength(1)
    expect(s.nodes[0].name).toBe('GRILLS')
    expect(regionsOf(s)[0].area).toBeCloseTo(Math.PI * 4, 1)
  })

  it('says so when it drops an entity type that could have carried geometry', () => {
    const l = layer('X')
    const hatch: any = { constructor: { name: 'Hatch' }, layer: l }
    const s = buildDwgScene(
      doc([
        line(l, 0, 0, 10, 0),
        line(l, 10, 0, 10, 6),
        line(l, 10, 6, 0, 6),
        line(l, 0, 6, 0, 0),
        hatch,
      ]),
      'a.dwg',
    )
    expect(s.warnings.join(' ')).toMatch(/Skipped unsupported DWG entity type Hatch/)
    expect(countTriangles(s.nodes)).toBeGreaterThan(0)
  })

  it('refuses a drawing with nothing in model space', () => {
    expect(() => buildDwgScene(doc([]), 'a.dwg')).toThrow(/nothing in model space/)
  })
})
