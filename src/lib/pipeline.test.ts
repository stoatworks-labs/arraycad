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
import { importSoundvisionAsScene } from './import/soundvisionScene.ts'
import { importDxf } from './import/dxf.ts'
import { type ImportedNode, flattenNodes } from './import/types.ts'
import { DEFAULT_CONVERT, convertNodes } from './geom/convert.ts'
import { type RationaliseOptions, DEFAULT_RATIONALISE, rationalise } from './geom/rationalise.ts'
import { DEFAULT_SOUNDVISION_CONVERT, convertNodesToSoundvision } from './soundvision/convert.ts'
import { readSoundvision } from './soundvision/read.ts'
import { writeSoundvision } from './soundvision/write.ts'

const parser = new (new JSDOM().window.DOMParser)()
const xml = readFileSync(new URL('../../test/fixtures/theatre.dbacv', import.meta.url), 'utf8')

function toVenue(objects: VenueFile['objects']): VenueFile {
  return {
    appVersion: '12.8.2',
    venueVersion: '9',
    projectName: 'Test',
    date: formatDbacvDate(new Date(2026, 7, 1)),
    author: 'ArrayCAD',
    projectComments: '',
    venueComments: '',
    objects,
  }
}

/**
 * World positions, APPLYING the Z rotation.
 *
 * Quads carry a real rotation now — ArrayCalc's canonical frame demands it. Adding the
 * origin to the raw local points, which was correct while rotation was always zero,
 * silently reports geometry in the wrong place.
 */
function allPoints(objects: VenueFile['objects']) {
  const out: { x: number; y: number; z: number }[] = []
  const walk = (os: VenueFile['objects']) => {
    for (const o of os) {
      const r = (o.rotation.z * Math.PI) / 180
      const c = Math.cos(r)
      const s = Math.sin(r)
      for (const p of o.points) {
        out.push({
          x: p.x * c - p.y * s + o.origin.x,
          y: p.x * s + p.y * c + o.origin.y,
          z: p.z + o.origin.z,
        })
      }
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

function convertAll(nodes: ImportedNode[], planeType = PlaneType.Listening, opts = DEFAULT_CONVERT) {
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
          if (o.planeType === PlaneType.Listening) expect(o.listenerHeight).toBe(1.2)
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
        planeType: PlaneType.Listening,
        include: i % 2 === 0,
        name: n.name,
      })),
      DEFAULT_CONVERT,
    )
    expect(half.stats.objectsOut).toBeGreaterThan(0)
    expect(half.stats.objectsOut).toBeLessThan(result.stats.objectsOut)
  })

  it('rectangle fit never emits more objects than following the outline', () => {
    const rect = convertAll(scene.nodes, PlaneType.Listening, { ...DEFAULT_CONVERT, fit: 'rect' })
    expect(rect.stats.objectsOut).toBeLessThanOrEqual(result.stats.objectsOut)
    // One region becomes one canonical quad, or two triangles when the rectangle has no
    // level edge for ArrayCalc's local frame to sit on — a rectangle on a compound
    // slope, for instance. Never more than two.
    expect(rect.stats.objectsOut).toBeGreaterThanOrEqual(rect.stats.regionsFound)
    expect(rect.stats.objectsOut).toBeLessThanOrEqual(rect.stats.regionsFound * 2)
  })

  it('emits only geometry that survives an ArrayCalc import', () => {
    // Every quad must be in the canonical frame; anything else is silently flattened on
    // import. Triangles are unconstrained.
    const walk = (os: typeof reparsed.objects) => {
      for (const o of os) {
        if (o.shape === Shape.Quad) {
          expect(Math.abs(o.points[0].x), `"${o.name}" P1.x`).toBeLessThan(1e-9)
          expect(Math.abs(o.points[3].x), `"${o.name}" P4.x`).toBeLessThan(1e-9)
          expect(Math.abs(o.points[1].x - o.points[2].x), `"${o.name}" far depth`).toBeLessThan(1e-9)
          expect(Math.abs(o.points[0].y + o.points[3].y), `"${o.name}" near sym`).toBeLessThan(1e-9)
          expect(Math.abs(o.points[1].y + o.points[2].y), `"${o.name}" far sym`).toBeLessThan(1e-9)
          expect(Math.abs(o.points[0].z - o.points[3].z), `"${o.name}" near level`).toBeLessThan(1e-9)
          expect(Math.abs(o.points[1].z - o.points[2].z), `"${o.name}" far level`).toBeLessThan(1e-9)
        }
        walk(o.children)
      }
    }
    walk(reparsed.objects)
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

/**
 * The two prediction tools' own venue formats, converted into each other.
 *
 * Neither ArrayCalc nor Soundvision will open the other's venue, and redrawing a room by
 * hand in the second tool is a day's work that also guarantees the two predictions are of
 * slightly different buildings. Both formats being importable makes the conversion the same
 * road as a CAD import: tessellate in, planarise, reduce, write the other one out.
 */
describe('cross conversion', () => {
  const roomdata = readFileSync(new URL('../../test/fixtures/roomdata.txt', import.meta.url), 'utf8')

  it('Soundvision -> ArrayCalc lands the room where it started', () => {
    const scene = importSoundvisionAsScene(roomdata, 'roomdata.txt')
    const before = extent(
      flattenNodes(scene.nodes).flatMap((n) => {
        const pts = []
        for (let i = 0; i < n.positions.length; i += 3) {
          pts.push({ x: n.positions[i], y: n.positions[i + 1], z: n.positions[i + 2] })
        }
        return pts
      }),
    )

    const r = convertAll(scene.nodes)
    expect(r.objects.length).toBeGreaterThan(0)
    const venue = parseDbacv(writeDbacv(toVenue(r.objects)), parser)
    const after = extent(allPoints(venue.objects))

    for (const axis of ['x', 'y', 'z'] as const) {
      expect(Math.abs(after[axis][0] - before[axis][0])).toBeLessThan(0.03)
      expect(Math.abs(after[axis][1] - before[axis][1])).toBeLessThan(0.03)
    }
  })

  it('ArrayCalc -> Soundvision writes a file that reads back', () => {
    const scene = importDbacvAsScene(xml, 'theatre.dbacv', parser)
    const leaves = flattenNodes(scene.nodes).filter((n) => n.positions.length > 0)
    const r = convertNodesToSoundvision(
      leaves.map((n) => ({ node: n, include: true, name: n.name })),
      DEFAULT_SOUNDVISION_CONVERT,
    )
    expect(r.scene.faces.length).toBeGreaterThan(0)

    const reread = readSoundvision(writeSoundvision(r.scene))
    expect(reread.scene.faces).toHaveLength(r.scene.faces.length)
    // A Soundvision surface is a free polygon, so the reduction is never forced to split a
    // region the way an ArrayCalc quad is. Nothing in this venue has a hole in it, so the
    // count is exact: one region, one surface.
    expect(r.stats.regionsTriangulated).toBe(0)
    expect(r.stats.facesOut).toBe(r.stats.regionsFound)
  })

  /**
   * The stock plug-ins label a face "<layer> face" and so does the writer, so the importer
   * has to take the suffix back off. Without that, every trip through Soundvision adds
   * another word: "Seating face", "Seating face face", "Seating face face face".
   */
  it('does not grow a " face" suffix on every Soundvision round trip', () => {
    let text = roomdata
    for (let i = 0; i < 3; i++) {
      const scene = importSoundvisionAsScene(text, 'room.txt')
      const r = convertNodesToSoundvision(
        flattenNodes(scene.nodes).map((n) => ({ node: n, include: true, name: n.name })),
        DEFAULT_SOUNDVISION_CONVERT,
      )
      text = writeSoundvision(r.scene)
      expect(new Set(readSoundvision(text).scene.faces.map((f) => f.label))).toEqual(
        new Set(['None face', 'Stage Trusses face', 'Seating face']),
      )
    }
  })
})

/**
 * Rationalisation, on a drawing that models every seat.
 *
 * The one case the coplanar region finder structurally cannot solve, so it is the one that
 * has to be proved end to end rather than on a synthetic grid. `demo/demo-seats.dxf` is
 * generated by `scripts/make_demo_seats.py` with the rake and the step pitch WRITTEN DOWN,
 * which is what makes the recovered slopes below assertions rather than observations.
 */
describe('rationalising a seat-by-seat drawing', () => {
  const scene = importDxf(
    readFileSync(new URL('../../demo/demo-seats.dxf', import.meta.url), 'utf8'),
    'demo-seats.dxf',
  )
  const nodes = flattenNodes(scene.nodes).filter((n) => n.positions.length > 0)
  const transform = { ...DEFAULT_CONVERT.transform, unitsPerMetre: scene.unitsPerMetre ?? 1 }
  const layer = (key: string) =>
    nodes.find((n) => n.name.includes('SEATING') && n.name.includes(key))!
  const opts = (patch: Partial<RationaliseOptions> = {}): RationaliseOptions => ({
    ...DEFAULT_RATIONALISE,
    transform,
    ...patch,
  })

  it('is unusable without it — every seat becomes its own object', () => {
    // The number that justifies the whole feature. An ArrayCalc venue list is a flat
    // scrolling list a human has to work in, and this is what arrives without help.
    const r = convertNodes(
      nodes.map((n) => ({ node: n, planeType: PlaneType.Listening, include: true, name: n.name })),
      { ...DEFAULT_CONVERT, transform },
    )
    expect(r.stats.objectsOut).toBeGreaterThan(3000)
  })

  it('keeps only the seat tops — one sixth of a box', () => {
    const r = rationalise([layer('STALLS')], 'Stalls', opts({ gapMetres: 2 }))
    // Six faces to a seat, two triangles each, and exactly one face points up.
    expect(r.stats.trianglesKept * 6).toBe(r.stats.trianglesIn)
  })

  it('recovers the stalls rake the generator was told to draw', () => {
    const r = rationalise([layer('STALLS')], 'Stalls', opts({ gapMetres: 2 }))
    const n = r.outlines[0].basis.n
    // make_demo_seats.py rakes the stalls at 1:14.
    expect(-n.x / n.z).toBeCloseTo(1 / 14, 3)
    expect(r.stats.componentsOut).toBe(1)
  })

  it('recovers a STEPPED rake, which a normal average cannot', () => {
    // Every balcony tread is separately level, so the area-weighted mean of the face
    // normals here is exactly straight up and would describe a flat floor 4.4 m in the
    // air. Least squares through the surface finds the 0.35-in-1.05 step pitch instead.
    const r = rationalise([layer('BALCONY')], 'Balcony', opts())
    const n = r.outlines[0].basis.n
    expect(-n.x / n.z).toBeCloseTo(0.35 / 1.05, 2)
    // And it reports the tread rather than hiding it: half a seat depth up the slope.
    expect(r.stats.maxResidual).toBeCloseTo(((0.35 / 1.05) * 0.45) / 2, 2)
  })

  it('does not pave the centre gangway, and says why', () => {
    // 1.8 m of gangway. At a row pitch nothing bridges it, and the two banks stay two —
    // a single plane across them would put audience where the traffic is.
    const tight = rationalise([layer('STALLS')], 'Stalls', opts({ gapMetres: 0.9 }))
    expect(tight.stats.componentsOut).toBe(2)
    expect(tight.warnings.join(' ')).toMatch(/2 separate areas/)

    const wide = rationalise([layer('STALLS')], 'Stalls', opts({ gapMetres: 2 }))
    expect(wide.stats.componentsOut).toBe(1)
  })

  it('a drawn area separates blocks the object tree cannot', () => {
    // Both banks are on ONE layer, so no amount of pruning in the tree reaches the left
    // one alone. The footprint does, and this is the reason it exists.
    const left = rationalise(
      [layer('STALLS')],
      'Stalls left',
      opts({ gapMetres: 2, footprint: [[0, 0.5], [30, 0.5], [30, 12], [0, 12]] }),
    )
    const whole = rationalise([layer('STALLS')], 'All', opts({ gapMetres: 2 }))
    expect(left.stats.componentsOut).toBe(1)
    // The bank is symmetric about the gangway, so drawing round one half must capture
    // half the seats and leave the other half explicitly accounted for rather than lost.
    expect(left.stats.trianglesKept).toBeCloseTo(whole.stats.trianglesKept / 2, -1)
    expect(left.stats.trianglesKept + left.stats.trianglesOutside).toBe(whole.stats.trianglesKept)
    expect(left.stats.areaEmitted).toBeLessThan(whole.stats.areaEmitted * 0.6)
  })

  it('reaches both output targets from the same outlines', () => {
    const areas = [
      { name: 'Stalls', planeType: PlaneType.Listening, outlines: rationalise([layer('STALLS')], 'Stalls', opts({ gapMetres: 2 })).outlines },
    ]
    const dbacv = convertNodes([], { ...DEFAULT_CONVERT, transform }, areas)
    expect(dbacv.stats.objectsOut).toBeGreaterThan(0)

    const sv = convertNodesToSoundvision([], { ...DEFAULT_SOUNDVISION_CONVERT, transform }, areas)
    expect(sv.scene.faces.length).toBeGreaterThan(0)
    // Soundvision keeps a polygon whole, so it needs FEWER faces than ArrayCalc needs
    // objects — the same asymmetry the rest of the suite pins for ordinary nodes.
    expect(sv.scene.faces.length).toBeLessThanOrEqual(dbacv.stats.objectsOut)
  })
})
