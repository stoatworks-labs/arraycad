/**
 * A CAD plan into the tracer, end to end, in node.
 *
 * `demo/demo-rigplot.dxf` (scripts/make_demo_rigplot.py) is a flat ballroom rig plot whose
 * every dimension is written down in the generator: the audience floor is x 46..70,
 * y 120..140 metres, a 24 x 20 m rectangle, drawn in millimetres off the origin. So the
 * scale, the origin and the traced room are assertions, not observations.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PlaneType } from '../dbacv/types.ts'
import { importDxf } from '../import/dxf.ts'
import { type ImportedScene, ImportError, flattenNodes } from '../import/types.ts'
import { DEFAULT_TRANSFORM, type TransformOptions } from '../geom/transform.ts'
import { preparePlan } from '../prepare/plan.ts'
import { type LayerChoice, cadTraceDocument, flatPlanReport, traceLayers } from './cad.ts'
import { inkMask } from './raster.ts'
import { DEFAULT_WAND, floodOptionsFor, floodRegion } from './detect.ts'
import { pixelsPerDrawingUnit, pxToVenue, venueToPx } from './calibrate.ts'
import { buildTraceScene, regionAreaM2 } from './build.ts'
import type { Px, TraceDocument, TraceRegion } from './types.ts'

const MM: TransformOptions = { ...DEFAULT_TRANSFORM, unitsPerMetre: 0.001 }

const rigplot = (): ImportedScene =>
  importDxf(readFileSync(new URL('../../../demo/demo-rigplot.dxf', import.meta.url), 'utf8'), 'demo-rigplot.dxf')

/** What the app does at import: Prepare's plan, applied as the include decisions. */
function prepared(scene: ImportedScene, transform = MM): LayerChoice {
  const plan = preparePlan(scene, transform)
  return {
    included: new Set(flattenNodes(scene.nodes).filter((n) => !plan.exclude.has(n.id)).map((n) => n.id)),
    planExcluded: new Set(plan.exclude.keys()),
    dropClutter: true,
  }
}

function sheet(scene: ImportedScene, layers?: ReadonlySet<string>): TraceDocument {
  return cadTraceDocument(scene, { layers, metresPerUnit: 0.001, unitsStated: true })
}

/** Click the wand at a venue point, the way TraceEditor does, and keep what it finds. */
function wand(doc: TraceDocument, x: number, y: number): TraceRegion {
  const hit = floodRegion(inkMask(doc.raster), venueToPx(x, y, doc.calibration), floodOptionsFor(DEFAULT_WAND, doc.calibration))
  if (!hit) throw new Error('the wand landed on ink')
  expect(hit.touchedBorder).toBe(false)
  return {
    id: 'r1',
    name: 'Audience',
    planeType: PlaneType.Listening,
    vertices: hit.outline.map((p) => ({ p, z: 0 })),
    holes: hit.holes,
    source: { vertices: hit.outline, holes: hit.holes },
    fit: 'outline',
    heightMode: 'plane',
    visible: true,
    origin: 'detected',
  }
}

const venue = (doc: TraceDocument, p: Px) => pxToVenue(p, doc.calibration)

describe('a CAD plan is recognised as one', () => {
  it('the rig plot is flat once clutter is left out, and says what still carries height', () => {
    const scene = rigplot()
    const r = flatPlanReport(scene, MM, prepared(scene))!
    expect(r.flat).toBe(true)
    expect(r.measuredOn).toBe('surfaces')
    expect(r.levelM).toBeCloseTo(0, 6)
    expect(r.share).toBeGreaterThan(0.95)
    // The loudspeakers are 3D boxes on a layer the vocabulary does not know: reported, and
    // not enough to make the drawing a model.
    expect(r.withHeight.map((h) => h.name)).toEqual(['CAD-Audio'])
    expect(r.withHeight[0].spanM).toBeCloseTo(1.2, 6)
    // The truss is the height Prepare left out.
    expect(r.leftOutWithHeight).toBe(1)
  })

  it('a 3D model is not a plan, and a model with no line work is not even asked', () => {
    const venueDxf = importDxf(readFileSync(new URL('../../../demo/demo-venue.dxf', import.meta.url), 'utf8'), 'v.dxf')
    const r = flatPlanReport(venueDxf, MM, prepared(venueDxf))!
    expect(r.flat).toBe(false)
    expect(r.share).toBeLessThan(0.5)

    // Every seat a 3DFACE box: nothing drawn as a line, so nothing to put on a sheet.
    const seats = importDxf(readFileSync(new URL('../../../demo/demo-seats.dxf', import.meta.url), 'utf8'), 's.dxf')
    expect(seats.linework).toEqual([])
    expect(flatPlanReport(seats, MM, prepared(seats))).toBeNull()
  })

  it('a file that is already a venue is never offered', () => {
    const scene = { ...rigplot(), alreadyAVenue: true }
    expect(flatPlanReport(scene, MM, prepared(scene))).toBeNull()
  })

  it('a plan whose lines never close opens as a traceable scene instead of failing', () => {
    // Four walls that miss each other's ends by a metre: no ring, no surface.
    const ents = [
      [0, 0, 9000, 0],
      [10000, 1000, 10000, 9000],
      [9000, 10000, 1000, 10000],
      [0, 9000, 0, 1000],
    ]
      .map(([a, b, c, d]) => `0\nLINE\n8\nWALLS\n10\n${a}\n20\n${b}\n30\n0\n11\n${c}\n21\n${d}\n31\n0`)
      .join('\n')
    const text = `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${ents}\n0\nENDSEC\n0\nEOF\n`
    let err: unknown
    try {
      importDxf(text, 'walls.dxf')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ImportError)
    const traceable = (err as ImportError).traceable!
    expect(traceable.nodes).toEqual([])
    expect(traceable.unitsPerMetre).toBe(0.001)
    expect(traceable.linework!.map((l) => l.layer)).toEqual(['WALLS'])

    const r = flatPlanReport(traceable, MM, { included: new Set(), planExcluded: new Set(), dropClutter: true })!
    expect(r.measuredOn).toBe('lines')
    expect(r.flat).toBe(true)
  })
})

describe('which layers go on the sheet', () => {
  it('leaves clutter off, keeps a lines-only layer, and follows the tree', () => {
    const scene = rigplot()
    const choice = prepared(scene)
    const layers = traceLayers(scene, choice)
    expect([...layers].sort()).toEqual(['0', 'BAR COUNTER', 'Ceiling Coffers', 'STAGE', 'WALLS'])

    // Turned off by hand: stays off. Clutter turned back on by hand: drawn.
    const id = (name: string) => flattenNodes(scene.nodes).find((n) => n.name === name)!.id
    const included = new Set(choice.included)
    included.delete(id('Ceiling Coffers'))
    included.add(id('LX'))
    const edited = traceLayers(scene, { ...choice, included })
    expect(edited.has('Ceiling Coffers')).toBe(false)
    expect(edited.has('LX')).toBe(true)

    // With clutter not being dropped, a lines-only clutter layer is drawn too.
    expect(traceLayers(scene, { ...choice, dropClutter: false }).has('CENTRELINE')).toBe(true)
  })

  it('a layer Prepare left out for its size is still drawn — its lines are what the wand needs', () => {
    const scene = rigplot()
    // The walls of a plan whose corners do not quite meet have almost no surface, and
    // Prepare leaves them out as tiny. Stand that up here by excluding WALLS from the plan.
    const choice = prepared(scene)
    const walls = flattenNodes(scene.nodes).find((n) => n.name === 'WALLS')!
    const included = new Set(choice.included)
    included.delete(walls.id)
    const planExcluded = new Set([...choice.planExcluded, walls.id])
    expect(traceLayers(scene, { ...choice, included, planExcluded }).has('WALLS')).toBe(true)
  })
})

describe('the sheet arrives at the right scale', () => {
  it('is calibrated from the drawing units, exactly, with the venue origin at the drawing origin', () => {
    const scene = rigplot()
    const doc = sheet(scene, traceLayers(scene, prepared(scene)))
    const cal = doc.calibration
    expect(cal.source).toMatchObject({ kind: 'drawing-units', metresPerUnit: 0.001, stated: true })
    // 30.4 m of wall-to-wall at 2400 px: 78.9 px/m, rounded down to two figures.
    expect(cal.pixelsPerMetre).toBeCloseTo(78, 9)
    expect(doc.format).toBe('DXF plan')

    // The stage front, drawn at x = 46 m from y = 120 to 140, is in the snapping paths at
    // exactly those venue coordinates: scale AND origin, with nothing to click.
    const corners = doc.paths.flatMap((p) => p.points).map((p) => venue(doc, p))
    const has = (x: number, y: number) => corners.some((c) => Math.abs(c.x - x) < 1e-6 && Math.abs(c.y - y) < 1e-6)
    expect(has(46, 120)).toBe(true)
    expect(has(46, 140)).toBe(true)
    expect(has(70.2, 140.2)).toBe(true)
  })

  it('draws the lines where the paths say they are, and the sheet is the room, not the title block', () => {
    const scene = rigplot()
    const doc = sheet(scene, traceLayers(scene, prepared(scene)))
    const { width, height, data } = doc.raster
    const inkAt = (x: number, y: number) => {
      const [px, py] = venueToPx(x, y, doc.calibration).map(Math.floor)
      return data[(py * width + px) * 4] === 0
    }
    expect(inkAt(58, 120)).toBe(true) // the inner wall
    expect(inkAt(46, 133)).toBe(true) // the stage front
    expect(inkAt(58, 133)).toBe(false) // the floor
    expect(inkAt(58, 130)).toBe(false) // where the centreline would be
    // Layer 0's stray line sits forty metres away at the origin. Left off: the sheet spans
    // the room and its margin, nowhere near 70 m across.
    expect(width).toBeLessThan(30.4 * 78 + 100)
    expect(height).toBeLessThan(20.4 * 78 + 100)
    expect(doc.warnings.join(' ')).toMatch(/1 path lies far from the rest/)
  })

  it('pixelsPerDrawingUnit fits the longest side and rounds to a scale a person can read', () => {
    expect(pixelsPerDrawingUnit(30400, 0.001, 2400) / 0.001).toBeCloseTo(78, 9)
    expect(pixelsPerDrawingUnit(100, 1, 2400)).toBeCloseTo(24, 9)
    // Inches: same rule in pixels per metre, whatever the unit.
    expect(pixelsPerDrawingUnit(1200, 0.0254, 2400) / 0.0254).toBeCloseTo(78, 9)
  })

  it('says so when the units were the user’s choice rather than the drawing’s', () => {
    const doc = cadTraceDocument(rigplot(), { metresPerUnit: 0.001, unitsStated: false })
    expect(doc.calibration.source).toMatchObject({ kind: 'drawing-units', stated: false })
    expect(doc.warnings.join(' ')).toMatch(/does not state its units/)
  })

  it('refuses an empty sheet with advice rather than drawing nothing', () => {
    expect(() => sheet(rigplot(), new Set())).toThrow(/nothing on the layers left in/)
  })
})

describe('one room, traced with the wand', () => {
  it('the audience floor comes back as the 24 x 20 m rectangle it was drawn as', () => {
    const scene = rigplot()
    const doc = sheet(scene, traceLayers(scene, prepared(scene)))
    const region = wand(doc, 50, 121)

    // Four corners, each on the inner face of the walls or the stage front, within the
    // half-width of a thickened line.
    const tol = 2.5 / doc.calibration.pixelsPerMetre
    const got = region.vertices.map((v) => venue(doc, v.p))
    expect(got).toHaveLength(4)
    for (const [x, y] of [
      [46, 120],
      [70, 120],
      [70, 140],
      [46, 140],
    ]) {
      expect(got.some((c) => Math.abs(c.x - x) <= tol && Math.abs(c.y - y) <= tol)).toBe(true)
    }

    // And from there it is the ordinary tracer: one flat surface of the right area.
    expect(regionAreaM2(region, doc.calibration)).toBeCloseTo(480, -1)
    const traced = buildTraceScene({ ...doc, regions: [region] })
    expect(traced.nodes).toHaveLength(1)
    expect(traced.unitsPerMetre).toBe(1)
    const p = traced.nodes[0].positions
    for (let i = 2; i < p.length; i += 3) expect(p[i]).toBe(0)
  })

  it('with the clutter drawn, the centreline cuts the same room in half — why the layers matter', () => {
    const doc = sheet(rigplot())
    const region = wand(doc, 50, 121)
    expect(regionAreaM2(region, doc.calibration)).toBeCloseTo(240, -1)
  })
})
