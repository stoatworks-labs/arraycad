/**
 * The Soundvision 3D room data format, and the conversion into it.
 *
 * `test/fixtures/roomdata.txt` is a synthetic file written in the exact byte format of a
 * Vectorworks plug-in export, covering the features that actually vary: a quad, a triangle,
 * a five-sided polygon, several labels, and a negative-zero coordinate.
 *
 * The writer has additionally been checked byte for byte against a real 7,194-face
 * Vectorworks export of a live venue (1.0 MB, 29,760 coordinates). That file is a client
 * drawing and is not in the repo; see docs/soundvision-format.md.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ImportedNode } from '../import/types.ts'
import { DEFAULT_SOUNDVISION_CONVERT, convertNodeToFaces, convertNodesToSoundvision } from './convert.ts'
import { readSoundvision } from './read.ts'
import { DEFAULT_HEADER } from './types.ts'
import { f6, faceNormal, orientFace, writeFaces, writeSoundvision } from './write.ts'

const FIXTURE = fileURLToPath(new URL('../../../test/fixtures/roomdata.txt', import.meta.url))
const fixture = readFileSync(FIXTURE, 'utf8')

function node(positions: number[], name = 'n'): ImportedNode {
  return { id: name, name, tags: [], positions: new Float64Array(positions), children: [] }
}

/** A z = 0 rectangle wound counter-clockwise seen from above, so its normal is +Z. */
function floor(w: number, d: number, z = 0): number[] {
  return [0, 0, z, w, 0, z, w, d, z, 0, 0, z, w, d, z, 0, d, z]
}

describe('f6', () => {
  it('is C %.6f', () => {
    expect(f6(-41.373)).toBe('-41.373000')
    expect(f6(0)).toBe('0.000000')
    expect(f6(1)).toBe('1.000000')
    expect(f6(-63.749985)).toBe('-63.749985')
  })

  // A real export contains -0.000000 168 times. JavaScript's (-0).toFixed(6) is "0.000000",
  // which is geometrically identical and breaks the round trip anyway.
  it('keeps negative zero', () => {
    expect(f6(-0)).toBe('-0.000000')
    expect(f6(0)).toBe('0.000000')
    expect(f6(-1e-9)).toBe('-0.000000')
  })

  it('refuses a non-finite coordinate rather than writing "NaN"', () => {
    expect(() => f6(NaN)).toThrow(/not finite/)
    expect(() => f6(Infinity)).toThrow(/not finite/)
  })
})

describe('round trip', () => {
  it('reads the fixture', () => {
    const { scene, warnings } = readSoundvision(fixture)
    expect(scene.faces.map((f) => f.label)).toEqual(['None face', 'Stage Trusses face', 'Seating face'])
    expect(scene.faces.map((f) => f.points.length)).toEqual([4, 3, 5])
    expect(scene.header).toHaveLength(10)
    expect(scene.header[0]).toBe('"; VECTORWORKS"')
    expect(warnings).toEqual([])
  })

  it('writes it back byte for byte', () => {
    const { scene } = readSoundvision(fixture)
    expect(writeSoundvision(scene, { winding: 'preserve' })).toBe(fixture)
  })

  it('survives CRLF on the way in', () => {
    const { scene } = readSoundvision(fixture.replace(/\n/g, '\r\n'))
    expect(writeSoundvision(scene, { winding: 'preserve' })).toBe(fixture)
  })

  it('closes an unterminated final face', () => {
    const truncated = fixture.split('\n').slice(0, -2).join('\n')
    expect(readSoundvision(truncated).scene.faces).toHaveLength(3)
  })

  it('says so when the file is not room data', () => {
    const { scene, warnings } = readSoundvision('<?xml version="1.0"?>\n<venue/>\n')
    expect(scene.faces).toHaveLength(0)
    expect(warnings.join(' ')).toMatch(/3D room data/)
  })
})

describe('writer', () => {
  it('emits header, label, coordinates and a closing separator', () => {
    const out = writeFaces([
      { label: 'a face', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }] },
    ])
    const lines = out.split('\n')
    expect(lines.slice(0, DEFAULT_HEADER.length)).toEqual([...DEFAULT_HEADER])
    expect(lines[DEFAULT_HEADER.length]).toBe('"Label","a face"')
    expect(lines[DEFAULT_HEADER.length + 1]).toBe('0.000000,0.000000,0.000000')
    expect(lines[DEFAULT_HEADER.length + 4]).toBe('";"')
    expect(out.endsWith('";"\n')).toBe(true)
  })

  it('does not close the ring — the last point never repeats the first', () => {
    const pts = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }]
    const coords = writeFaces([{ label: 'r', points: pts }])
      .split('\n')
      .filter((l) => /^-?\d/.test(l))
    expect(coords).toHaveLength(3)
  })

  it('drops a face with fewer than three points', () => {
    const out = writeFaces([{ label: 'x', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }] }])
    expect(out).toBe(`${DEFAULT_HEADER.join('\n')}\n`)
  })

  it('neutralises a quote in a label so the field cannot end early', () => {
    const out = writeFaces([
      { label: 'a "quoted" layer', points: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }] },
    ])
    expect(out).toContain('"Label","a  quoted  layer"')
    expect(out.split('\n').filter((l) => l.startsWith('"Label"'))).toHaveLength(1)
  })
})

describe('winding', () => {
  const up = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }]
  const down = [...up].reverse()

  it('computes the normal of a ring', () => {
    expect(faceNormal(up).z).toBeGreaterThan(0)
    expect(faceNormal(down).z).toBeLessThan(0)
  })

  // Soundvision does not reject a reversed surface, it just returns no mapping result.
  it("'up' reverses a floor that faces down, and leaves one that faces up", () => {
    expect(faceNormal(orientFace(down, 'up')).z).toBeGreaterThan(0)
    expect(orientFace(up, 'up')).toBe(up)
  })

  it("'up' leaves a vertical wall alone — there is no correct side without the room", () => {
    const wall = [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 2 }, { x: 3, y: 0, z: 2 }, { x: 3, y: 0, z: 0 }]
    expect(orientFace(wall, 'up')).toBe(wall)
  })

  it("'preserve' changes nothing", () => {
    expect(orientFace(down, 'preserve')).toBe(down)
  })

  it('does not throw on a degenerate ring', () => {
    const zero = [{ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }]
    expect(() => orientFace(zero, 'up')).not.toThrow()
  })
})

describe('convert', () => {
  it('turns a flat deck into one surface, outline intact', () => {
    const r = convertNodeToFaces(node(floor(10, 6)), 'deck face', DEFAULT_SOUNDVISION_CONVERT)
    expect(r.stats.regionsFound).toBe(1)
    expect(r.faces).toHaveLength(1)
    expect(r.faces[0].label).toBe('deck face')
    expect(r.faces[0].points).toHaveLength(4)
  })

  /**
   * The reason this target exists. ArrayCalc cannot express a plane that is not a symmetric
   * trapezoid and splits it into two triangles; Soundvision takes the polygon whole.
   */
  it('keeps a six-sided outline as ONE surface', () => {
    const hexagon: number[] = []
    const pts = [[0, 0], [4, 0], [6, 3], [4, 6], [0, 6], [-2, 3]]
    for (let i = 1; i < pts.length - 1; i++) {
      hexagon.push(pts[0][0], pts[0][1], 0, pts[i][0], pts[i][1], 0, pts[i + 1][0], pts[i + 1][1], 0)
    }
    const r = convertNodeToFaces(node(hexagon), 'h face', DEFAULT_SOUNDVISION_CONVERT)
    expect(r.faces).toHaveLength(1)
    expect(r.faces[0].points).toHaveLength(6)
  })

  it('emits every face of a box', () => {
    const b: number[] = []
    const box = (w: number, d: number, h: number) => {
      const v = [
        [0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0],
        [0, 0, h], [w, 0, h], [w, d, h], [0, d, h],
      ]
      const q = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 3, 7, 4]]
      for (const [a, c, e, f] of q) {
        for (const t of [[a, c, e], [a, e, f]]) for (const i of t) b.push(v[i][0], v[i][1], v[i][2])
      }
    }
    box(4, 3, 2)
    const r = convertNodeToFaces(node(b), 'box face', DEFAULT_SOUNDVISION_CONVERT)
    expect(r.stats.regionsFound).toBe(6)
    expect(r.faces).toHaveLength(6)
  })

  it('orients every emitted floor upward by default', () => {
    // Wound clockwise from above, so the source normal is -Z.
    const flipped = [0, 0, 0, 0, 6, 0, 10, 6, 0, 0, 0, 0, 10, 6, 0, 10, 0, 0]
    const r = convertNodeToFaces(node(flipped), 'f face', DEFAULT_SOUNDVISION_CONVERT)
    expect(r.faces).toHaveLength(1)
    expect(faceNormal(r.faces[0].points).z).toBeGreaterThan(0)
  })

  it('reports triangles in and faces out', () => {
    const r = convertNodeToFaces(node(floor(10, 6)), 'd face', DEFAULT_SOUNDVISION_CONVERT)
    expect(r.stats.trianglesIn).toBe(2)
    expect(r.stats.facesOut).toBe(1)
  })

  it('honours rectangle fit', () => {
    const ragged = [0, 0, 0, 10, 0, 0, 10, 6, 0, 0, 0, 0, 10, 6, 0, 3, 6, 0]
    const r = convertNodeToFaces(node(ragged), 'r face', { ...DEFAULT_SOUNDVISION_CONVERT, fit: 'rect' })
    expect(r.faces[0].points).toHaveLength(4)
  })

  it('skips nodes that are not included, and labels the rest', () => {
    const r = convertNodesToSoundvision(
      [
        { node: node(floor(4, 4), 'a'), include: true, name: 'Stalls' },
        { node: node(floor(4, 4), 'b'), include: false, name: 'Roof' },
      ],
      DEFAULT_SOUNDVISION_CONVERT,
    )
    expect(r.scene.faces).toHaveLength(1)
    expect(r.scene.faces[0].label).toBe('Stalls face')
  })

  it('warns that listening levels are not carried by the format', () => {
    const r = convertNodesToSoundvision([{ node: node(floor(4, 4)), include: true, name: 'Stalls' }])
    expect(r.warnings.join(' ')).toMatch(/listening levels/i)
  })

  it('produces a file that reads back to the same geometry', () => {
    const r = convertNodesToSoundvision([{ node: node(floor(10, 6)), include: true, name: 'Deck' }])
    const round = readSoundvision(writeSoundvision(r.scene))
    expect(round.scene.faces).toHaveLength(1)
    expect(round.scene.faces[0].label).toBe('Deck face')
    expect(round.scene.faces[0].points).toHaveLength(4)
  })

  it('does not throw on empty or degenerate input', () => {
    expect(convertNodeToFaces(node([]), 'e', DEFAULT_SOUNDVISION_CONVERT).faces).toHaveLength(0)
    const degenerate = node([0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(() => convertNodeToFaces(degenerate, 'd', DEFAULT_SOUNDVISION_CONVERT)).not.toThrow()
    expect(convertNodesToSoundvision([]).scene.faces).toHaveLength(0)
  })
})
