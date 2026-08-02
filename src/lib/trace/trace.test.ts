/**
 * The tracer, on synthetic drawings where the right answer is known.
 *
 * A "drawing" here is a mask built by hand: a rectangle of ink is a room, a gap in it is a
 * doorway. That makes every detection assertion exact rather than a tolerance on a real
 * scan, and it means these run in node with no canvas, no pdf.js and no browser.
 */

import { describe, expect, it } from 'vitest'
import { PlaneType, Shape } from '../dbacv/types.ts'
import { DEFAULT_CONVERT, convertNode, convertNodes } from '../geom/convert.ts'
import { signedArea2 } from '../geom/vec.ts'
import { parseDbacv } from '../dbacv/read.ts'
import { formatDbacvDate, writeDbacv } from '../dbacv/write.ts'
import { JSDOM } from 'jsdom'
import {
  type Calibration,
  type Raster,
  type TraceDocument,
  type TraceRegion,
  DEFAULT_CALIBRATION,
} from './types.ts'
import { binarise, dilate, inkFraction, luminance, otsuThreshold } from './raster.ts'
import { SnapIndex, boundaryLoops, closestOnSegment, floodRegion, pointInPolygon, traceContours } from './detect.ts'
import {
  calibrateByDistance,
  calibrateByPaperScale,
  pxToVenue,
  scaleBarStep,
  venueToPx,
} from './calibrate.ts'
import { fitHeightPlane, heightAt, rampHeights, slopeOf } from './heights.ts'
import { buildTraceScene, regionAreaM2, regionGeometry, regionPerimeterM, selfIntersects } from './build.ts'
import { type Mat, flattenCubic, mul, pathsFromOperatorList } from './pdfPaths.ts'

// -------------------------------------------------------------------- helpers

/** A greyscale image as a Raster. `at(x, y)` returns 0-255. */
function grey(w: number, h: number, at: (x: number, y: number) => number): Raster {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = at(x, y)
      const o = (y * w + x) * 4
      data[o] = v
      data[o + 1] = v
      data[o + 2] = v
      data[o + 3] = 255
    }
  }
  return { width: w, height: h, data }
}

/** A hollow rectangle of ink: four walls one pixel thick. `gap` opens a doorway. */
function roomMask(w: number, h: number, rect: [number, number, number, number], gap = 0) {
  const [x0, y0, x1, y1] = rect
  return grey(w, h, (x, y) => {
    const onV = (x === x0 || x === x1) && y >= y0 && y <= y1
    const onH = (y === y0 || y === y1) && x >= x0 && x <= x1
    if (gap > 0 && x === x1 && y > y0 + 2 && y <= y0 + 2 + gap) return 255
    return onV || onH ? 0 : 255
  })
}

const cal1 = (origin: [number, number] = [0, 0]): Calibration => ({
  pixelsPerMetre: 1,
  origin,
  source: { kind: 'known-distance', from: [0, 0], to: [1, 0], metres: 1 },
})

const region = (over: Partial<TraceRegion> = {}): TraceRegion => ({
  id: 'r1',
  name: 'Stalls',
  planeType: PlaneType.Listening,
  vertices: [],
  holes: [],
  heightMode: 'plane',
  visible: true,
  origin: 'drawn',
  ...over,
})

/** A rectangle in pixel space, clicked anticlockwise ON SCREEN. */
function rectVertices(x0: number, y0: number, x1: number, y1: number, z: number | number[]) {
  const zs = Array.isArray(z) ? z : [z, z, z, z]
  return [
    { p: [x0, y1] as [number, number], z: zs[0] },
    { p: [x1, y1] as [number, number], z: zs[1] },
    { p: [x1, y0] as [number, number], z: zs[2] },
    { p: [x0, y0] as [number, number], z: zs[3] },
  ]
}

// --------------------------------------------------------------------- raster

describe('raster', () => {
  it('composites alpha over white, so a transparent PDF background is paper', () => {
    const data = new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255])
    const lum = luminance({ width: 2, height: 1, data })
    expect(lum[0]).toBe(255)
    expect(lum[1]).toBe(0)
  })

  it('otsu splits a bimodal image between the two modes', () => {
    const r = grey(40, 40, (x) => (x < 20 ? 30 : 220))
    const t = otsuThreshold(luminance(r))
    expect(t).toBeGreaterThanOrEqual(30)
    expect(t).toBeLessThan(220)
  })

  it('otsu returns no ink rather than all ink on a blank page', () => {
    const r = grey(10, 10, () => 255)
    const mask = binarise(r)
    expect(inkFraction(mask)).toBe(0)
  })

  it('inverts for a drawing that is light lines on a dark background', () => {
    const r = grey(20, 20, (x, y) => (x === 10 || y === 10 ? 240 : 10))
    expect(inkFraction(binarise(r, { threshold: 'auto', invert: false }))).toBeGreaterThan(0.9)
    expect(inkFraction(binarise(r, { threshold: 'auto', invert: true }))).toBeLessThan(0.1)
  })

  it('dilate thickens ink by a Chebyshev radius', () => {
    const r = grey(9, 9, (x, y) => (x === 4 && y === 4 ? 0 : 255))
    const m = dilate(binarise(r), 1)
    // A single pixel becomes a 3x3 block.
    expect(m.data.reduce((s, v) => s + v, 0)).toBe(9)
    expect(m.data[3 * 9 + 3]).toBe(1)
    expect(m.data[2 * 9 + 4]).toBe(0)
  })
})

// --------------------------------------------------------------------- detect

describe('flood region select', () => {
  it('recovers a rectangular room as four corners', () => {
    const mask = binarise(roomMask(60, 60, [10, 10, 50, 40]))
    const hit = floodRegion(mask, [30, 25])
    expect(hit).not.toBeNull()
    expect(hit!.touchedBorder).toBe(false)
    expect(hit!.outline).toHaveLength(4)
    const xs = hit!.outline.map((p) => p[0]).sort((a, b) => a - b)
    const ys = hit!.outline.map((p) => p[1]).sort((a, b) => a - b)
    // The fill covers the pixels strictly inside the walls, so its outline runs along the
    // inner faces: corners at 11 and 50, not 10 and 50.
    expect(xs[0]).toBe(11)
    expect(xs[3]).toBe(50)
    expect(ys[0]).toBe(11)
    expect(ys[3]).toBe(40)
  })

  it('refuses a seed that is on a drawn line', () => {
    const mask = binarise(roomMask(60, 60, [10, 10, 50, 40]))
    expect(floodRegion(mask, [10, 25])).toBeNull()
  })

  it('reports a leak through a doorway instead of returning the whole sheet', () => {
    const mask = binarise(roomMask(60, 60, [10, 10, 50, 40], 4))
    const hit = floodRegion(mask, [30, 25])
    expect(hit).not.toBeNull()
    expect(hit!.touchedBorder).toBe(true)
    expect(hit!.coverage).toBeGreaterThan(0.5)
  })

  it('closing a hairline gap first keeps the fill inside the room', () => {
    // The same doorway, but the walls are thickened by 2 px before filling, which bridges it.
    const mask = dilate(binarise(roomMask(60, 60, [10, 10, 50, 40], 4)), 2)
    const hit = floodRegion(mask, [30, 25])
    expect(hit).not.toBeNull()
    expect(hit!.touchedBorder).toBe(false)
  })

  it('returns a hole for an enclosed column', () => {
    const r = grey(60, 60, (x, y) => {
      const wall = (x === 5 || x === 55 || y === 5 || y === 55) && x >= 5 && x <= 55 && y >= 5 && y <= 55
      const column = x >= 25 && x <= 35 && y >= 25 && y <= 35
      return wall || column ? 0 : 255
    })
    const hit = floodRegion(binarise(r), [10, 10])
    expect(hit).not.toBeNull()
    expect(hit!.holes).toHaveLength(1)
    expect(hit!.holes[0]).toHaveLength(4)
  })
})

describe('boundaryLoops', () => {
  it('walks a single pixel as a unit square', () => {
    const filled = new Uint8Array(9)
    filled[4] = 1
    const loops = boundaryLoops(filled, 3, 3)
    expect(loops).toHaveLength(1)
    expect(loops[0]).toHaveLength(4)
    expect(Math.abs(signedArea2(loops[0]) / 2)).toBe(1)
  })

  it('winds the outer loop positive and a hole negative', () => {
    const filled = new Uint8Array(49)
    for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) filled[y * 7 + x] = 1
    filled[3 * 7 + 3] = 0
    const loops = boundaryLoops(filled, 7, 7)
    expect(loops).toHaveLength(2)
    expect(signedArea2(loops[0])).toBeGreaterThan(0)
    expect(signedArea2(loops[1])).toBeLessThan(0)
  })
})

describe('contours and snapping', () => {
  it('finds both faces of a drawn wall', () => {
    const r = grey(80, 80, (x, y) => (y >= 30 && y <= 33 && x >= 5 && x <= 74 ? 0 : 255))
    const paths = traceContours(binarise(r), { simplifyPx: 1, minPerimeterPx: 8, maxPoints: 1000 })
    expect(paths.length).toBe(1)
    expect(paths[0].closed).toBe(true)
    // One loop around the whole stroke: four corners.
    expect(paths[0].points).toHaveLength(4)
  })

  it('snaps to a corner in preference to the line running through it', () => {
    const idx = new SnapIndex([{ points: [[0, 0], [100, 0], [100, 100]], closed: false }])
    expect(idx.snap([98, 3], 10)).toEqual({ point: [100, 0], kind: 'vertex' })
    expect(idx.snap([50, 4], 10)).toEqual({ point: [50, 0], kind: 'edge' })
    expect(idx.snap([50, 40], 10).kind).toBe('none')
  })

  it('snaps across grid cells, so a long line has no dead spots', () => {
    const idx = new SnapIndex([{ points: [[0, 0], [1000, 0]], closed: false }], 48)
    expect(idx.snap([777, 2], 6).kind).toBe('edge')
    expect(idx.snap([777, 2], 6).point[0]).toBeCloseTo(777)
  })

  it('closestOnSegment clamps to the ends', () => {
    expect(closestOnSegment([-10, 5], [0, 0], [10, 0])).toEqual([0, 0])
    expect(closestOnSegment([50, 5], [0, 0], [10, 0])).toEqual([10, 0])
  })

  it('pointInPolygon', () => {
    const sq: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]]
    expect(pointInPolygon([5, 5], sq)).toBe(true)
    expect(pointInPolygon([15, 5], sq)).toBe(false)
  })
})

// ------------------------------------------------------------------ calibrate

describe('calibration', () => {
  it('scales from a known dimension', () => {
    const cal = calibrateByDistance([100, 100], [400, 100], 12)!
    expect(cal.pixelsPerMetre).toBeCloseTo(25)
    expect(pxToVenue([400, 100], cal).x).toBeCloseTo(12)
  })

  it('refuses a zero-length or zero-metre measurement', () => {
    expect(calibrateByDistance([10, 10], [10, 10], 5)).toBeNull()
    expect(calibrateByDistance([0, 0], [10, 0], 0)).toBeNull()
  })

  it('derives an exact scale from a paper scale', () => {
    // 1:50 rendered at 2 px per page point. One page point is 1/72 inch of paper, so it is
    // 50/72 inch = 17.64 mm of building; at 2 px per point that is 113.39 px/m.
    const cal = calibrateByPaperScale(50, 2, [0, 0])!
    expect(cal.pixelsPerMetre).toBeCloseTo((2 * 72) / (0.0254 * 50), 6)
    // A 10 m wall at 1:50 on paper is 200 mm, which at 2 px/pt is 1133.86 px.
    expect(10 * cal.pixelsPerMetre).toBeCloseTo(1133.858, 2)
  })

  it('flips Y, because raster rows run down and venue Y runs up', () => {
    const cal = cal1([100, 100])
    expect(pxToVenue([100, 50], cal)).toEqual({ x: 0, y: 50 })
    expect(pxToVenue([100, 150], cal)).toEqual({ x: 0, y: -50 })
  })

  it('venueToPx is the exact inverse of pxToVenue', () => {
    const cal = calibrateByDistance([37, 91], [500, 260], 22.5)!
    const v = pxToVenue([812, 143], cal)
    const back = venueToPx(v.x, v.y, cal)
    expect(back[0]).toBeCloseTo(812, 9)
    expect(back[1]).toBeCloseTo(143, 9)
  })

  it('a scale bar picks a round length', () => {
    expect(scaleBarStep(0.05).metres).toBe(5)
    expect([1, 2, 5]).toContain(scaleBarStep(0.02).metres)
  })
})

// -------------------------------------------------------------------- heights

describe('height fitting', () => {
  it('is exact for a flat surface', () => {
    const f = fitHeightPlane([
      { x: 0, y: 0, z: 3 },
      { x: 10, y: 0, z: 3 },
      { x: 10, y: 8, z: 3 },
      { x: 0, y: 8, z: 3 },
    ])
    expect(f.maxResidual).toBeCloseTo(0, 9)
    expect(heightAt(f, 5, 4)).toBeCloseTo(3)
    expect(slopeOf(f).gradient).toBeCloseTo(0, 9)
  })

  it('is exact for a constant rake', () => {
    // 0 at the front, 2.5 at the back, 12.5 m deep: a 1 in 5 rake.
    const f = fitHeightPlane([
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 10, z: 0 },
      { x: 12.5, y: 10, z: 2.5 },
      { x: 12.5, y: 0, z: 2.5 },
    ])
    expect(f.maxResidual).toBeCloseTo(0, 9)
    expect(f.a).toBeCloseTo(0.2)
    expect(f.b).toBeCloseTo(0, 9)
    expect(slopeOf(f).oneIn).toBeCloseTo(5)
  })

  it('reports the residual when the typed heights are not coplanar', () => {
    const f = fitHeightPlane([
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 },
      { x: 10, y: 10, z: 0 },
      { x: 0, y: 10, z: 1 },
    ])
    expect(f.degenerate).toBe(false)
    expect(f.maxResidual).toBeGreaterThan(0.2)
  })

  it('falls back to a level surface when the outline is collinear in plan', () => {
    const f = fitHeightPlane([
      { x: 0, y: 0, z: 0 },
      { x: 5, y: 0, z: 2 },
      { x: 10, y: 0, z: 4 },
    ])
    expect(f.degenerate).toBe(true)
    expect(f.c).toBeCloseTo(2)
  })

  it('stays conditioned a long way from the origin', () => {
    const f = fitHeightPlane([
      { x: 1000, y: 1000, z: 0 },
      { x: 1010, y: 1000, z: 1 },
      { x: 1010, y: 1008, z: 1 },
      { x: 1000, y: 1008, z: 0 },
    ])
    expect(f.a).toBeCloseTo(0.1, 6)
    expect(f.maxResidual).toBeCloseTo(0, 6)
  })

  it('ramps between two anchors and keeps going past them', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ]
    const zs = rampHeights(pts, 0, 2, 0, 2)
    expect(zs).toEqual([0, 1, 2, 4])
  })
})

// ---------------------------------------------------------------------- build

describe('building geometry from a trace', () => {
  it('turns a level rectangle into one flat surface at the typed height', () => {
    const g = regionGeometry(region({ vertices: rectVertices(0, 0, 10, 8, 2.5) }), cal1())
    expect(g.warnings).toEqual([])
    expect(g.areaM2).toBeCloseTo(80)
    expect(g.positions.length).toBe(2 * 9)
    for (let i = 2; i < g.positions.length; i += 3) expect(g.positions[i]).toBeCloseTo(2.5)
  })

  it('winds every surface so its normal points up, whichever way round it was clicked', () => {
    const anticlockwise = rectVertices(0, 0, 10, 8, 0)
    const clockwise = [...anticlockwise].reverse()
    for (const vertices of [anticlockwise, clockwise]) {
      const g = regionGeometry(region({ vertices }), cal1())
      const p = g.positions
      // Cross product of the first triangle's edges: z must be positive.
      const ux = p[3] - p[0]
      const uy = p[4] - p[1]
      const vx = p[6] - p[0]
      const vy = p[7] - p[1]
      expect(ux * vy - uy * vx).toBeGreaterThan(0)
    }
  })

  it('plane mode puts a warped quad back on one plane and says by how much', () => {
    const g = regionGeometry(region({ vertices: rectVertices(0, 0, 10, 10, [0, 0, 0, 1]) }), cal1())
    expect(g.maxResidual).toBeGreaterThan(0.2)
    expect(g.warnings.join(' ')).toMatch(/not coplanar/)
    // One region, one plane: the planarizer sees a single flat surface.
    const node = { id: 'r1', name: 'Stalls', tags: [], positions: g.positions, children: [] }
    const out = convertNode(node, PlaneType.Listening, DEFAULT_CONVERT)
    expect(out.stats.regionsFound).toBe(1)
  })

  it('free mode keeps the typed heights and warns that it will split', () => {
    const r = region({ heightMode: 'free', vertices: rectVertices(0, 0, 10, 10, [0, 0, 0, 1]) })
    const g = regionGeometry(r, cal1())
    expect(g.maxResidual).toBe(0)
    expect(g.warnings.join(' ')).toMatch(/several ArrayCalc objects/)
    const zs = [...g.positions].filter((_, i) => i % 3 === 2)
    expect(Math.max(...zs)).toBeCloseTo(1)
    const node = { id: 'r1', name: 'Stalls', tags: [], positions: g.positions, children: [] }
    expect(convertNode(node, PlaneType.Listening, DEFAULT_CONVERT).stats.regionsFound).toBe(2)
  })

  it('a raked deck stays one ArrayCalc quad', () => {
    // 20 m wide, 12.5 m deep, rising 2.5 m: exactly a plane, so it must not split.
    const r = region({ vertices: rectVertices(0, 0, 20, 12.5, [0, 0, 2.5, 2.5]) })
    const g = regionGeometry(r, cal1())
    expect(g.maxResidual).toBeCloseTo(0, 9)
    const node = { id: 'r1', name: 'Raked stalls', tags: [], positions: g.positions, children: [] }
    const out = convertNode(node, PlaneType.Listening, { ...DEFAULT_CONVERT, fit: 'rect' })
    expect(out.stats.regionsFound).toBe(1)
    expect(out.objects).toHaveLength(1)
    expect(out.objects[0].shape).toBe(Shape.Quad)
    expect(out.stats.quadsSplit).toBe(0)
  })

  it('a recessed pit comes out below the datum', () => {
    const g = regionGeometry(region({ vertices: rectVertices(0, 0, 6, 4, -2.1) }), cal1())
    const zs = [...g.positions].filter((_, i) => i % 3 === 2)
    expect(Math.min(...zs)).toBeCloseTo(-2.1)
    expect(Math.max(...zs)).toBeCloseTo(-2.1)
  })

  it('cuts a hole out of a surface and gives its corners the fitted height', () => {
    const r = region({
      vertices: rectVertices(0, 0, 20, 20, [0, 0, 2, 2]),
      holes: [[[8, 8], [12, 8], [12, 12], [8, 12]]],
    })
    const g = regionGeometry(r, cal1())
    expect(g.areaM2).toBeCloseTo(400)
    // Triangulated with a hole, so more than the two triangles a plain rectangle gives.
    expect(g.positions.length / 9).toBeGreaterThan(2)
    const node = { id: 'r1', name: 'Balcony', tags: [], positions: g.positions, children: [] }
    const out = convertNode(node, PlaneType.Listening, DEFAULT_CONVERT)
    expect(out.stats.regionsFound).toBe(1)
  })

  it('skips a region with no area, and flags one that crosses itself', () => {
    const empty = regionGeometry(region({ vertices: rectVertices(0, 0, 0.001, 0.001, 0) }), cal1())
    expect(empty.positions.length).toBe(0)
    expect(empty.warnings.join(' ')).toMatch(/encloses no area/)

    const bowtie = region({
      vertices: [
        { p: [0, 0], z: 0 },
        { p: [10, 10], z: 0 },
        { p: [10, 0], z: 0 },
        { p: [0, 10], z: 0 },
      ],
    })
    expect(regionGeometry(bowtie, cal1()).warnings.join(' ')).toMatch(/crosses itself/)
  })

  it('selfIntersects is quiet on a simple polygon', () => {
    expect(selfIntersects([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(false)
    expect(selfIntersects([[0, 0], [10, 10], [10, 0], [0, 10]])).toBe(true)
  })

  it('reports plan area and perimeter in metres', () => {
    const cal = calibrateByDistance([0, 0], [100, 0], 10)! // 10 px/m
    const r = region({ vertices: rectVertices(0, 0, 100, 50, 0) })
    expect(regionAreaM2(r, cal)).toBeCloseTo(50)
    expect(regionPerimeterM(r, cal)).toBeCloseTo(30)
  })
})

describe('buildTraceScene', () => {
  const doc = (regions: TraceRegion[], calibration = cal1()): TraceDocument => ({
    format: 'PDF',
    sourceName: 'plan.pdf',
    raster: { width: 100, height: 100, data: new Uint8ClampedArray(100 * 100 * 4) },
    paths: [],
    calibration,
    regions,
    warnings: [],
  })

  it('keys nodes by region id, so pruning survives an edit to the drawing', () => {
    const scene = buildTraceScene(doc([region({ id: 'abc', vertices: rectVertices(0, 0, 10, 10, 0) })]))
    expect(scene.nodes).toHaveLength(1)
    expect(scene.nodes[0].id).toBe('abc')
    expect(scene.nodes[0].suggestedPlaneType).toBe(PlaneType.Listening)
    expect(scene.nodes[0].tags).toContain('traced')
  })

  it('declares metres and Z up, because calibration already applied both', () => {
    const scene = buildTraceScene(doc([]))
    expect(scene.unitsPerMetre).toBe(1)
    expect(scene.upAxis).toBe('z')
  })

  it('leaves hidden regions out', () => {
    const scene = buildTraceScene(
      doc([
        region({ id: 'a', vertices: rectVertices(0, 0, 10, 10, 0) }),
        region({ id: 'b', visible: false, vertices: rectVertices(0, 0, 10, 10, 0) }),
      ]),
    )
    expect(scene.nodes.map((n) => n.id)).toEqual(['a'])
  })

  it('warns loudly while the drawing is uncalibrated', () => {
    const raster = { width: 100, height: 100 }
    const scene = buildTraceScene(
      doc([region({ vertices: rectVertices(0, 0, 10, 10, 0) })], DEFAULT_CALIBRATION(raster)),
    )
    expect(scene.warnings.join(' ')).toMatch(/not been calibrated/)
  })
})

// ------------------------------------------------------------------ pdf paths

describe('pdf vector paths', () => {
  const OPS = {
    save: 10,
    restore: 11,
    transform: 12,
    constructPath: 91,
    paintFormXObjectBegin: 74,
    paintFormXObjectEnd: 75,
  }
  // pdf.js DrawOPS: moveTo 0, lineTo 1, curveTo 2, quadraticCurveTo 3, closePath 4.
  const path = (buf: number[]) => ({ fnArray: [OPS.constructPath], argsArray: [[0, [new Float32Array(buf)], null]] })

  it('reads a polyline in page space through the viewport transform', () => {
    // The viewport transform pdf.js hands out for an unrotated page: y flipped, height h.
    const base: Mat = [1, 0, 0, -1, 0, 200]
    const r = pathsFromOperatorList(path([0, 10, 20, 1, 110, 20, 1, 110, 90]), OPS, base)
    expect(r.paths).toHaveLength(1)
    expect(r.paths[0].points).toEqual([
      [10, 180],
      [110, 180],
      [110, 110],
    ])
  })

  it('composes the transform stack, and unwinds it on restore', () => {
    const list = {
      fnArray: [OPS.save, OPS.transform, OPS.constructPath, OPS.restore, OPS.constructPath],
      argsArray: [
        [],
        [2, 0, 0, 2, 5, 5],
        [0, [new Float32Array([0, 0, 0, 1, 10, 0])], null],
        [],
        [0, [new Float32Array([0, 0, 0, 1, 10, 0])], null],
      ],
    }
    const r = pathsFromOperatorList(list, OPS, [1, 0, 0, 1, 0, 0])
    expect(r.paths[0].points).toEqual([
      [5, 5],
      [25, 5],
    ])
    expect(r.paths[1].points).toEqual([
      [0, 0],
      [10, 0],
    ])
  })

  it('treats a form XObject like a save/transform pair', () => {
    const list = {
      fnArray: [OPS.paintFormXObjectBegin, OPS.constructPath, OPS.paintFormXObjectEnd, OPS.constructPath],
      argsArray: [
        [[1, 0, 0, 1, 100, 0], null],
        [0, [new Float32Array([0, 0, 0, 1, 10, 0])], null],
        [],
        [0, [new Float32Array([0, 0, 0, 1, 10, 0])], null],
      ],
    }
    const r = pathsFromOperatorList(list, OPS, [1, 0, 0, 1, 0, 0])
    expect(r.paths[0].points[0]).toEqual([100, 0])
    expect(r.paths[1].points[0]).toEqual([0, 0])
  })

  it('closes a subpath and starts the next one at the same point', () => {
    const r = pathsFromOperatorList(
      path([0, 0, 0, 1, 10, 0, 1, 10, 10, 4]),
      OPS,
      [1, 0, 0, 1, 0, 0],
    )
    expect(r.paths).toHaveLength(1)
    expect(r.paths[0].closed).toBe(true)
    expect(r.paths[0].points).toHaveLength(3)
  })

  it('flattens a curve into segments', () => {
    const r = pathsFromOperatorList(
      path([0, 0, 0, 2, 0, 50, 50, 50, 50, 0]),
      OPS,
      [1, 0, 0, 1, 0, 0],
    )
    expect(r.paths[0].points.length).toBeGreaterThan(4)
    const last = r.paths[0].points[r.paths[0].points.length - 1]
    expect(last).toEqual([50, 0])
  })

  it('skips an unrecognised buffer with a warning instead of inventing geometry', () => {
    const r = pathsFromOperatorList(
      { fnArray: [OPS.constructPath], argsArray: [[0, [new Float32Array([99, 1, 2])], null]] },
      OPS,
      [1, 0, 0, 1, 0, 0],
    )
    expect(r.paths).toHaveLength(0)
    expect(r.warnings.join(' ')).toMatch(/does not recognise/)
  })

  it('says so when a page has no vector geometry at all', () => {
    const r = pathsFromOperatorList({ fnArray: [], argsArray: [] }, OPS, [1, 0, 0, 1, 0, 0])
    expect(r.warnings.join(' ')).toMatch(/scan or a flattened image/)
  })

  it('mul applies its second argument first', () => {
    // Scale by 2 then translate by 10: the point (1, 0) lands at (12, 0).
    const m = mul([1, 0, 0, 1, 10, 0], [2, 0, 0, 2, 0, 0])
    expect(m).toEqual([2, 0, 0, 2, 10, 0])
  })

  it('flattenCubic lands exactly on the end point', () => {
    const out: [number, number][] = []
    flattenCubic([0, 0], [0, 10], [10, 10], [10, 0], 2, out)
    expect(out[out.length - 1]).toEqual([10, 0])
  })
})

// ------------------------------------------------------------------- pipeline

describe('trace -> .dbacv, end to end', () => {
  const parser = new (new JSDOM().window.DOMParser)()

  it('a traced raked block reaches the venue file at the size and height it was drawn', () => {
    // A 2000 px wide sheet calibrated so 1000 px is 25 m, i.e. 40 px/m.
    const cal = calibrateByDistance([0, 500], [1000, 500], 25)!
    const doc: TraceDocument = {
      format: 'PDF',
      sourceName: 'plan.pdf',
      raster: { width: 2000, height: 1000, data: new Uint8ClampedArray(0) },
      paths: [],
      calibration: cal,
      regions: [
        region({
          id: 'stalls',
          name: 'Stalls',
          // 800 x 400 px = 20 x 10 m, rising from 0 at the front to 1.5 m at the back.
          vertices: rectVertices(100, 100, 900, 500, [0, 0, 1.5, 1.5]),
        }),
      ],
      warnings: [],
    }

    const scene = buildTraceScene(doc)
    expect(scene.nodes).toHaveLength(1)

    const result = convertNodes(
      [{ node: scene.nodes[0], planeType: PlaneType.Listening, include: true, name: 'Stalls' }],
      { ...DEFAULT_CONVERT, fit: 'rect' },
    )
    expect(result.objects).toHaveLength(1)

    const venue = {
      appVersion: '12.8.2',
      venueVersion: '9',
      projectName: 'Traced',
      date: formatDbacvDate(new Date(2026, 7, 2)),
      author: 'ArrayCAD',
      projectComments: '',
      venueComments: '',
      objects: result.objects,
    }
    const back = parseDbacv(writeDbacv(venue), parser)
    expect(back.objects).toHaveLength(1)

    const o = back.objects[0]
    // .dbacv rotations are in DEGREES.
    const c = Math.cos((o.rotation.z * Math.PI) / 180)
    const s = Math.sin((o.rotation.z * Math.PI) / 180)
    const world = o.points.map((p) => ({
      x: o.origin.x + p.x * c - p.y * s,
      y: o.origin.y + p.x * s + p.y * c,
      z: o.origin.z + p.z,
    }))
    const xs = world.map((p) => p.x)
    const ys = world.map((p) => p.y)
    const zs = world.map((p) => p.z)
    // 800 px wide at 40 px/m is 20 m across the venue X axis; 400 px deep is 10 m in plan
    // along Y, which is also the rake direction, so the surface itself is 10.11 m long and
    // the plan extent must still read exactly 10.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(20, 6)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(10, 6)
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(1.5, 6)
    // And it landed where it was drawn: the sheet origin was the left end of the scale line.
    expect(Math.min(...xs)).toBeCloseTo(2.5, 6)
    expect(Math.min(...ys)).toBeCloseTo(0, 6)
  })
})
