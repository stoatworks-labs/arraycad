/**
 * End-to-end: a file goes in, a valid .dbacv comes out.
 *
 * This is the test that matters. Every unit test above it can pass while the assembled
 * pipeline still emits something ArrayCalc would reject, so this one runs the real path —
 * import, convert, serialise, re-parse — and checks the result against the input.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { parseDbacv } from './dbacv/read.ts'
import { formatDbacvDate, writeDbacv } from './dbacv/write.ts'
import { type VenueFile, PlaneType, Shape } from './dbacv/types.ts'
import { importDbacvAsScene } from './import/dbacvScene.ts'
import { importDxf } from './import/dxf.ts'
import { type ImportedNode, flattenNodes } from './import/types.ts'
import { DEFAULT_CONVERT, convertNodes } from './geom/convert.ts'

const parser = new (new JSDOM().window.DOMParser)()
const xml = readFileSync(new URL('../../test/fixtures/theatre.dbacv', import.meta.url), 'utf8')

function toVenue(objects: VenueFile['objects']): VenueFile {
  return {
    appVersion: '12.8.2',
    venueVersion: '9',
    projectName: 'Test',
    date: formatDbacvDate(new Date(2026, 7, 1)),
    author: 'Venue Forge',
    projectComments: '',
    venueComments: '',
    objects,
  }
}

function allPoints(objects: VenueFile['objects']) {
  const out: { x: number; y: number; z: number }[] = []
  const walk = (os: VenueFile['objects']) => {
    for (const o of os) {
      for (const p of o.points) out.push({ x: p.x + o.origin.x, y: p.y + o.origin.y, z: p.z + o.origin.z })
      walk(o.children)
    }
  }
  walk(objects)
  return out
}

function extent(pts: { x: number; y: number; z: number }[]) {
  const on = (k: 'x' | 'y' | 'z') => {
    const v = pts.map((p) => p[k])
    return [Math.min(...v), Math.max(...v)] as const
  }
  return { x: on('x'), y: on('y'), z: on('z') }
}

function convertAll(nodes: ImportedNode[], planeType = PlaneType.Audience, opts = DEFAULT_CONVERT) {
  const leaves = flattenNodes(nodes).filter((n) => n.positions.length > 0)
  return convertNodes(
    leaves.map((n) => ({
      node: n,
      planeType: n.suggestedPlaneType ?? planeType,
      include: true,
      name: n.name,
    })),
    opts,
  )
}

describe('venue -> planes -> venue', () => {
  const scene = importDbacvAsScene(xml, 'theatre.dbacv', parser)
  const result = convertAll(scene.nodes)
  const out = writeDbacv(toVenue(result.objects))
  const reparsed = parseDbacv(out, parser)

  it('produces a file that parses back', () => {
    expect(reparsed.objects.length).toBeGreaterThan(0)
    expect(out.startsWith('<!DOCTYPE ArrayCalc>')).toBe(true)
  })

  it('emits only geometry ArrayCalc understands', () => {
    const walk = (os: typeof reparsed.objects) => {
      for (const o of os) {
        if (o.shape === Shape.Group) {
          expect(o.children.length).toBeGreaterThan(1)
        } else {
          expect([Shape.Triangle, Shape.Quad]).toContain(o.shape)
          expect(o.points).toHaveLength(o.shape === Shape.Triangle ? 3 : 4)
        }
        walk(o.children)
      }
    }
    walk(reparsed.objects)
  })

  it('lands the venue in the same place it started', () => {
    const before = extent(
      flattenNodes(scene.nodes)
        .filter((n) => n.positions.length > 0)
        .flatMap((n) => {
          const pts = []
          for (let i = 0; i < n.positions.length; i += 3) {
            pts.push({ x: n.positions[i], y: n.positions[i + 1], z: n.positions[i + 2] })
          }
          return pts
        }),
    )
    const after = extent(allPoints(reparsed.objects))
    // 30 mm: the arc segments are tessellated then re-fitted, so the curved tiers lose a
    // little of their bulge. Anything larger would mean the transform chain is wrong.
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(Math.abs(after[axis][0] - before[axis][0])).toBeLessThan(0.03)
      expect(Math.abs(after[axis][1] - before[axis][1])).toBeLessThan(0.03)
    }
  })

  it('keeps every listener height consistent with its plane type', () => {
    const walk = (os: typeof reparsed.objects) => {
      for (const o of os) {
        if (o.shape !== Shape.Group) {
          if (o.planeType === PlaneType.Audience) expect(o.listenerHeight).toBe(1.2)
          if (o.planeType === PlaneType.Surface) expect(o.listenerHeight).toBe(0.01)
        }
        walk(o.children)
      }
    }
    walk(reparsed.objects)
  })

  it('writes a parent id chain that resolves', () => {
    // Every ParentVenueObjectId must name an object that exists earlier in the document,
    // and a group's children must all point at that group.
    const lines = out.split('\n').filter((l) => l.includes('<RoomObject'))
    const ids = lines.map((l, i) => ({
      index: i + 1,
      parent: Number(/ParentVenueObjectId="(\d+)"/.exec(l)![1]),
      isGroup: l.includes('ObjectGroup="true"'),
    }))
    for (const o of ids) {
      expect(o.parent).toBeLessThan(o.index)
      if (o.parent > 0) expect(ids[o.parent - 1].isGroup).toBe(true)
    }
  })

  it('shrinks the output when objects are pruned', () => {
    const leaves = flattenNodes(scene.nodes).filter((n) => n.positions.length > 0)
    const half = convertNodes(
      leaves.map((n, i) => ({
        node: n,
        planeType: PlaneType.Audience,
        include: i % 2 === 0,
        name: n.name,
      })),
      DEFAULT_CONVERT,
    )
    expect(half.stats.objectsOut).toBeGreaterThan(0)
    expect(half.stats.objectsOut).toBeLessThan(result.stats.objectsOut)
  })

  it('rectangle fit never emits more objects than following the outline', () => {
    const rect = convertAll(scene.nodes, PlaneType.Audience, { ...DEFAULT_CONVERT, fit: 'rect' })
    expect(rect.stats.objectsOut).toBeLessThanOrEqual(result.stats.objectsOut)
    // One quad per region, by definition.
    expect(rect.stats.objectsOut).toBe(rect.stats.regionsFound)
  })
})

describe('DXF -> venue', () => {
  it('converts a plan drawing with an extrusion into a wall the right height', () => {
    const src = [
      '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'LWPOLYLINE', '8', 'WALLS', '70', '1', '90', '4',
      '10', '0', '20', '0',
      '10', '20000', '20', '0',
      '10', '20000', '20', '12000',
      '10', '0', '20', '12000',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n')

    // Millimetres in the file, so the extrusion is given in millimetres too.
    const scene = importDxf(src, 'plan.dxf', { extrudeFlatTo: 8000 })
    expect(scene.unitsPerMetre).toBe(0.001)

    const r = convertAll(scene.nodes, PlaneType.Surface, {
      ...DEFAULT_CONVERT,
      transform: { ...DEFAULT_CONVERT.transform, unitsPerMetre: 0.001 },
    })
    const venue = parseDbacv(writeDbacv(toVenue(r.objects)), parser)
    const e = extent(allPoints(venue.objects))

    // A 20 x 12 m room with 8 m walls, all four of them.
    expect(e.x[1] - e.x[0]).toBeCloseTo(20, 2)
    expect(e.y[1] - e.y[0]).toBeCloseTo(12, 2)
    expect(e.z[1] - e.z[0]).toBeCloseTo(8, 2)
    expect(r.stats.regionsFound).toBe(4)
  })

  it('scales feet correctly all the way to the exported file', () => {
    const src = [
      '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '2', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', '3DFACE', '8', 'STAGE',
      '10', '0', '20', '0', '30', '0',
      '11', '100', '21', '0', '31', '0',
      '12', '100', '22', '50', '32', '0',
      '13', '0', '23', '50', '33', '0',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n')

    const scene = importDxf(src, 'stage.dxf')
    const r = convertAll(scene.nodes, PlaneType.Stage, {
      ...DEFAULT_CONVERT,
      transform: { ...DEFAULT_CONVERT.transform, unitsPerMetre: scene.unitsPerMetre! },
    })
    const e = extent(allPoints(parseDbacv(writeDbacv(toVenue(r.objects)), parser).objects))
    expect(e.x[1] - e.x[0]).toBeCloseTo(30.48, 2) // 100 ft
    expect(e.y[1] - e.y[0]).toBeCloseTo(15.24, 2) // 50 ft
  })
})
