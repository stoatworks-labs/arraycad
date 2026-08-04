/**
 * Preparation, against models whose right answer is known by construction.
 *
 * The tests are weighted towards what the pass must REFUSE to do, because that is where the
 * damage is. A heuristic that leaves a room surface out, fills a doorway, or fits one plane
 * through a stalls block and the balcony above it produces a venue that looks entirely
 * plausible and predicts the wrong room.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PlaneType } from '../dbacv/types.ts'
import { importDxf } from '../import/dxf.ts'
import type { ImportedNode, ImportedScene } from '../import/types.ts'
import { DEFAULT_CONVERT, convertNodes } from '../geom/convert.ts'
import { DEFAULT_RATIONALISE, rationalise } from '../geom/rationalise.ts'
import { DEFAULT_TRANSFORM, type TransformOptions } from '../geom/transform.ts'
import { DEFAULT_SIMPLIFY, preparePlan, simplifyScene } from './index.ts'
import { categorise, tokens } from './vocabulary.ts'

let seq = 0
const node = (name: string, positions: number[], tags: string[] = []): ImportedNode => ({
  id: `n${++seq}`,
  name,
  tags,
  positions: Float64Array.from(positions),
  children: [],
})

const scene = (nodes: ImportedNode[]): ImportedScene => ({
  format: 'test',
  sourceName: 'test',
  nodes,
  warnings: [],
})

const metres: TransformOptions = { ...DEFAULT_TRANSFORM, unitsPerMetre: 1 }

/** A level square, wound so its normal points up. */
function pan(x: number, y: number, w: number, d: number, z: number, out: number[] = []): number[] {
  out.push(x, y, z, x + w, y, z, x + w, y + d, z)
  out.push(x, y, z, x + w, y + d, z, x, y + d, z)
  return out
}

/** A seat as a solid: an upward pan on top and a downward one at the floor. */
function seat(x: number, y: number, z: number): number[] {
  const out = pan(x, y, 0.48, 0.45, z)
  out.push(x, y, z - 0.42, x + 0.48, y + 0.45, z - 0.42, x + 0.48, y, z - 0.42)
  return out
}

/** `nu` x `nv` quads over a w x d rectangle, all coplanar. The meshed-wall case. */
function grid(w: number, d: number, nu: number, nv: number, z = 0): number[] {
  const out: number[] = []
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      pan((i * w) / nu, (j * d) / nv, w / nu, d / nv, z, out)
    }
  }
  return out
}

describe('reading a name', () => {
  it('matches whole words, not substrings', () => {
    expect(categorise('DIMENSIONS')).toBe('clutter')
    // The one that matters: a substring match would leave a real surface out of the venue.
    expect(categorise('TEXTURED PANEL')).toBeNull()
    expect(categorise('WALLPAPER STORE')).toBeNull()
    expect(categorise('WALL - SR')).toBe('wall')
  })

  it('lets the clutter word decide what an object is for', () => {
    // A lighting bar over a stage is a lighting bar.
    expect(categorise('STAGE LIGHTING')).toBe('clutter')
    expect(categorise('SEATING DIMENSIONS')).toBe('clutter')
    expect(categorise('STAGE')).toBe('stage')
  })

  it('reads tags as well as names, which is where an IFC type lands', () => {
    expect(categorise('3f2a1b8c-0000', ['IfcFurniture'])).toBe('clutter')
    expect(categorise('{c9ab9376}', ['seating'])).toBe('seating')
  })

  it('splits on punctuation and numbering', () => {
    expect(tokens('SEATING-STALLS_02')).toEqual(['seating', 'stalls', '02'])
  })

  it('says nothing rather than guessing', () => {
    expect(categorise('Gradins')).toBeNull()
    expect(categorise('Component#412')).toBeNull()
  })
})

describe('the plan', () => {
  it('leaves out clutter and keeps what it is for', () => {
    const s = scene([
      node('DIMENSIONS', pan(0, 0, 10, 10, 0)),
      node('LX BARS', pan(0, 0, 10, 10, 6)),
      node('WALL - SR', [0, 0, 0, 10, 0, 0, 10, 0, 8]),
      node('STAGE', pan(0, 0, 10, 8, 1)),
    ])
    const plan = preparePlan(s, metres)

    expect([...plan.exclude.keys()].length).toBe(2)
    expect(plan.summary.clutterExcluded).toBe(2)
    expect(plan.planeTypes.get(s.nodes[2].id)).toBe(PlaneType.Surface)
    expect(plan.planeTypes.get(s.nodes[3].id)).toBe(PlaneType.Stage)
  })

  it('leaves a floor alone, because Listening is already the honest default', () => {
    const s = scene([node('FLOOR', pan(0, 0, 10, 10, 0))])
    const plan = preparePlan(s, metres)
    expect(plan.exclude.size).toBe(0)
    expect(plan.planeTypes.size).toBe(0)
  })

  it('leaves out objects with almost no surface', () => {
    const s = scene([
      node('BRACKET', pan(0, 0, 0.2, 0.2, 0)),
      node('CEILING', pan(0, 0, 10, 10, 8)),
    ])
    const plan = preparePlan(s, metres)
    expect(plan.summary.tinyExcluded).toBe(1)
    expect(plan.exclude.has(s.nodes[1].id)).toBe(false)
  })

  it('honours its checkboxes', () => {
    const s = scene([node('DIMENSIONS', pan(0, 0, 10, 10, 0)), node('BRACKET', pan(0, 0, 0.2, 0.2, 0))])
    const plan = preparePlan(s, metres, { dropClutter: false, dropTiny: false })
    expect(plan.exclude.size).toBe(0)
  })

  it('scales its thresholds with the unit setting', () => {
    // The same bracket in millimetres. A pass that read raw coordinates would call this a
    // 40,000 m² object and keep it.
    const mm = { ...metres, unitsPerMetre: 0.001 }
    const s = scene([node('BRACKET', pan(0, 0, 200, 200, 0))])
    expect(preparePlan(s, mm).summary.tinyExcluded).toBe(1)
    expect(preparePlan(s, metres).summary.tinyExcluded).toBe(0)
  })
})

describe('finding the seating', () => {
  const bank = (name: string, z: number, rows = 6, cols = 6): ImportedNode[] => {
    const out: ImportedNode[] = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        out.push(node(`${name}.${r * cols + c}`, seat(r * 0.9, c * 0.55, z)))
      }
    }
    return out
  }

  it('finds a bank of chairs nobody named, by its repetition', () => {
    const plan = preparePlan(scene(bank('Component', 0)), metres)
    expect(plan.seating.length).toBe(1)
    expect(plan.seating[0].found).toBe('repetition')
    expect(plan.seating[0].objectCount).toBe(36)
  })

  it('measures the row pitch rather than assuming one', () => {
    // 0.9 m rows on 0.55 m centres. The nearest neighbours are the seats to either side,
    // and bridging only those would leave every row a separate area.
    const plan = preparePlan(scene(bank('Component', 0)), metres)
    expect(plan.seating[0].gapMetres).toBeCloseTo(0.9, 1)
  })

  it('does not fit one plane through a stalls block and the balcony above it', () => {
    const plan = preparePlan(scene([...bank('Seat', 0), ...bank('Seat', 4.4)]), metres)
    expect(plan.seating.length).toBe(2)
    // Sorted by height by construction, and each keeps its own seats.
    expect(plan.seating.every((c) => c.objectCount === 36)).toBe(true)
  })

  it('leaves a continuous deck alone, however it is named', () => {
    // A raked deck called SEATING is still a deck: its faces touch, so the region finder
    // already handles it, and there is nothing scattered to gather. Rationalising it can
    // even lose it — a coarsely drawn surface has no two corners within the bridging gap.
    const s = scene([node('SEATING - STALLS', grid(20, 16, 4, 4))])
    expect(preparePlan(s, metres).seating.length).toBe(0)
  })

  it('does not leave the audience out for being small', () => {
    // Seats modelled as flat pans are ~0.2 m² each, under any sensible "too small to
    // matter" threshold. Ordering the size test before the seating test would leave out
    // the whole audience and report it as trim.
    const pans: ImportedNode[] = []
    for (let r = 0; r < 6; r++) {
      for (let c = 0; c < 6; c++) pans.push(node(`Seat.${r * 6 + c}`, pan(r * 0.9, c * 0.55, 0.48, 0.45, 1)))
    }
    const plan = preparePlan(scene(pans), metres)
    expect(plan.summary.tinyExcluded).toBe(0)
    expect(plan.seating[0]?.objectCount).toBe(36)
  })

  it('refuses to call a floor slab a bank of seats', () => {
    // Alike, repeated, upward-facing — and 3 m across. Size is the condition that separates
    // a paved terrace from an auditorium.
    const tiles: ImportedNode[] = []
    for (let i = 0; i < 20; i++) tiles.push(node(`Tile.${i}`, pan(i * 3, 0, 3, 3, 0)))
    expect(preparePlan(scene(tiles), metres).seating.length).toBe(0)
  })

  it('refuses a handful of alike objects', () => {
    const few = bank('Component', 0, 2, 3)
    expect(preparePlan(scene(few), metres).seating.length).toBe(0)
  })

  it('takes a name over a measurement, and keeps two named blocks apart', () => {
    const s = scene([
      node('SEATING - STALLS', bank('x', 0).flatMap((n) => [...n.positions])),
      node('SEATING - BALCONY', bank('x', 4.4).flatMap((n) => [...n.positions])),
    ])
    const plan = preparePlan(s, metres)
    expect(plan.seating.map((c) => c.name)).toEqual(['SEATING - STALLS', 'SEATING - BALCONY'])
    expect(plan.seating.every((c) => c.gapMetres === DEFAULT_RATIONALISE.gapMetres)).toBe(true)
  })
})

describe('re-cutting heavy objects', () => {
  const opts = { minTriangles: 10 }

  it('turns a meshed flat panel back into the panel', () => {
    const s = scene([node('WALL', grid(10, 10, 20, 20))])
    const r = simplifyScene(s, metres, opts)
    expect(r.stats.trianglesIn).toBe(800)
    expect(r.stats.trianglesOut).toBe(2)
  })

  it('keeps the outline exactly, and the area with it', () => {
    const s = scene([node('WALL', grid(10, 6, 20, 20))])
    const out = simplifyScene(s, metres, opts).scene.nodes[0].positions
    let area = 0
    for (let i = 0; i + 8 < out.length; i += 9) {
      const [ax, ay] = [out[i + 3] - out[i], out[i + 4] - out[i + 1]]
      const [bx, by] = [out[i + 6] - out[i], out[i + 7] - out[i + 1]]
      area += Math.abs(ax * by - ay * bx) / 2
    }
    expect(area).toBeCloseTo(60, 6)
  })

  it('refuses a region with a hole in it, rather than filling the doorway', () => {
    // A 6 x 6 wall meshed into 9 squares with the middle one missing.
    const out: number[] = []
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (i === 1 && j === 1) continue
        pan(i * 2, j * 2, 2, 2, 0, out)
      }
    }
    const r = simplifyScene(scene([node('WALL', out)]), metres, { minTriangles: 4 })
    expect(r.stats.regionsRefused).toBe(1)
    expect(r.stats.trianglesOut).toBe(16)
  })

  it('leaves a small object alone', () => {
    const s = scene([node('WALL', grid(10, 10, 4, 4))])
    const r = simplifyScene(s, metres)
    expect(r.scene).toBe(s)
    expect(r.stats.nodesSimplified).toBe(0)
  })

  it('leaves curvature alone: a shape that is not flat is not re-cut', () => {
    // A quarter cylinder. Every facet is at 4.5 degrees to the next, so the region finder
    // splits it and no region is worth re-cutting.
    const out: number[] = []
    for (let i = 0; i < 20; i++) {
      const a0 = (i * Math.PI) / 40
      const a1 = ((i + 1) * Math.PI) / 40
      const [x0, z0] = [Math.cos(a0) * 5, Math.sin(a0) * 5]
      const [x1, z1] = [Math.cos(a1) * 5, Math.sin(a1) * 5]
      out.push(x0, 0, z0, x1, 0, z1, x1, 10, z1)
      out.push(x0, 0, z0, x1, 10, z1, x0, 10, z0)
    }
    const r = simplifyScene(scene([node('SHELL', out)]), metres, { minTriangles: 4 })
    expect(r.stats.trianglesOut).toBe(40)
  })

  it('works in the source units, not in metres', () => {
    // The same panel in millimetres. Tolerances stated in metres have to be divided into
    // source units or a 1 mm weld tolerance becomes a 1 m one and the panel collapses.
    const mm = { ...metres, unitsPerMetre: 0.001 }
    const positions = grid(10000, 10000, 20, 20)
    const r = simplifyScene(scene([node('WALL', positions)]), mm, opts)
    expect(r.stats.trianglesOut).toBe(2)
    const out = r.scene.nodes[0].positions
    expect(Math.max(...out)).toBeCloseTo(10000, 6)
  })
})

/**
 * The whole point, end to end.
 *
 * `demo/demo-seats.dxf` models every one of its 468 seats separately — the case the region
 * finder is structurally unable to solve — and names its layers the way a real drawing
 * does. What preparation has to deliver is the venue a user reaches by hand, without the
 * hand.
 */
describe('preparing the seat-by-seat demo venue', () => {
  const imported = importDxf(
    readFileSync(new URL('../../../demo/demo-seats.dxf', import.meta.url), 'utf8'),
    'demo-seats.dxf',
  )
  const transform = { ...DEFAULT_CONVERT.transform, unitsPerMetre: imported.unitsPerMetre ?? 1 }
  const plan = preparePlan(imported, transform)

  it('finds both seating blocks off the layer names', () => {
    expect(plan.seating.map((c) => c.name).sort()).toEqual(['SEATING - BALCONY', 'SEATING - STALLS'])
  })

  it('warns that the raked floor under the seats is a second listening plane', () => {
    expect(plan.notes.join(' ')).toMatch(/FLOOR - STALLS[\s\S]*second listening plane/)
  })

  it('cuts the venue from thousands of objects to a handful', () => {
    const nodes = [...flatten(imported.nodes)].filter((n) => n.positions.length > 0)

    const raw = convertNodes(
      nodes.map((n) => ({ node: n, planeType: PlaneType.Listening, include: true, name: n.name })),
      { ...DEFAULT_CONVERT, transform },
    )

    const replaced = new Set(plan.seating.flatMap((c) => c.memberIds))
    const areas = plan.seating.map((c) => {
      const members = nodes.filter((n) => c.memberIds.includes(n.id))
      const r = rationalise(members, c.name, {
        ...DEFAULT_RATIONALISE,
        transform,
        gapMetres: c.gapMetres,
      })
      return { name: c.name, planeType: PlaneType.Listening, outlines: r.outlines }
    })

    const prepared = convertNodes(
      nodes.map((n) => ({
        node: n,
        planeType: plan.planeTypes.get(n.id) ?? PlaneType.Listening,
        include: !plan.exclude.has(n.id) && !replaced.has(n.id),
        name: n.name,
      })),
      { ...DEFAULT_CONVERT, transform },
      areas,
    )

    expect(raw.stats.objectsOut).toBeGreaterThan(3000)
    // The number the feature exists for. Two floors, plus the areas the seating became.
    expect(prepared.stats.objectsOut).toBeLessThan(30)
    // And the stalls gangway is still a gangway: two areas, not one paved block.
    expect(areas[0].outlines.length + areas[1].outlines.length).toBeGreaterThan(2)
  })
})

function* flatten(nodes: ImportedNode[]): Generator<ImportedNode> {
  for (const n of nodes) {
    yield n
    yield* flatten(n.children)
  }
}

describe('simplifying the demo venue', () => {
  it('cuts its triangle count without changing what it converts to', () => {
    const imported = importDxf(
      readFileSync(new URL('../../../demo/demo-venue.dxf', import.meta.url), 'utf8'),
      'demo-venue.dxf',
    )
    const transform = { ...DEFAULT_CONVERT.transform, unitsPerMetre: imported.unitsPerMetre ?? 1 }
    const entries = (s: ImportedScene) =>
      [...flatten(s.nodes)]
        .filter((n) => n.positions.length > 0)
        .map((n) => ({ node: n, planeType: PlaneType.Listening, include: true, name: n.name }))

    const before = convertNodes(entries(imported), { ...DEFAULT_CONVERT, transform })
    const r = simplifyScene(imported, transform, { ...DEFAULT_SIMPLIFY, minTriangles: 50 })
    const after = convertNodes(entries(r.scene), { ...DEFAULT_CONVERT, transform })

    expect(r.stats.trianglesOut).toBeLessThan(r.stats.trianglesIn / 2)
    // The venue that comes out the far end is the same one. This is the claim the whole
    // pass rests on: fewer triangles, same room.
    expect(after.stats.objectsOut).toBe(before.stats.objectsOut)
  })

  it('leaves the balcony fan alone and takes the walls apart', () => {
    // The two ends of the rule, on one model. `WALLS` is flat panels meeting at corners and
    // re-cuts to almost nothing. `SEATING - BALCONY` is a fan of raked tiers, each within a
    // few degrees of the next and each bulging 27 mm off its own plane, so which triangle
    // belongs to which tier depends on how finely they are cut — and re-cutting one changes
    // the answer for its NEIGHBOURS. It went 11 regions to 13 before this was guarded.
    const imported = importDxf(
      readFileSync(new URL('../../../demo/demo-venue.dxf', import.meta.url), 'utf8'),
      'demo-venue.dxf',
    )
    const transform = { ...DEFAULT_CONVERT.transform, unitsPerMetre: imported.unitsPerMetre ?? 1 }
    const r = simplifyScene(imported, transform, { ...DEFAULT_SIMPLIFY, minTriangles: 50 })
    const by = (name: string, s: ImportedScene) => [...flatten(s.nodes)].find((n) => n.name === name)!

    expect(by('WALLS', r.scene).positions.length).toBeLessThan(by('WALLS', imported).positions.length / 20)
    expect(by('SEATING - BALCONY', r.scene).positions.length).toBe(
      by('SEATING - BALCONY', imported).positions.length,
    )
  })
})
