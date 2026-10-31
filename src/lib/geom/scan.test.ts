/**
 * Finding planes in a scan, against scans whose right answer is known by construction.
 *
 * There is no real scan in the repo — nobody has handed one over with a licence to keep —
 * so the scans here are made: rooms meshed on a grid the way a scanner's mesher lays them
 * out, every vertex moved by Gaussian noise. That makes "the floor is 80 m²" an assertion
 * rather than an observation. What it cannot model is a real scanner's own artefacts —
 * smoothing, holes in shadow, drift — which is the gap to close with the first real scan.
 */

import { describe, expect, it } from 'vitest'
import type { ImportedNode } from '../import/types.ts'
import { DEFAULT_PREPARE_SETTINGS, prepareScene, settingsForScene } from '../../state.ts'
import { RAKE_TAG, splitNode } from '../prepare/split.ts'
import { DEFAULT_CONVERT, convertNodes } from './convert.ts'
import { nodeOutlines } from './outline.ts'
import { DEFAULT_PLANARIZE, type PlanarizeOptions, findCoplanarRegions, weld } from './planarize.ts'
import { findScanRegions, guessSurface } from './scan.ts'
import { DEFAULT_TRANSFORM, type TransformOptions } from './transform.ts'

const metres: TransformOptions = { ...DEFAULT_TRANSFORM, unitsPerMetre: 1, upAxis: 'z' }
const SCAN: PlanarizeOptions = { ...DEFAULT_PLANARIZE, surface: 'scan' }

type V = [number, number, number]

/** A flat rectangle: from `o`, `lu` metres along unit `u` and `lv` along unit `v`. */
interface Patch {
  o: V
  u: V
  v: V
  lu: number
  lv: number
  /** Grid cells to leave out, as [i, j] — a hole the scanner did not see. */
  skip?: (i: number, j: number) => boolean
}

/**
 * Mesh patches on a grid of `edge` and move every vertex by noise of `sigma` on each axis.
 * Vertices at the same place are the same vertex, so patches that meet share their edge,
 * as a scanner's single mesh does. Seeded, so a failure reproduces.
 */
function scanOf(patches: Patch[], edge: number, sigma: number, seed = 1): Float64Array {
  let s = seed >>> 0
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand())
  const moved = new Map<string, V>()
  const at = (x: number, y: number, z: number): V => {
    const k = `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`
    let p = moved.get(k)
    if (!p) {
      p = [x + gauss() * sigma, y + gauss() * sigma, z + gauss() * sigma]
      moved.set(k, p)
    }
    return p
  }
  const out: number[] = []
  for (const { o, u, v, lu, lv, skip } of patches) {
    const nu = Math.round(lu / edge)
    const nv = Math.round(lv / edge)
    const grid = (i: number, j: number) =>
      at(o[0] + (u[0] * i + v[0] * j) * edge, o[1] + (u[1] * i + v[1] * j) * edge, o[2] + (u[2] * i + v[2] * j) * edge)
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        if (skip?.(i, j)) continue
        const a = grid(i, j)
        const b = grid(i + 1, j)
        const c = grid(i + 1, j + 1)
        const d = grid(i, j + 1)
        out.push(...a, ...b, ...c, ...a, ...c, ...d)
      }
    }
  }
  return Float64Array.from(out)
}

const X: V = [1, 0, 0]
const Y: V = [0, 1, 0]
const Z: V = [0, 0, 1]

/** A 10 x 8 m room, 3 m high, open at the top: floor and four walls. */
const ROOM: Patch[] = [
  { o: [0, 0, 0], u: X, v: Y, lu: 10, lv: 8 },
  { o: [0, 0, 0], u: X, v: Z, lu: 10, lv: 3 },
  { o: [0, 8, 0], u: X, v: Z, lu: 10, lv: 3 },
  { o: [0, 0, 0], u: Y, v: Z, lu: 8, lv: 3 },
  { o: [10, 0, 0], u: Y, v: Z, lu: 8, lv: 3 },
]
const ROOM_AREAS = [80, 30, 30, 24, 24]

/** Degrees between a normal and the nearest axis. */
const offAxis = (n: { x: number; y: number; z: number }) =>
  (Math.acos(Math.min(1, Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z)))) * 180) / Math.PI

const node = (positions: Float64Array, name = 'scan'): ImportedNode => ({ id: name, name, tags: [], positions, children: [] })

describe('the gap this closes', () => {
  it('the CAD flood fill finds nothing in a room scanned with 5 mm of noise', () => {
    const regions = findCoplanarRegions(weld(scanOf(ROOM, 0.05, 0.005), 0.001))
    const kept = regions.reduce((s, r) => s + r.area, 0)
    expect(kept).toBeLessThan(1)
  })

  it('and loosening it far enough to find the room loses the rake beside it', () => {
    // A 1:2 rake (26.6°) running up from the floor. The only CAD tolerances that recover the
    // noisy floor take the rake in with it.
    const rake: Patch = { o: [10, 0, 0], u: [2 / Math.sqrt(5), 0, 1 / Math.sqrt(5)], v: Y, lu: Math.sqrt(5) * 2, lv: 8 }
    const mesh = weld(scanOf([ROOM[0], rake], 0.1, 0.01), 0.001)
    const loose = findCoplanarRegions(mesh, { ...DEFAULT_PLANARIZE, angleTolerance: 45, offsetTolerance: 0.5 })
    expect(loose[0].area).toBeGreaterThan(80 + 10)
    const scanned = findScanRegions(mesh, SCAN).regions
    expect(scanned).toHaveLength(2)
    expect(scanned[0].area).toBeCloseTo(80, -0.5)
  })
})

describe('a scanned room', () => {
  for (const [edge, sigma] of [
    [0.05, 0.005],
    [0.05, 0.01],
    [0.1, 0.02],
  ]) {
    it(`comes back as its five surfaces: ${edge * 100} cm mesh, ${sigma * 1000} mm noise`, () => {
      const { regions, report } = findScanRegions(weld(scanOf(ROOM, edge, sigma), 0.001), SCAN)
      expect(regions).toHaveLength(5)
      regions.forEach((r, i) => {
        // Area as the plane sees it, so noise does not crumple it bigger.
        expect(Math.abs(r.area - ROOM_AREAS[i]) / ROOM_AREAS[i]).toBeLessThan(0.02)
        expect(offAxis(r.plane.normal)).toBeLessThan(0.2)
      })
      // The noise is measured, not assumed: a centroid averages three vertices, so σ/√3.
      expect(report.noise).toBeGreaterThan((0.75 * sigma) / Math.sqrt(3))
      expect(report.noise).toBeLessThan((1.25 * sigma) / Math.sqrt(3))
      // A grid cell is two sides and a diagonal, and noise only lengthens them.
      expect(report.edge).toBeGreaterThan(edge)
      expect(report.edge).toBeLessThan(1.3 * edge)
    })
  }

  it('reports the band it used, and never narrower than the offset tolerance', () => {
    const quiet = findScanRegions(weld(scanOf(ROOM, 0.1, 0.002), 0.001), SCAN).report
    expect(quiet.band).toBe(DEFAULT_PLANARIZE.offsetTolerance)
    const loud = findScanRegions(weld(scanOf(ROOM, 0.1, 0.02), 0.001), SCAN).report
    expect(loud.band).toBeGreaterThan(DEFAULT_PLANARIZE.offsetTolerance)
    expect(loud.band).toBeCloseTo(3 * loud.noise, 6)
  })

  it('is wound the way the scan was', () => {
    // Every patch of ROOM is wound with its normal along u × v. Flip the floor's winding and
    // its region must face the other way.
    const flipped = [{ ...ROOM[0], o: [0, 8, 0] as V, v: [0, -1, 0] as V }, ...ROOM.slice(1)]
    const up = findScanRegions(weld(scanOf(ROOM, 0.1, 0.005), 0.001), SCAN).regions[0]
    const down = findScanRegions(weld(scanOf(flipped, 0.1, 0.005), 0.001), SCAN).regions[0]
    expect(up.plane.normal.z).toBeGreaterThan(0.99)
    expect(down.plane.normal.z).toBeLessThan(-0.99)
  })

  it('sets a floor exactly level, and leaves one that really falls with its fall', () => {
    const level = findScanRegions(weld(scanOf(ROOM, 0.1, 0.01), 0.001), SCAN).regions
    expect(level[0].plane.normal).toEqual({ x: 0, y: 0, z: 1 })
    // Walls plumb too: no vertical component left.
    for (const wall of level.slice(1)) expect(wall.plane.normal.z).toBe(0)
    // 1:100 across 10 m is 10 cm, far outside the band: a drained floor, not noise.
    const fall = Math.atan(0.01)
    const drained: Patch = { ...ROOM[0], u: [Math.cos(fall), 0, Math.sin(fall)] }
    const kept = findScanRegions(weld(scanOf([drained], 0.1, 0.01), 0.001), SCAN).regions[0]
    expect(Math.abs(kept.plane.normal.x)).toBeCloseTo(Math.sin(fall), 3)
  })

  it('gives the same regions every time', () => {
    const mesh = weld(scanOf(ROOM, 0.1, 0.01), 0.001)
    const a = findScanRegions(mesh, SCAN).regions
    const b = findScanRegions(mesh, SCAN).regions
    expect(b.map((r) => r.triangles)).toEqual(a.map((r) => r.triangles))
  })

  it('reduces to five clean outlines and a handful of ArrayCalc objects', () => {
    const scan = node(scanOf(ROOM, 0.05, 0.01))
    const opts = { ...DEFAULT_CONVERT, transform: metres, planarize: SCAN }
    const { outlines, stats } = nodeOutlines(scan, opts)
    expect(outlines).toHaveLength(5)
    expect(stats.scan?.noise).toBeGreaterThan(0)
    for (const o of outlines) {
      // A rectangle, give or take a corner the shaving left: not the zigzag of the mesh.
      expect(o.outer.length).toBeLessThanOrEqual(6)
      expect(o.holes).toHaveLength(0)
    }
    const floor = outlines.find((o) => Math.abs(o.basis.n.z) > 0.99)!
    const us = floor.outer.map((p) => p[0])
    const vs = floor.outer.map((p) => p[1])
    const spans = [Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs)].sort((a, b) => b - a)
    expect(spans[0]).toBeCloseTo(10, 1)
    expect(spans[1]).toBeCloseTo(8, 1)
    const converted = convertNodes([{ node: scan, planeType: 1, include: true, name: 'scan' }], opts)
    // One object a surface: a scanned floor fits a plane a hair off level, and left there its
    // rectangle has no level edge and splits into two triangles.
    expect(converted.stats.objectsOut).toBe(5)
    expect(converted.stats.quadsSplit).toBe(0)
    expect(converted.stats.scan?.band).toBeGreaterThan(0)
  })

  it('leaves out a small hole the scanner did not see, and keeps a stair well', () => {
    const missed = (cx: number, cy: number, n: number) => (i: number, j: number) =>
      i >= cx && i < cx + n && j >= cy && j < cy + n
    const floor = (skip: Patch['skip']): Patch => ({ ...ROOM[0], skip })
    const opts = { ...DEFAULT_CONVERT, transform: metres, planarize: SCAN }
    // 0.5 m square: under a seat.
    const small = nodeOutlines(node(scanOf([floor(missed(30, 30, 5)), ...ROOM.slice(1)], 0.1, 0.005)), opts)
    expect(small.outlines.find((o) => Math.abs(o.basis.n.z) > 0.99)!.holes).toHaveLength(0)
    // 2 m square: a stair well, which a listening plane must not cover.
    const well = nodeOutlines(node(scanOf([floor(missed(30, 30, 20)), ...ROOM.slice(1)], 0.1, 0.005)), opts)
    expect(well.outlines.find((o) => Math.abs(o.basis.n.z) > 0.99)!.holes).toHaveLength(1)
  })
})

describe('what it must not merge', () => {
  it('a stepped rake keeps every tread its own level plane', () => {
    const rows = 8
    const patches: Patch[] = []
    for (let k = 0; k < rows; k++) {
      patches.push({ o: [k * 0.9, 0, k * 0.3], u: X, v: Y, lu: 0.9, lv: 6 })
      if (k > 0) patches.push({ o: [k * 0.9, 0, (k - 1) * 0.3], u: Z, v: Y, lu: 0.3, lv: 6 })
    }
    const { regions } = findScanRegions(weld(scanOf(patches, 0.1, 0.005), 0.001), { ...SCAN, minArea: 0.5 })
    const treads = regions.filter((r) => Math.abs(r.plane.normal.z) > 0.99)
    expect(treads).toHaveLength(rows)
    const heights = treads.map((r) => r.plane.point.z).sort((a, b) => a - b)
    heights.forEach((z, k) => expect(z).toBeCloseTo(k * 0.3, 1))
    for (const r of treads) expect(r.area).toBeCloseTo(5.4, 0)
  })

  it('a column is not one plane', () => {
    // A 1 m radius cylinder, 3 m tall, meshed in 64 strips with noise on top.
    const strips = 64
    const patches: Patch[] = []
    for (let k = 0; k < strips; k++) {
      const a0 = (2 * Math.PI * k) / strips
      const a1 = (2 * Math.PI * (k + 1)) / strips
      const p0: V = [Math.cos(a0), Math.sin(a0), 0]
      const len = Math.hypot(Math.cos(a1) - p0[0], Math.sin(a1) - p0[1])
      patches.push({ o: p0, u: [(Math.cos(a1) - p0[0]) / len, (Math.sin(a1) - p0[1]) / len, 0], v: Z, lu: len, lv: 3 })
    }
    const { regions } = findScanRegions(weld(scanOf(patches, len64(), 0.002), 0.002), SCAN)
    expect(regions.length).toBeGreaterThan(4)
    for (const r of regions) expect(r.area).toBeLessThan(0.5 * 2 * Math.PI * 3)
  })

  it('a modelled box read as a scan is still six faces', () => {
    const box = scanOf(
      [
        { o: [0, 0, 0], u: X, v: Y, lu: 2, lv: 2 },
        { o: [0, 0, 2], u: Y, v: X, lu: 2, lv: 2 },
        { o: [0, 0, 0], u: Z, v: X, lu: 2, lv: 2 },
        { o: [0, 2, 0], u: X, v: Z, lu: 2, lv: 2 },
        { o: [0, 0, 0], u: Y, v: Z, lu: 2, lv: 2 },
        { o: [2, 0, 0], u: Z, v: Y, lu: 2, lv: 2 },
      ],
      2,
      0,
    )
    expect(box.length / 9).toBe(12)
    const { regions, report } = findScanRegions(weld(box, 0.001), SCAN)
    expect(regions).toHaveLength(6)
    expect(report.noise).toBe(0)
    for (const r of regions) expect(r.area).toBeCloseTo(4, 6)
  })
})

/** Edge length of one strip of the 64-strip column, so the grid fits it exactly. */
function len64(): number {
  return 2 * Math.sin(Math.PI / 64)
}

describe('degenerate input', () => {
  it('does not throw on nothing, one triangle or a sliver', () => {
    expect(findScanRegions(weld(new Float64Array(0), 0.001), SCAN).regions).toEqual([])
    const one = findScanRegions(weld(Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), 0.001), { ...SCAN, minArea: 0 })
    expect(one.regions).toHaveLength(1)
    const flat = findScanRegions(weld(Float64Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0]), 0.001), { ...SCAN, minArea: 0 })
    expect(flat.regions).toEqual([])
  })
})

describe('guessing a scan', () => {
  it('reads a scanned room as a scan and the same room modelled as CAD', () => {
    expect(guessSurface([node(scanOf(ROOM, 0.1, 0.005))], metres, 0.001).kind).toBe('scan')
    const modelled = guessSurface([node(scanOf(ROOM, 0.1, 0))], metres, 0.001)
    expect(modelled.kind).toBe('cad')
    expect(modelled.coplanarShare).toBe(1)
  })

  it('settles the setting when the file opens', () => {
    const scene = { format: 'OBJ', sourceName: 'scan.obj', nodes: [node(scanOf(ROOM, 0.1, 0.005))], warnings: [], unitsPerMetre: 1, upAxis: 'z' as const }
    expect(settingsForScene(scene).planarize.surface).toBe('scan')
    expect(settingsForScene({ ...scene, alreadyAVenue: true }).planarize.surface).toBe('cad')
  })
})

describe('splitting a scanned one-piece theatre', () => {
  // A 16 x 8 m auditorium, 5 m high: a flat floor at the front, ten rows of stepped seating
  // 0.9 m deep and 0.3 m high behind it, walls and a ceiling. One node, no names, noise on
  // every vertex — what a phone scan of a small theatre exports as one OBJ.
  const rows = 10
  const patches: Patch[] = [{ o: [0, 0, 0], u: X, v: Y, lu: 6, lv: 8 }]
  for (let k = 0; k < rows; k++) {
    patches.push({ o: [6 + k * 0.9, 0, (k + 1) * 0.3], u: X, v: Y, lu: 0.9, lv: 8 })
    patches.push({ o: [6 + k * 0.9, 0, k * 0.3], u: Z, v: Y, lu: 0.3, lv: 8 })
  }
  patches.push(
    { o: [0, 0, 0], u: X, v: Z, lu: 16, lv: 5 },
    { o: [0, 8, 0], u: X, v: Z, lu: 16, lv: 5 },
    { o: [0, 0, 0], u: Y, v: Z, lu: 8, lv: 5 },
    { o: [15, 0, 0], u: Y, v: Z, lu: 8, lv: 5 },
    { o: [0, 0, 5], u: Y, v: X, lu: 8, lv: 15 },
  )
  const theatre = node(scanOf(patches, 0.1, 0.005), 'Polycam scan')

  it('finds the rake by its steps, as it does in a model', () => {
    const split = splitNode(theatre, metres, { surface: 'scan' })
    expect(split).not.toBeNull()
    const rakes = split!.parts.filter((p) => p.tags.includes(RAKE_TAG))
    expect(rakes.length).toBeGreaterThanOrEqual(1)
    expect(split!.parts.map((p) => p.name)).toEqual(expect.arrayContaining(['Floor', 'Ceiling', 'Walls']))
    // Nothing lost: every triangle of the scan is in exactly one part.
    const parts = split!.parts.reduce((s, p) => s + p.positions.length, 0)
    expect(parts).toBeGreaterThanOrEqual(theatre.positions.length)
  })

  it('and finds nothing to split when read as a model', () => {
    // The CAD reading sees thousands of one-triangle regions and no treads among them.
    const split = splitNode(theatre, metres, { surface: 'cad' })
    expect(split?.rakes ?? 0).toBe(0)
  })

  it('prepares it into an audience plane at the rake drawn', () => {
    const scene = { format: 'OBJ', sourceName: 'scan.obj', nodes: [theatre], warnings: [], unitsPerMetre: 1, upAxis: 'z' as const }
    const settings = settingsForScene(scene)
    expect(settings.planarize.surface).toBe('scan')
    const prepared = prepareScene(scene, settings.transform, DEFAULT_PREPARE_SETTINGS, settings.planarize.surface)
    expect(prepared.surface).toBe('scan')
    expect(prepared.split?.rakes).toBeGreaterThanOrEqual(1)
    // Re-cutting is for exactly flat surfaces, which a scan has none of.
    expect(prepared.simplify).toBeNull()
    expect(prepared.plan.seating.length).toBeGreaterThanOrEqual(1)
  })
})
