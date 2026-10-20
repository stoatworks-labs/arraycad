/**
 * Splitting a one-piece model, against models whose right answer is known by construction.
 *
 * `demo/demo-onepiece.obj` is the main fixture: a theatre as one Y-up mesh with a stepped
 * fan of stalls, a balcony overhanging them, a stage with a stair, a floor wound upside
 * down, walls, a ceiling and a stray OBJ line. Its geometry is written down in
 * `scripts/make_demo_onepiece.py`, so the slopes asserted here are the generator's.
 *
 * Weighted, like the rest of the preparation tests, towards what must NOT happen: one plane
 * through two tiers, a stair read as seating, a floor typed as an obstacle.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PlaneType } from '../dbacv/types.ts'
import { importMesh } from '../import/mesh.ts'
import { type ImportedNode, type ImportedScene, countTriangles, flattenNodes } from '../import/types.ts'
import { DEFAULT_CONVERT, convertNodes } from '../geom/convert.ts'
import { DEFAULT_RATIONALISE, rationalise } from '../geom/rationalise.ts'
import { DEFAULT_TRANSFORM, type TransformOptions, applyTransform } from '../geom/transform.ts'
import { triArea, v3 } from '../geom/vec.ts'
import {
  DEFAULT_PREPARE_SETTINGS,
  conversionEntries,
  rationalisationsFromPlan,
  rationalisedAreas,
  applyPlan,
  prepareScene,
  seedDecisions,
  settingsForScene,
  convertOptions,
} from '../../state.ts'
import { LevelIndex, RAKE_TAG, levelKind, preparePlan, splitNode, splitScene } from './index.ts'

const metres: TransformOptions = { ...DEFAULT_TRANSFORM, unitsPerMetre: 1 }

/** Total area of a node's triangles, in venue m², under a transform. */
function areaOf(n: ImportedNode, t: TransformOptions): number {
  const p = applyTransform(n.positions, t)
  let a = 0
  for (let i = 0; i + 8 < p.length; i += 9) {
    a += triArea(v3(p[i], p[i + 1], p[i + 2]), v3(p[i + 3], p[i + 4], p[i + 5]), v3(p[i + 6], p[i + 7], p[i + 8]))
  }
  return a
}

/** Venue z range of a node. */
function zRange(n: ImportedNode, t: TransformOptions): [number, number] {
  const p = applyTransform(n.positions, t)
  let lo = Infinity
  let hi = -Infinity
  for (let i = 2; i < p.length; i += 3) {
    lo = Math.min(lo, p[i])
    hi = Math.max(hi, p[i])
  }
  return [lo, hi]
}

const slopeDeg = (normalZ: number) => (Math.acos(Math.abs(normalZ)) * 180) / Math.PI

describe('the one-piece demo theatre', async () => {
  const bytes = readFileSync(new URL('../../../demo/demo-onepiece.obj', import.meta.url))
  const scene = await importMesh(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'demo-onepiece.obj', 'obj')
  const settings = settingsForScene(scene)
  const t = settings.transform
  const prepared = prepareScene(scene, t, DEFAULT_PREPARE_SETTINGS)
  const parts = flattenNodes(prepared.scene.nodes).filter((n) => n.positions.length > 0)
  const rakes = parts.filter((n) => n.tags.includes(RAKE_TAG))
  const named = (name: string) => parts.find((n) => n.name === name)!

  it('imports every face despite its stray line, standing up', () => {
    expect(countTriangles(scene.nodes)).toBe(940)
    expect(scene.upAxis).toBeUndefined()
    expect(t.upAxis).toBe('y')
    const [lo, hi] = zRange(scene.nodes[0], t)
    expect(lo).toBeCloseTo(0, 3)
    expect(hi).toBeCloseTo(12, 3)
  })

  it('splits into rakes, a floor, a ceiling and the walls', () => {
    expect(prepared.split).toEqual({ nodesSplit: 1, parts: parts.length, rakes: rakes.length })
    expect(parts.map((n) => n.name).filter((n) => !n.startsWith('Rake'))).toEqual(['Floor', 'Ceiling', 'Walls'])
    // The container keeps the object the file had, under its own id.
    expect(prepared.scene.nodes[0].id).toBe(scene.nodes[0].id)
    expect(prepared.scene.nodes[0].children.length).toBe(parts.length)
  })

  it('keeps every triangle: the parts tile the model', () => {
    const before = areaOf(scene.nodes[0], t)
    const after = parts.reduce((s, n) => s + areaOf(n, t), 0)
    expect(after).toBeCloseTo(before, 6)
  })

  it('never fits one plane through the stalls and the balcony over them', () => {
    for (const r of rakes) {
      const [lo, hi] = zRange(r, t)
      expect(hi - lo).toBeLessThan(3.5)
    }
    const balcony = rakes.filter((r) => zRange(r, t)[0] > 4)
    expect(balcony.length).toBe(1)
  })

  it('cuts the fan into sectors, each within a step of its plane, at the rake drawn', () => {
    const stalls = rakes.filter((r) => zRange(r, t)[1] < 2.5)
    expect(stalls.length).toBeGreaterThan(1)
    for (const r of [...stalls, ...rakes.filter((x) => !stalls.includes(x))]) {
      const res = rationalise([r], r.name, { ...DEFAULT_RATIONALISE, transform: t, gapMetres: 1, stepped: true })
      expect(res.outlines.length).toBe(1)
      const balcony = zRange(r, t)[0] > 4
      const [rise, pitch] = balcony ? [0.4, 0.9] : [0.15, 0.9]
      // A stepped rake sits up to half a step off its plane, RMS about 0.29 of a step.
      expect(res.stats.rmsResidual).toBeLessThan(0.3 * rise + 0.06)
      // The fitted plane through the steps has the generator's slope. A stalls sector is
      // cut across a cone, so its steepest slope is the rake and its plane only near it.
      const normal = res.outlines[0].basis.n
      expect(slopeDeg(normal.z)).toBeCloseTo((Math.atan(rise / pitch) * 180) / Math.PI, balcony ? 0 : -0.5)
    }
  })

  it('does not take the stage stair for seating', () => {
    for (const r of rakes) {
      const p = applyTransform(r.positions, t)
      for (let i = 0; i < p.length; i += 3) {
        const onStair = p[i] > 8.15 && p[i] < 9.45 && p[i + 1] < 0.05 && p[i + 1] > -1.55
        expect(onStair).toBe(false)
      }
    }
  })

  it('reads a floor wound upside down as a floor, and a balcony soffit as a ceiling', () => {
    expect(zRange(named('Floor'), t)).toEqual([expect.closeTo(0, 3), expect.closeTo(2.1, 3)])
    const [lo, hi] = zRange(named('Ceiling'), t)
    expect(lo).toBeCloseTo(4.2, 3)
    expect(hi).toBeCloseTo(12, 3)
  })

  it('types the parts by their names, and flattens the rakes as stepped', () => {
    const plan = prepared.plan
    expect(plan.planeTypes.get(named('Walls').id)).toBe(PlaneType.Surface)
    expect(plan.planeTypes.get(named('Ceiling').id)).toBe(PlaneType.Surface)
    expect(plan.planeTypes.has(named('Floor').id)).toBe(false)
    expect(plan.seating.filter((c) => c.found === 'shape').map((c) => c.memberIds[0]).sort()).toEqual(
      rakes.map((r) => r.id).sort(),
    )
    expect(plan.summary.rakes).toBe(rakes.length)
    expect(rationalisationsFromPlan(plan).every((r) => r.stepped)).toBe(true)
    expect(plan.notes.join(' ')).toMatch(/stepped rake/)
  })

  it('cuts the venue to a few dozen objects', () => {
    const raw = convertNodes(
      [{ node: scene.nodes[0], planeType: PlaneType.Listening, include: true, name: 'Venue' }],
      { ...DEFAULT_CONVERT, transform: t },
    )
    const rats = rationalisationsFromPlan(prepared.plan)
    const { areas, effective } = rationalisedAreas(prepared.scene, rats, settings)
    const entries = conversionEntries(prepared.scene, applyPlan(seedDecisions(prepared.scene), prepared.plan), effective)
    const after = convertNodes(entries, convertOptions(settings), areas)
    expect(raw.stats.objectsOut).toBeGreaterThan(150)
    expect(after.stats.objectsOut).toBeLessThan(40)
    expect(areas.length).toBe(rakes.length)
  })

  it('splits the same way in millimetres and Z-up', () => {
    // The same model as a Z-up, millimetre exporter would write it.
    const src = scene.nodes[0].positions
    const mm = new Float64Array(src.length)
    for (let i = 0; i < src.length; i += 3) {
      mm[i] = src[i] * 1000
      mm[i + 1] = -src[i + 2] * 1000
      mm[i + 2] = src[i + 1] * 1000
    }
    const zUp: TransformOptions = { ...DEFAULT_TRANSFORM, unitsPerMetre: 0.001, upAxis: 'z' }
    const again = splitNode({ ...scene.nodes[0], positions: mm }, zUp)!
    expect(again.parts.map((p) => p.name)).toEqual(parts.map((p) => p.name))
    again.parts.forEach((p, i) => expect(areaOf(p, zUp)).toBeCloseTo(areaOf(parts[i], t), 3))
  })

  it('splits the same way every time', () => {
    const again = splitScene(scene, t).scene
    const ps = flattenNodes(again.nodes).filter((n) => n.positions.length > 0)
    expect(ps.map((p) => [p.id, p.name, p.positions.length])).toEqual(parts.map((p) => [p.id, p.name, p.positions.length]))
  })

  it('is a box that can be unticked', () => {
    const whole = prepareScene(scene, t, { ...DEFAULT_PREPARE_SETTINGS, splitOnePiece: false })
    expect(whole.split).toBeNull()
    expect(whole.scene.nodes[0].children).toEqual([])
  })
})

// --- Synthetic cases --------------------------------------------------------------------

const node = (name: string, positions: number[], tags: string[] = []): ImportedNode => ({
  id: `n:${name}`,
  name,
  tags,
  positions: Float64Array.from(positions),
  children: [],
})

const scene = (nodes: ImportedNode[]): ImportedScene => ({ format: 'test', sourceName: 'test', nodes, warnings: [] })

/** A quad, counter-clockwise seen from where it faces, as two triangles. */
function quad(out: number[], a: number[], b: number[], c: number[], d: number[]) {
  out.push(...a, ...b, ...c, ...a, ...c, ...d)
}

/** A straight stepped block along +Y: `rows` treads of `pitch`, each `rise` above the last. */
function steps(out: number[], x0: number, x1: number, y0: number, rows: number, pitch: number, rise: number, z0 = 0) {
  for (let r = 0; r < rows; r++) {
    const y = y0 + r * pitch
    const z = z0 + r * rise
    quad(out, [x0, y, z], [x1, y, z], [x1, y + pitch, z], [x0, y + pitch, z])
    if (r < rows - 1) quad(out, [x0, y + pitch, z], [x1, y + pitch, z], [x1, y + pitch, z + rise], [x0, y + pitch, z + rise])
  }
  return out
}

/** A box room's walls, `h` high, around [x0,x1] x [y0,y1]. */
function walls(out: number[], x0: number, x1: number, y0: number, y1: number, h: number) {
  quad(out, [x0, y0, 0], [x1, y0, 0], [x1, y0, h], [x0, y0, h])
  quad(out, [x1, y0, 0], [x1, y1, 0], [x1, y1, h], [x1, y0, h])
  quad(out, [x1, y1, 0], [x0, y1, 0], [x0, y1, h], [x1, y1, h])
  quad(out, [x0, y1, 0], [x0, y0, 0], [x0, y0, h], [x0, y1, h])
  return out
}

describe('what is not split', () => {
  it('leaves a named object alone', () => {
    const p = steps(walls([], -10, 10, 0, 20, 8), -8, 8, 2, 12, 0.9, 0.3)
    expect(splitNode(node('SEATING', p), metres)).toBeNull()
    expect(splitNode(node('Thing', p), metres)).not.toBeNull()
  })

  it('leaves alone an object with nothing to separate', () => {
    // Walls and nothing else: one part is the node again.
    expect(splitNode(node('Thing', walls([], -10, 10, 0, 20, 8)), metres)).toBeNull()
  })

  it('does not read a stair as seating, nor a thin slab as a flight', () => {
    const p: number[] = []
    quad(p, [-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0])
    steps(p, 10, 11.2, -1, 5, 0.3, 0.2) // a stair: too little tread
    // A slab 20 mm thick: its top, its underside, and its edge.
    quad(p, [-5, 12, 1], [5, 12, 1], [5, 14, 1], [-5, 14, 1])
    quad(p, [-5, 14, 0.98], [5, 14, 0.98], [5, 12, 0.98], [-5, 12, 0.98])
    quad(p, [-5, 12, 0.98], [5, 12, 0.98], [5, 12, 1], [-5, 12, 1])
    walls(p, -12, 12, -12, 16, 6)
    // Small enough to be left whole by default; split anyway, to see what it would find.
    const split = splitNode(node('Thing', p), metres, { minTriangles: 0 })!
    expect(split.parts.map((x) => x.name)).toEqual(['Floor', 'Walls'])
    expect(split.rakes).toBe(0)
  })
})

describe('telling a ceiling from a floor', () => {
  const level = (z: number, x0 = -10, x1 = 10, y0 = -10, y1 = 10, down = false) => {
    const out: number[] = []
    if (down) quad(out, [x0, y1, z], [x1, y1, z], [x1, y0, z], [x0, y0, z])
    else quad(out, [x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z])
    return [out.slice(0, 9), out.slice(9, 18)]
  }

  it('by position, with nothing to judge the winding by', () => {
    const ground = level(0)
    const landing = level(4, -10, 0)
    const ceilingOverLanding = level(7, -10, 0)
    const roof = level(10, 0, 10)
    const index = new LevelIndex([...ground, ...landing, ...ceilingOverLanding, ...roof])
    expect(levelKind(ground, index)).toBe('floor')
    // Standing room over it: somewhere to be.
    expect(levelKind(landing, index)).toBe('floor')
    expect(levelKind(roof, index)).toBe('ceiling')
  })

  it('does not call an open landing a ceiling just because nothing is drawn over it', () => {
    // A media server's stage model has no roof: its circle is open to the sky.
    const ground = level(0)
    const circle = level(3, -10, 0)
    const flyTower = level(14, 2, 10)
    const index = new LevelIndex([...ground, ...circle, ...flyTower])
    expect(levelKind(circle, index)).toBe('floor')
    expect(levelKind(flyTower, index)).toBe('ceiling')
  })

  it('by winding, when the seating shows it can be trusted', () => {
    const ground = level(0, -10, 10, -10, 10, true) // wound down, and still the ground
    const soffit = level(4, -10, 0, -10, 10, true)
    const balcony = level(4.5, -10, 0)
    const index = new LevelIndex([...ground, ...soffit, ...balcony])
    expect(levelKind(ground, index, undefined, 1)).toBe('floor')
    expect(levelKind(soffit, index, undefined, 1)).toBe('ceiling')
    expect(levelKind(balcony, index, undefined, 1)).toBe('floor')
  })
})

describe('typing unnamed objects by their shape', () => {
  it('makes an all-wall object and a ceiling over the room surfaces, and leaves the floor', () => {
    const floor: number[] = []
    quad(floor, [-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0])
    const ceiling: number[] = []
    quad(ceiling, [-10, -10, 8], [10, -10, 8], [10, 10, 8], [-10, 10, 8])
    const s = scene([node('Mesh 1', floor), node('Mesh 2', walls([], -10, 10, -10, 10, 8)), node('Mesh 3', ceiling)])
    const plan = preparePlan(s, metres)
    expect(plan.planeTypes.has('n:Mesh 1')).toBe(false)
    expect(plan.planeTypes.get('n:Mesh 2')).toBe(PlaneType.Surface)
    expect(plan.planeTypes.get('n:Mesh 3')).toBe(PlaneType.Surface)
    expect(plan.summary.planeTypesFromShape).toBe(2)
    expect(plan.notes.join(' ')).toMatch(/2 unnamed objects a surface from its shape/)
  })

  it('only when the name says nothing, and only when asked', () => {
    const s = scene([node('STAGE', walls([], -1, 1, -1, 1, 1))])
    expect(preparePlan(s, metres).planeTypes.get('n:STAGE')).toBe(PlaneType.Stage)
    const unnamed = scene([node('Mesh 2', walls([], -10, 10, -10, 10, 8))])
    expect(preparePlan(unnamed, metres, { guessPlaneTypes: false }).planeTypes.size).toBe(0)
  })
})
