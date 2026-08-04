/**
 * The EASE Focus 3 project format, and the conversion into it.
 *
 * Two real fixtures anchor the format understanding, both written by EASE Focus 3.1.260
 * itself: `default.fc3` is an untouched default project saved by the application, and
 * `ruler_resaved.fc3` is a synthetic multi-zone file this module's prototype produced,
 * loaded by the application and saved back — which is the proof the application accepts
 * what we write. A byte-exact round trip is NOT the standard here, deliberately: the
 * application serialises its Hashtable in hash order, which reshuffles between saves, so
 * equality is asserted on the decoded model instead. See docs/ease-focus-format.md.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ImportedNode } from '../import/types.ts'
import { importEaseFocusAsScene } from '../import/easefocusScene.ts'
import { PlaneType } from '../dbacv/types.ts'
import {
  isEaseFocusFile,
  newGuid,
  readSoapHashtable,
  unframeFc3,
  writeSoapHashtable,
} from './container.ts'
import { DEFAULT_EASEFOCUS_CONVERT, convertNodesToEaseFocus, outlineToZone } from './convert.ts'
import { readEaseFocus } from './read.ts'
import type { EaseFocusProject } from './types.ts'
import { fmt, writeEaseFocus } from './write.ts'

const fixture = (name: string) =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`../../../test/fixtures/${name}`, import.meta.url))))

const node = (positions: number[], name = 'n'): ImportedNode => ({
  id: name,
  name,
  tags: [],
  positions: new Float64Array(positions),
  children: [],
})

/** A rectangle rising from z1 at y=0 to z2 at y=d, wound counter-clockwise from above. */
function rake(w: number, d: number, z1: number, z2: number): number[] {
  return [0, 0, z1, w, 0, z1, w, d, z2, 0, 0, z1, w, d, z2, 0, d, z2]
}

describe('container', () => {
  it('sniffs a real file and rejects noise', () => {
    expect(isEaseFocusFile(fixture('default.fc3'))).toBe(true)
    expect(isEaseFocusFile(fixture('ruler_resaved.fc3'))).toBe(true)
    expect(isEaseFocusFile(new TextEncoder().encode('not a project'))).toBe(false)
  })

  it('round-trips a SOAP hashtable including interning and byte arrays', () => {
    const xml = writeSoapHashtable([
      ['a', 'hello'],
      ['b', 'hello'], // interned: second occurrence becomes an href
      ['c', { base64: 'BLFWZIaro0OfvG08Ynx3Aw==' }],
      ['d', 'x < y & z'],
    ])
    const map = readSoapHashtable(xml)
    expect(map.get('a')).toBe('hello')
    expect(map.get('b')).toBe('hello')
    expect(map.get('c')).toEqual({ base64: 'BLFWZIaro0OfvG08Ynx3Aw==' })
    expect(map.get('d')).toBe('x < y & z')
  })

  it('resolves hrefs in a file the application itself interned', () => {
    // In the re-saved fixture three of the four zone Type values are hrefs to the fourth.
    const { payloadXml } = unframeFc3(fixture('ruler_resaved.fc3'))
    const map = readSoapHashtable(payloadXml)
    for (let i = 0; i < 4; i++) {
      expect(map.get(`Project.AudienceZoneManager.Zone[${i}].Type`)).toBe('Rectangle')
    }
  })

  it('writes .NET Guid byte layout', () => {
    // 6456b104-ab86-43a3-9fbc-6d3c627c7703 <-> BLFWZIaro0OfvG08Ynx3Aw== observed in a
    // real default project: first three fields little-endian, the rest in order.
    const g = newGuid()
    expect(g.text).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    const hex = g.text.replace(/-/g, '')
    const bytes = atob(g.base64)
    expect(bytes.length).toBe(16)
    const at = (i: number) => bytes.charCodeAt(i).toString(16).padStart(2, '0')
    expect(at(0) + at(1) + at(2) + at(3)).toBe(
      hex.slice(6, 8) + hex.slice(4, 6) + hex.slice(2, 4) + hex.slice(0, 2),
    )
    expect(at(8)).toBe(hex.slice(16, 18))
  })
})

describe('reading real files', () => {
  it('reads the default project the application saved', () => {
    const { project, writtenBy, warnings } = readEaseFocus(fixture('default.fc3'))
    expect(writtenBy).toContain('EASE Focus 3')
    expect(project.title).toBe('New EASE Focus Project')
    expect(project.zones).toHaveLength(1)
    const zone = project.zones[0]
    expect(zone).toMatchObject({ x: 50, y: 0, width: 50, depth: 100, orientation: 0 })
    expect(zone.areas).toEqual([
      { label: 'Audience Area 1', d1: 0, d2: 100, z1: 0, z2: 0 },
    ])
    expect(warnings).toEqual([])
  })

  it('reads the multi-zone file the application re-saved', () => {
    const { project } = readEaseFocus(fixture('ruler_resaved.fc3'))
    expect(project.zones.map((z) => z.label)).toEqual(['A origin', 'B x20', 'C y20', 'D rot30'])
    expect(project.zones[3]).toMatchObject({ x: 40, y: 10, orientation: 30, width: 4, depth: 8 })
    expect(project.zones[3].areas[0]).toMatchObject({ d1: 0, d2: 8, z1: 1, z2: 5 })
  })
})

describe('write -> read round trip', () => {
  it('preserves the model exactly', () => {
    const project: EaseFocusProject = {
      title: 'Round trip',
      author: 'ArrayCAD',
      company: '',
      notes: 'a note with <angles> & ampersands',
      zones: [
        {
          label: 'Stalls',
          x: 12.5,
          y: -3.25,
          orientation: -90,
          width: 18,
          depth: 22.75,
          referenceZ: 0,
          areas: [
            { label: 'Flat', d1: 0, d2: 10, z1: 0, z2: 0 },
            { label: 'Rake', d1: 10, d2: 22.75, z1: 0, z2: 4.2 },
          ],
        },
        {
          label: 'Balcony',
          x: 40,
          y: 0,
          orientation: 180,
          width: 30,
          depth: 12,
          referenceZ: 0,
          areas: [{ label: 'Balcony', d1: 0, d2: 12, z1: 6, z2: 9 }],
        },
      ],
    }
    const { project: back, writtenBy, warnings } = readEaseFocus(writeEaseFocus(project))
    expect(back).toEqual(project)
    expect(writtenBy).toContain('3.1.260')
    expect(warnings).toEqual([])
  })

  it('numbers survive as shortest round-trip decimals', () => {
    expect(fmt(22.75)).toBe('22.75')
    expect(fmt(-0.1)).toBe('-0.1')
    expect(fmt(100)).toBe('100')
    expect(() => fmt(NaN)).toThrow(/not finite/)
  })
})

describe('conversion', () => {
  const opts = DEFAULT_EASEFOCUS_CONVERT

  it('a flat floor becomes one zone with a flat profile', () => {
    const r = convertNodesToEaseFocus(
      [{ node: node(rake(10, 20, 0, 0)), planeType: PlaneType.Listening, include: true, name: 'Floor' }],
      opts,
    )
    expect(r.project.zones).toHaveLength(1)
    const z = r.project.zones[0]
    expect(z.width).toBeCloseTo(10, 6)
    expect(z.depth).toBeCloseTo(20, 6)
    expect(z.areas[0].z1).toBeCloseTo(0, 6)
    expect(z.areas[0].z2).toBeCloseTo(0, 6)
  })

  it('a rake faces downslope: front at the low edge, axis upslope', () => {
    // Rises along +y from 0 to 4 over 20 m: axis should be +y = orientation 90 degrees,
    // front height 0, back height 4.
    const r = convertNodesToEaseFocus(
      [{ node: node(rake(10, 20, 0, 4)), planeType: PlaneType.Listening, include: true, name: 'Rake' }],
      opts,
    )
    const z = r.project.zones[0]
    expect(z.orientation).toBeCloseTo(90, 4)
    expect(z.depth).toBeCloseTo(20, 4)
    expect(z.width).toBeCloseTo(10, 4)
    expect(z.areas[0].z1).toBeCloseTo(0, 4)
    expect(z.areas[0].z2).toBeCloseTo(4, 4)
  })

  it('a downward-wound rake still faces upslope', () => {
    // Same geometry with every triangle wound the other way (normal -z): the surface
    // gradient is winding-independent and the zone must come out identical.
    const p = rake(10, 20, 0, 4)
    const flipped: number[] = []
    for (let i = 0; i < p.length; i += 9) {
      flipped.push(p[i], p[i + 1], p[i + 2], p[i + 6], p[i + 7], p[i + 8], p[i + 3], p[i + 4], p[i + 5])
    }
    const r = convertNodesToEaseFocus(
      [{ node: node(flipped), planeType: PlaneType.Listening, include: true, name: 'Rake' }],
      opts,
    )
    expect(r.project.zones[0].orientation).toBeCloseTo(90, 4)
    expect(r.project.zones[0].areas[0].z2).toBeCloseTo(4, 4)
  })

  it('non-Listening planes are left out and reported once', () => {
    const r = convertNodesToEaseFocus(
      [
        { node: node(rake(10, 20, 0, 0), 'floor'), planeType: PlaneType.Listening, include: true, name: 'Floor' },
        { node: node(rake(5, 5, 0, 0), 'stage'), planeType: PlaneType.Stage, include: true, name: 'Stage' },
      ],
      opts,
    )
    expect(r.project.zones).toHaveLength(1)
    expect(r.stats.nodesNotAudience).toBe(1)
    expect(r.warnings.join('\n')).toContain('audience zones only')
  })

  // The application silently widens any zone under 2 m to exactly 2 m about its centre —
  // observed on 45 of the 57 zones of theatre.dbacv, with depths under 2 m left alone.
  // A narrow row therefore predicts over seats that are not in the room, with nothing on
  // screen to say so, which is why this warning has to name width and not depth.
  it('warns that a narrow zone will be silently widened', () => {
    const narrow = convertNodesToEaseFocus(
      [{ node: node(rake(1.5, 8, 0, 1)), planeType: PlaneType.Listening, include: true, name: 'Row K' }],
      opts,
    )
    expect(narrow.project.zones[0].width).toBeCloseTo(1.5, 4)
    expect(narrow.warnings.join('\n')).toContain('silently widens')

    // Depth under 2 m is NOT clamped by the application, so it must not warn as if it were.
    const shallow = convertNodesToEaseFocus(
      [{ node: node(rake(9, 1.5, 0, 0.3)), planeType: PlaneType.Listening, include: true, name: 'Shallow' }],
      opts,
    )
    expect(shallow.warnings.join('\n')).not.toContain('silently widens')
  })

  it('warns on a slope EASE Focus will not accept', () => {
    const steep = convertNodesToEaseFocus(
      [{ node: node(rake(4, 6, 0, 7)), planeType: PlaneType.Listening, include: true, name: 'Steep' }],
      opts,
    )
    expect(steep.warnings.join('\n')).toContain('at most 45')
  })

  it('a vertical plane is refused, not mangled', () => {
    const wall = [0, 0, 0, 10, 0, 0, 10, 0, 5, 0, 0, 0, 10, 0, 5, 0, 0, 5]
    const warnings: string[] = []
    const r = convertNodesToEaseFocus(
      [{ node: node(wall), planeType: PlaneType.Listening, include: true, name: 'Wall' }],
      opts,
    )
    expect(r.project.zones).toHaveLength(0)
    expect(r.warnings.join('\n')).toContain('near-vertical')
    void warnings
  })
})

describe('importing as a scene', () => {
  it('the default project arrives as one Listening plane of two triangles', () => {
    const scene = importEaseFocusAsScene(fixture('default.fc3'), 'default.fc3')
    expect(scene.nodes).toHaveLength(1)
    expect(scene.nodes[0].suggestedPlaneType).toBe(PlaneType.Listening)
    expect(scene.nodes[0].positions.length).toBe(18)
    expect(scene.unitsPerMetre).toBe(1)
  })

  it('zone geometry lands where the zone says: centre anchor, front at centre minus half depth', () => {
    const scene = importEaseFocusAsScene(fixture('default.fc3'), 'default.fc3')
    // Default zone: x=50 y=0, width 50, depth 100, flat at 0 -> spans x 0..100, y -25..25.
    const xs: number[] = []
    const ys: number[] = []
    const p = scene.nodes[0].positions
    for (let i = 0; i < p.length; i += 3) {
      xs.push(p[i])
      ys.push(p[i + 1])
    }
    expect(Math.min(...xs)).toBeCloseTo(0, 6)
    expect(Math.max(...xs)).toBeCloseTo(100, 6)
    expect(Math.min(...ys)).toBeCloseTo(-25, 6)
    expect(Math.max(...ys)).toBeCloseTo(25, 6)
  })

  it('a full circle: export the imported default and the zone comes back unchanged', () => {
    const scene = importEaseFocusAsScene(fixture('default.fc3'), 'default.fc3')
    const r = convertNodesToEaseFocus(
      scene.nodes.map((n) => ({
        node: n,
        planeType: PlaneType.Listening,
        include: true,
        name: n.name,
      })),
      DEFAULT_EASEFOCUS_CONVERT,
    )
    expect(r.project.zones).toHaveLength(1)
    const z = r.project.zones[0]
    expect(z.width).toBeCloseTo(50, 4)
    expect(z.depth).toBeCloseTo(100, 4)
    expect(z.x).toBeCloseTo(50, 4)
    expect(z.y).toBeCloseTo(0, 4)
  })
})

describe('outlineToZone edge behaviour', () => {
  it('flat plane axis points away from the origin', () => {
    // A flat 4x4 at x 10..14: the PA is at the origin, so the front edge should be the
    // near one (x=10) and the axis +x, orientation 0.
    const outline = {
      basis: {
        origin: { x: 0, y: 0, z: 0 },
        u: { x: 1, y: 0, z: 0 },
        v: { x: 0, y: 1, z: 0 },
        n: { x: 0, y: 0, z: 1 },
      },
      outer: [
        [10, -2],
        [14, -2],
        [14, 2],
        [10, 2],
      ] as [number, number][],
      holes: [],
    }
    const warnings: string[] = []
    const zone = outlineToZone(outline, 'flat', warnings)
    expect(zone).not.toBeNull()
    expect(zone!.orientation).toBeCloseTo(0, 4)
    expect(zone!.x).toBeCloseTo(12, 6)
  })
})
