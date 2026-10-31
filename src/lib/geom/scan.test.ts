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
import { DEFAULT_PREPARE_SETTINGS, SQUARE_AGREEMENT, prepareScene, settingsForScene } from '../../state.ts'
import { RAKE_TAG, splitNode } from '../prepare/split.ts'
import { DEFAULT_CONVERT, convertNodes } from './convert.ts'
import { nodeOutlines } from './outline.ts'
import { DEFAULT_PLANARIZE, type PlanarizeOptions, findCoplanarRegions, weld } from './planarize.ts'
import { findScanRegions, guessSurface } from './scan.ts'
import { DEFAULT_TRANSFORM, type TransformOptions, squareToWalls } from './transform.ts'

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
    // What that cost: the planes sit about the scan's own noise off it, and nothing is lost.
    const d = converted.stats.deviation
    expect(d.rms).toBeGreaterThan(0.75 * stats.scan!.noise)
    expect(d.rms).toBeLessThan(1.5 * stats.scan!.noise)
    expect(d.lost / d.area).toBeLessThan(0.01)
    expect(converted.stats.scan?.band).toBeGreaterThan(0)
    // 150,000 triangles reduced twice: a few seconds, and more on a busy machine.
  }, 30_000)

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

/** One side of a regular octagon of radius `r`, so a grid of a quarter of it fits each side. */
function len8(r: number): number {
  return 2 * r * Math.sin(Math.PI / 8)
}

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

/** Patches turned `deg` about the vertical through the origin. */
function turned(patches: Patch[], deg: number): Patch[] {
  const r = (deg * Math.PI) / 180
  const t = (p: V): V => [p[0] * Math.cos(r) - p[1] * Math.sin(r), p[0] * Math.sin(r) + p[1] * Math.cos(r), p[2]]
  return patches.map((p) => ({ ...p, o: t(p.o), u: t(p.u), v: t(p.v) }))
}

describe('squaring the heading to the walls', () => {
  const modelled = (deg: number) => [node(scanOf(turned(ROOM, deg), 0.5, 0))]

  it('finds the smallest turn that puts the walls on the axes', () => {
    expect(squareToWalls(modelled(17.3), metres)!.turnDeg).toBeCloseTo(-17.3, 6)
    expect(squareToWalls(modelled(-40), metres)!.turnDeg).toBeCloseTo(40, 6)
    // 50° off is 40° short of the next axis, the other way.
    expect(squareToWalls(modelled(50), metres)!.turnDeg).toBeCloseTo(40, 6)
    const square = squareToWalls(modelled(0), metres)!
    expect(Math.abs(square.turnDeg)).toBeLessThan(1e-6)
    expect(square.agreement).toBeCloseTo(1, 6)
    expect(square.wallArea).toBeCloseTo(108, 6)
  })

  it('is relative to the heading already set, and to the room the heading turns', () => {
    const at = squareToWalls(modelled(17.3), { ...metres, headingDeg: 10 })!
    expect(at.turnDeg).toBeCloseTo(-27.3, 6)
    const done = squareToWalls(modelled(17.3), { ...metres, headingDeg: 10 + at.turnDeg })!
    expect(Math.abs(done.turnDeg)).toBeLessThan(1e-6)
    // The mirror comes after the heading. Squaring is the same turn either way.
    expect(squareToWalls(modelled(17.3), { ...metres, flipX: true })!.turnDeg).toBeCloseTo(-17.3, 6)
  })

  it('reads a Y-up model in venue space', () => {
    // The room turned 17.3° about Z, then written Y-up: venue (x, y, z) is source (x, z, -y).
    const zUp = scanOf(turned(ROOM, 17.3), 0.5, 0)
    const yUp = new Float64Array(zUp.length)
    for (let i = 0; i < zUp.length; i += 3) {
      yUp[i] = zUp[i]
      yUp[i + 1] = zUp[i + 2]
      yUp[i + 2] = -zUp[i + 1]
    }
    expect(squareToWalls([node(yUp)], { ...metres, upAxis: 'y' })!.turnDeg).toBeCloseTo(-17.3, 6)
  })

  it('follows the room, not a splayed wall', () => {
    // A fan: back and side walls square at 12°, two long splays at 12 ± 15° on top.
    const splay = (deg: number): Patch => ({ o: [20, 0, 0], u: [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0], v: Z, lu: 12, lv: 3 })
    const fan = [...turned(ROOM, 12), ...turned([splay(90 - 15), splay(90 + 15)], 12)]
    const found = squareToWalls([node(scanOf(fan, 0.5, 0))], metres)!
    expect(found.turnDeg).toBeCloseTo(-12, 6)
    expect(found.agreement).toBeLessThan(1)
  })

  it('reads a scan through its noise', () => {
    const found = squareToWalls([node(scanOf(turned(ROOM, 23), 0.1, 0.01))], metres)!
    expect(found.turnDeg).toBeCloseTo(-23, 0)
    expect(Math.abs(found.turnDeg + 23)).toBeLessThan(0.2)
    // Each wall triangle faces up to ten degrees astray, and the walls still agree. Counting
    // only the walls within 2° of the answer read this as a quarter of the room, and the
    // first scan tried in the app was not squared.
    expect(found.agreement).toBeGreaterThan(0.6)
  })

  it('does not square a room with no one set of right angles', () => {
    // An octagon: its walls face every 45°, so no turn puts more of them on the axes.
    const r = 8
    const sides: Patch[] = []
    for (let k = 0; k < 8; k++) {
      const a0 = (k * Math.PI) / 4
      const a1 = ((k + 1) * Math.PI) / 4
      const p0: V = [r * Math.cos(a0), r * Math.sin(a0), 0]
      const len = Math.hypot(r * Math.cos(a1) - p0[0], r * Math.sin(a1) - p0[1])
      sides.push({ o: p0, u: [(r * Math.cos(a1) - p0[0]) / len, (r * Math.sin(a1) - p0[1]) / len, 0], v: Z, lu: len, lv: 3 })
    }
    const found = squareToWalls([node(scanOf(sides, len8(r) / 4, 0))], metres)!
    expect(found.agreement).toBeLessThan(SQUARE_AGREEMENT)
  })

  it('has nothing to say about a plan with no walls', () => {
    expect(squareToWalls([node(scanOf([ROOM[0]], 0.5, 0))], metres)).toBeNull()
  })

  it('squares a scan when the file opens, and leaves a drawing as drawn', () => {
    const scan = { format: 'OBJ', sourceName: 'scan.obj', nodes: [node(scanOf(turned(ROOM, 23), 0.1, 0.008))], warnings: [], unitsPerMetre: 1, upAxis: 'z' as const }
    expect(settingsForScene(scan).transform.headingDeg).toBeCloseTo(-23, 0)
    const drawing = { ...scan, nodes: modelled(23) }
    expect(settingsForScene(drawing).planarize.surface).toBe('cad')
    expect(settingsForScene(drawing).transform.headingDeg).toBe(0)
  })
})
