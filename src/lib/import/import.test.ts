import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { importDxf } from './dxf.ts'
import { importDbacvAsScene } from './dbacvScene.ts'
import { countTriangles, flattenNodes } from './types.ts'
import { DEFAULT_PLANARIZE, findCoplanarRegions, weld } from '../geom/planarize.ts'

const parser = new (new JSDOM().window.DOMParser)()

/** Build a minimal ASCII DXF from group-code pairs. */
function dxf(entities: string[], header: string[] = []): string {
  return [
    '0', 'SECTION', '2', 'HEADER',
    ...header,
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    ...entities,
    '0', 'ENDSEC',
    '0', 'EOF',
  ].join('\n')
}

const face3d = (layer: string, pts: number[][]) => [
  '0', '3DFACE', '8', layer,
  '10', `${pts[0][0]}`, '20', `${pts[0][1]}`, '30', `${pts[0][2]}`,
  '11', `${pts[1][0]}`, '21', `${pts[1][1]}`, '31', `${pts[1][2]}`,
  '12', `${pts[2][0]}`, '22', `${pts[2][1]}`, '32', `${pts[2][2]}`,
  '13', `${pts[3][0]}`, '23', `${pts[3][1]}`, '33', `${pts[3][2]}`,
]

describe('DXF import', () => {
  it('reads a 3DFACE as two triangles', () => {
    const s = importDxf(dxf(face3d('STAGE', [[0, 0, 0], [10, 0, 0], [10, 5, 0], [0, 5, 0]])), 'a.dxf')
    expect(s.nodes).toHaveLength(1)
    expect(s.nodes[0].name).toBe('STAGE')
    expect(countTriangles(s.nodes)).toBe(2)
  })

  it('treats a 3DFACE with a doubled 4th point as one triangle', () => {
    const s = importDxf(dxf(face3d('X', [[0, 0, 0], [10, 0, 0], [10, 5, 0], [10, 5, 0]])), 'a.dxf')
    expect(countTriangles(s.nodes)).toBe(1)
  })

  it('groups entities by layer', () => {
    const s = importDxf(
      dxf([
        ...face3d('SEATING', [[0, 0, 0], [10, 0, 0], [10, 5, 0], [0, 5, 0]]),
        ...face3d('CEILING', [[0, 0, 8], [10, 0, 8], [10, 5, 8], [0, 5, 8]]),
      ]),
      'a.dxf',
    )
    expect(s.nodes.map((n) => n.name).sort()).toEqual(['CEILING', 'SEATING'])
  })

  it('reads $INSUNITS', () => {
    const mm = importDxf(
      dxf(face3d('X', [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]), ['9', '$INSUNITS', '70', '4']),
      'a.dxf',
    )
    expect(mm.unitsPerMetre).toBe(0.001)

    const feet = importDxf(
      dxf(face3d('X', [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]), ['9', '$INSUNITS', '70', '2']),
      'a.dxf',
    )
    expect(feet.unitsPerMetre).toBeCloseTo(0.3048)
  })

  it('leaves units unset and warns when $INSUNITS is 0', () => {
    const s = importDxf(
      dxf(face3d('X', [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]), ['9', '$INSUNITS', '70', '0']),
      'a.dxf',
    )
    expect(s.unitsPerMetre).toBeUndefined()
    expect(s.warnings.join(' ')).toMatch(/does not declare its units/)
  })

  it('reads a closed LWPOLYLINE at its elevation', () => {
    const s = importDxf(
      dxf([
        '0', 'LWPOLYLINE', '8', 'BALCONY', '70', '1', '38', '6.5', '90', '4',
        '10', '0', '20', '0',
        '10', '8', '20', '0',
        '10', '8', '20', '4',
        '10', '0', '20', '4',
      ]),
      'a.dxf',
    )
    expect(countTriangles(s.nodes)).toBe(4) // fan about the centroid
    const m = weld(s.nodes[0].positions, 0.001)
    expect(m.vertices.every((v) => Math.abs(v.z - 6.5) < 1e-9)).toBe(true)
  })

  it('ignores an open polyline unless asked', () => {
    const open = [
      '0', 'LWPOLYLINE', '8', 'DIMS', '70', '0', '90', '3',
      '10', '0', '20', '0', '10', '8', '20', '0', '10', '8', '20', '4',
    ]
    expect(() => importDxf(dxf(open), 'a.dxf')).toThrow(/no surfaces/)
    const s = importDxf(dxf(open), 'a.dxf', { includeOpenPaths: true })
    expect(countTriangles(s.nodes)).toBeGreaterThan(0)
  })

  it('extrudes a flat closed outline into a vertical band', () => {
    const s = importDxf(
      dxf([
        '0', 'LWPOLYLINE', '8', 'WALL', '70', '1', '90', '4',
        '10', '0', '20', '0', '10', '10', '20', '0', '10', '10', '20', '6', '10', '0', '20', '6',
      ]),
      'a.dxf',
      { extrudeFlatTo: 3 },
    )
    const m = weld(s.nodes[0].positions, 0.001)
    const zs = m.vertices.map((v) => v.z)
    expect(Math.min(...zs)).toBeCloseTo(0)
    expect(Math.max(...zs)).toBeCloseTo(3)
    // Four walls, each its own plane.
    expect(findCoplanarRegions(m, DEFAULT_PLANARIZE)).toHaveLength(4)
  })

  it('orders SOLID corners as a ring, not a bow tie', () => {
    // DXF SOLID stores corners 1,2,4,3. Read in file order the quad self-intersects and
    // its two halves cancel to zero area, so the entity would silently vanish.
    const s = importDxf(
      dxf([
        '0', 'SOLID', '8', 'S',
        '10', '0', '20', '0', '30', '0',
        '11', '4', '21', '0', '31', '0',
        '12', '0', '22', '3', '32', '0',
        '13', '4', '23', '3', '33', '0',
      ]),
      'a.dxf',
    )
    const m = weld(s.nodes[0].positions, 0.001)
    const regions = findCoplanarRegions(m, DEFAULT_PLANARIZE)
    expect(regions).toHaveLength(1)
    expect(regions[0].area).toBeCloseTo(12)
  })

  it('expands an INSERT with translation and rotation', () => {
    const src = [
      '0', 'SECTION', '2', 'BLOCKS',
      '0', 'BLOCK', '2', 'SEAT', '10', '0', '20', '0', '30', '0',
      ...face3d('SEATING', [[0, 0, 0], [2, 0, 0], [2, 1, 0], [0, 1, 0]]),
      '0', 'ENDBLK',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'INSERT', '8', 'SEATING', '2', 'SEAT', '10', '100', '20', '50', '30', '0',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n')
    const s = importDxf(src, 'a.dxf')
    expect(countTriangles(s.nodes)).toBe(2)
    const m = weld(s.nodes[0].positions, 0.001)
    expect(Math.min(...m.vertices.map((v) => v.x))).toBeCloseTo(100)
    expect(Math.min(...m.vertices.map((v) => v.y))).toBeCloseTo(50)
  })

  it('expands an INSERT row/column array', () => {
    const src = [
      '0', 'SECTION', '2', 'BLOCKS',
      '0', 'BLOCK', '2', 'SEAT', '10', '0', '20', '0', '30', '0',
      ...face3d('S', [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]]),
      '0', 'ENDBLK', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'INSERT', '8', 'S', '2', 'SEAT', '10', '0', '20', '0', '30', '0',
      '70', '3', '71', '2', '44', '2', '45', '2',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n')
    const s = importDxf(src, 'a.dxf')
    expect(countTriangles(s.nodes)).toBe(2 * 6) // 3 columns x 2 rows
  })

  it('reads a POLYLINE polyface mesh', () => {
    const src = dxf([
      '0', 'POLYLINE', '8', 'M', '70', '64',
      '0', 'VERTEX', '8', 'M', '10', '0', '20', '0', '30', '0', '70', '192',
      '0', 'VERTEX', '8', 'M', '10', '4', '20', '0', '30', '0', '70', '192',
      '0', 'VERTEX', '8', 'M', '10', '4', '20', '3', '30', '0', '70', '192',
      '0', 'VERTEX', '8', 'M', '10', '0', '20', '3', '30', '0', '70', '192',
      '0', 'VERTEX', '8', 'M', '70', '128', '71', '1', '72', '2', '73', '3', '74', '4',
      '0', 'SEQEND',
    ])
    const s = importDxf(src, 'a.dxf')
    expect(countTriangles(s.nodes)).toBe(2)
    const regions = findCoplanarRegions(weld(s.nodes[0].positions, 0.001), DEFAULT_PLANARIZE)
    expect(regions[0].area).toBeCloseTo(12)
  })

  it('rejects a DXF with nothing usable, and says what to do', () => {
    expect(() => importDxf(dxf(['0', 'LINE', '8', 'X', '10', '0', '20', '0', '11', '5', '21', '5']), 'a.dxf'))
      .toThrow(/no surfaces/)
  })
})

describe('.dbacv re-import', () => {
  const xml = readFileSync(new URL('../../../test/fixtures/theatre.dbacv', import.meta.url), 'utf8')
  const scene = importDbacvAsScene(xml, 'theatre.dbacv', parser)

  it('mirrors the venue tree', () => {
    expect(flattenNodes(scene.nodes)).toHaveLength(112)
    expect(scene.unitsPerMetre).toBe(1)
    expect(scene.upAxis).toBe('z')
  })

  it('tessellates every geometry shape', () => {
    const all = flattenNodes(scene.nodes)
    const byName = (n: string) => all.find((x) => x.name === n)!
    expect(countTriangles([byName('SOUNDSCAPE')])).toBe(2) // quad
    expect(countTriangles([byName('BRIDGE 1')])).toBe(12) // box
    expect(countTriangles([byName('TIER 3 - LEFT 2')])).toBe(1) // triangle
    expect(countTriangles([byName('TIER 3 - LEFT 4')])).toBeGreaterThan(2) // arc segment
  })

  it('carries the plane type through as a suggestion', () => {
    const ss = flattenNodes(scene.nodes).find((n) => n.name === 'SOUNDSCAPE')!
    expect(ss.suggestedPlaneType).toBe(5)
  })

  it('composes the group transform onto children', () => {
    // The STAGE group sits at x=-4.8 and its STAGE child at another -4.8. Composed, the
    // stage deck starts at x=-9.6 — which is exactly where the SOUNDSCAPE plane starts.
    const all = flattenNodes(scene.nodes)
    const stage = all.find((n) => n.name === 'STAGE')!
    const xs: number[] = []
    for (let i = 0; i < stage.positions.length; i += 3) xs.push(stage.positions[i])
    expect(Math.min(...xs)).toBeCloseTo(-9.6, 3)
  })

  it('puts the whole venue in a plausible bounding box', () => {
    const all = flattenNodes(scene.nodes)
    let minX = Infinity
    let maxX = -Infinity
    let maxZ = -Infinity
    for (const n of all) {
      for (let i = 0; i < n.positions.length; i += 3) {
        minX = Math.min(minX, n.positions[i])
        maxX = Math.max(maxX, n.positions[i])
        maxZ = Math.max(maxZ, n.positions[i + 2])
      }
    }
    // A theatre: stage at the negative end, mix position out at +13, three tiers of
    // balcony overhead. Sanity, not precision.
    expect(minX).toBeLessThan(-8)
    expect(maxX).toBeGreaterThan(13)
    expect(maxZ).toBeGreaterThan(7)
    expect(maxZ).toBeLessThan(20)
  })
})
