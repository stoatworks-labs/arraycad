import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { strFromU8, unzipSync } from 'fflate'
import { GlbError, encodeGlb, writeGlb } from './glb.ts'
import { geometryFileName, stableUuid, writeMvr } from './write.ts'
import {
  DEFAULT_MVR_CONVERT,
  classNameFor,
  convertNodesToMvr,
  outlinesToPositions,
} from './convert.ts'
import { readMembers, readRootFile } from './container.ts'
import { parseMvr } from './read.ts'
import { type MeshDecoder, buildMvrNodes, intoArrayCalcFrame, referencedFiles } from './scene.ts'
import { PlaneType } from '../dbacv/types.ts'
import type { ImportedNode } from '../import/types.ts'
import { flattenNodes } from '../import/types.ts'
import { planeBasis } from '../geom/vec.ts'

const parser = new (new JSDOM().window.DOMParser)()

/** A 10 x 6 m rectangle on the floor, as two triangles. */
const DECK = [0, 0, 0, 10, 0, 0, 10, 6, 0, 0, 0, 0, 10, 6, 0, 0, 6, 0]

const node = (name: string, tris: number[]): ImportedNode => ({
  id: name,
  name,
  tags: [],
  positions: new Float64Array(tris),
  children: [],
})

const entry = (name: string, tris: number[], planeType = PlaneType.Listening) => ({
  node: node(name, tris),
  planeType,
  include: true,
  name,
})

/** Read a glb's JSON chunk back, for asserting on what was written. */
function glbJson(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(view.getUint32(0, true)).toBe(0x46546c67)
  expect(view.getUint32(8, true)).toBe(bytes.length)
  const jsonLen = view.getUint32(12, true)
  expect(view.getUint32(16, true)).toBe(0x4e4f534a)
  return JSON.parse(strFromU8(bytes.subarray(20, 20 + jsonLen)))
}

/** Read a glb's POSITION data back as plain numbers. */
function glbPositions(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const jsonLen = view.getUint32(12, true)
  const binStart = 20 + jsonLen
  const binLen = view.getUint32(binStart, true)
  expect(view.getUint32(binStart + 4, true)).toBe(0x004e4942)
  const out: number[] = []
  for (let i = 0; i + 4 <= binLen; i += 4) out.push(view.getFloat32(binStart + 8 + i, true))
  return out
}

describe('glb writer', () => {
  it('writes a container three.js and the glTF spec both agree on', () => {
    const doc = glbJson(writeGlb('Deck', new Float64Array(DECK)))
    expect(doc.asset.version).toBe('2.0')
    expect(doc.meshes[0].name).toBe('Deck')
    expect(doc.accessors[0].count).toBe(6)
    expect(doc.accessors[0].type).toBe('VEC3')
    // MVR Table 46 requires this to be absent or empty.
    expect(doc.extensionsRequired).toBeUndefined()
  })

  it('writes accessor bounds that actually bound the data', () => {
    const doc = glbJson(encodeGlb('Deck', new Float64Array(DECK)))
    expect(doc.accessors[0].min).toEqual([0, 0, 0])
    expect(doc.accessors[0].max).toEqual([10, 6, 0])
  })

  it('round-trips the positions it was given', () => {
    expect(glbPositions(encodeGlb('Deck', new Float64Array(DECK)))).toEqual(DECK)
  })

  it('writes Y-up, because glTF is Y-up whatever the MVR around it says', () => {
    // MVR (x, y, z) -> glTF (x, z, -y). A floor stays a floor: it lies in glTF's XZ plane
    // with the height in Y, which is how ArrayCalc 13 writes its own. Written Z-up, the
    // same deck arrived in ArrayCalc lying on its back.
    const bytes = writeGlb('Deck', new Float64Array(DECK))
    const expected: number[] = []
    for (let i = 0; i < DECK.length; i += 3) expected.push(DECK[i], DECK[i + 2], 0 - DECK[i + 1])
    expect(glbPositions(bytes)).toEqual(expected)
    expect(glbJson(bytes).accessors[0].min).toEqual([0, 0, -6])
    expect(glbJson(bytes).accessors[0].max).toEqual([10, 0, 0])
  })

  it('pads both chunks to four bytes', () => {
    // "Ω" is two bytes in UTF-8 and one JS character; a length taken from the string would
    // truncate the JSON and misplace the BIN chunk.
    const bytes = encodeGlb('Ωmega', new Float64Array(DECK))
    expect(bytes.length % 4).toBe(0)
    expect(glbJson(bytes).meshes[0].name).toBe('Ωmega')
    expect(glbPositions(bytes)).toEqual(DECK)
  })

  it('refuses geometry that is not a triangle', () => {
    expect(() => writeGlb('Empty', new Float64Array(0))).toThrow(GlbError)
    expect(() => writeGlb('Sliver', new Float64Array([0, 0, 0, 1, 1, 1]))).toThrow(GlbError)
  })

  it('refuses a non-finite coordinate rather than writing a file no loader accepts', () => {
    const bad = [...DECK]
    bad[4] = NaN
    expect(() => writeGlb('Bad', new Float64Array(bad))).toThrow(/non-finite/)
  })
})

describe('MVR filenames and ids', () => {
  it('reduces a plane name to the spec\'s portable character set', () => {
    expect(geometryFileName(0, 'STALLS RAKE')).toBe('001_STALLS_RAKE.glb')
    expect(geometryFileName(11, 'Balcony / Tier 2')).toBe('012_Balcony_Tier_2.glb')
    // One full stop only, and nothing that would upset FAT32.
    expect(geometryFileName(0, 'a<b>c:d"e|f?g*h')).toMatch(/^001_[A-Za-z0-9_]*\.glb$/)
  })

  it('still produces a usable name when nothing survives the filter', () => {
    expect(geometryFileName(4, '???')).toBe('005.glb')
  })

  it('gives the same object the same uuid on every export', () => {
    // MVR: "All objects used have a persistent unique ID to track changes between the
    // different applications" — Depence uses it to update in place instead of duplicating.
    expect(stableUuid('object:STALLS#0')).toBe(stableUuid('object:STALLS#0'))
    expect(stableUuid('object:STALLS#0')).not.toBe(stableUuid('object:STALLS#1'))
  })

  it('writes uuids in RFC4122 form, never the forbidden nil uuid', () => {
    const u = stableUuid('anything')
    expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(u).not.toBe('00000000-0000-0000-0000-000000000000')
  })

  it('keeps ids stable when a plane is inserted before others', () => {
    const a = writeMvr({ projectName: 'V', layerName: 'V', objects: [
      { name: 'STALLS', positions: new Float64Array(DECK) },
    ] })
    const b = writeMvr({ projectName: 'V', layerName: 'V', objects: [
      { name: 'STAGE', positions: new Float64Array(DECK) },
      { name: 'STALLS', positions: new Float64Array(DECK) },
    ] })
    const uuidOf = (r: { bytes: Uint8Array }, name: string) =>
      strFromU8(unzipSync(r.bytes)['GeneralSceneDescription.xml'])
        .match(new RegExp(`uuid="([^"]+)" name="${name}"`))![1]
    expect(uuidOf(b, 'STALLS')).toBe(uuidOf(a, 'STALLS'))
  })
})

describe('MVR writer', () => {
  const scene = {
    projectName: 'Theatre',
    layerName: 'Theatre',
    objects: [
      { name: 'STALLS RAKE', positions: new Float64Array(DECK), className: 'Listening (1)' },
      { name: 'CEILING', positions: new Float64Array(DECK), className: 'Surface (2)' },
      { name: 'BALCONY', positions: new Float64Array(DECK), className: 'Listening (1)' },
    ],
  }

  it('produces an archive with the root file and one glb per plane', () => {
    const files = unzipSync(writeMvr(scene).bytes)
    expect(Object.keys(files).sort()).toEqual([
      '001_STALLS_RAKE.glb',
      '002_CEILING.glb',
      '003_BALCONY.glb',
      'GeneralSceneDescription.xml',
    ].sort())
  })

  const rootXml = (flavour?: 'arraycalc' | 'visualiser') =>
    strFromU8(unzipSync(writeMvr(scene, flavour).bytes)['GeneralSceneDescription.xml'])

  it('declares the version each flavour conforms to, not the newest one it can read', () => {
    // ListeningPlane exists only in the audio proposal, which ArrayCalc 13 writes as 1.6.
    expect(rootXml()).toContain('verMajor="1" verMinor="6"')
    // 1.4 is the floor Capture and Depence both accept, and nothing written is newer.
    expect(rootXml('visualiser')).toContain('verMajor="1" verMinor="4"')
    expect(rootXml()).toContain('provider="ArrayCAD"')
  })

  it('writes listening planes as ListeningPlane for ArrayCalc, the rest as SceneObject', () => {
    // ArrayCalc 13's importer types an object Listening from this node and nothing else —
    // not from the class name, which it ignores. An unknown object defaults to Background.
    const xml = strFromU8(unzipSync(writeMvr({
      projectName: 'V',
      layerName: 'V',
      objects: [
        { name: 'STALLS', positions: new Float64Array(DECK), listening: true },
        { name: 'CEILING', positions: new Float64Array(DECK) },
      ],
    }).bytes)['GeneralSceneDescription.xml'])
    expect(xml).toMatch(/<ListeningPlane uuid="[^"]+" name="STALLS">[\s\S]*?<\/ListeningPlane>/)
    expect(xml).toMatch(/<SceneObject uuid="[^"]+" name="CEILING">/)
    expect(() => parseMvr(xml, parser)).not.toThrow()
  })

  it('writes nothing but SceneObjects for a visualiser, under the same uuids', () => {
    const objects = [{ name: 'STALLS', positions: new Float64Array(DECK), listening: true }]
    const ac = strFromU8(unzipSync(writeMvr({ projectName: 'V', layerName: 'V', objects }).bytes)['GeneralSceneDescription.xml'])
    const vis = strFromU8(unzipSync(writeMvr({ projectName: 'V', layerName: 'V', objects }, 'visualiser').bytes)['GeneralSceneDescription.xml'])
    expect(vis).not.toContain('ListeningPlane')
    // Switching flavour must not turn one room into two in an application that tracks ids.
    const uuidOf = (xml: string) => xml.match(/uuid="([^"]+)" name="STALLS"/)![1]
    expect(uuidOf(vis)).toBe(uuidOf(ac))
  })

  it('turns the room into the plan orientation ArrayCalc writes MVR in', () => {
    // Venue (x, y) -> MVR (y, -x), then Y-up: the deck's 10 m along venue X ends up along
    // glTF Z and its 6 m along venue Y along glTF X. ArrayCalc's own export of its default
    // venue does exactly this, and its importer undoes it at the dialog's default 90°.
    const files = unzipSync(writeMvr({
      projectName: 'V',
      layerName: 'V',
      objects: [{ name: 'DECK', positions: new Float64Array(DECK) }],
    }).bytes)
    const doc = glbJson(files['001_DECK.glb'])
    expect(doc.accessors[0].min).toEqual([0, 0, 0])
    expect(doc.accessors[0].max).toEqual([6, 0, 10])
  })

  it('declares each plane type once as a Class and refers to it by uuid', () => {
    const xml = rootXml()
    expect(xml.match(/<Class /g)).toHaveLength(2)
    const listening = xml.match(/<Class uuid="([^"]+)" name="Listening \(1\)"/)![1]
    // Both audience planes point at the same class, which is what makes them toggleable
    // as a set in the visualiser.
    expect(xml.match(new RegExp(`<Classing>${listening}</Classing>`, 'g'))).toHaveLength(2)
  })

  it('escapes a name that would otherwise break the XML', () => {
    const r = writeMvr({
      projectName: 'V',
      layerName: 'V',
      objects: [{ name: 'SEATS <A & B> "front"', positions: new Float64Array(DECK) }],
    })
    const xml = strFromU8(unzipSync(r.bytes)['GeneralSceneDescription.xml'])
    expect(xml).toContain('name="SEATS &lt;A &amp; B&gt; &quot;front&quot;"')
    expect(() => parseMvr(xml, parser)).not.toThrow()
  })

  it('reports a plane that held no triangle instead of failing the export', () => {
    const r = writeMvr({
      projectName: 'V',
      layerName: 'V',
      objects: [
        { name: 'EMPTY', positions: new Float64Array(0) },
        { name: 'DECK', positions: new Float64Array(DECK) },
      ],
    })
    expect(r.skipped).toEqual(['EMPTY'])
    expect(Object.keys(unzipSync(r.bytes))).toContain('002_DECK.glb')
  })

  it('writes no Matrix at all, which the spec reads as the identity', () => {
    // The frame change is baked into the vertices, as ArrayCalc bakes its own.
    const xml = rootXml()
    expect(xml).not.toContain('<Matrix>')
  })
})

describe('MVR conversion', () => {
  it('carries the plane type out as a class, with the raw code beside the label', () => {
    // The labels are inferred, not verified against ArrayCalc — CLAUDE.md — so the code
    // travels with them.
    expect(classNameFor(PlaneType.Listening)).toBe('Listening (1)')
    expect(classNameFor(PlaneType.PositioningArea)).toBe('Positioning area (5)')
  })

  it('keeps a hole in a region rather than filling it in', () => {
    const basis = planeBasis({ point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } })
    const outer: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]]
    const hole: [number, number][] = [[4, 4], [4, 6], [6, 6], [6, 4]]
    const solid = outlinesToPositions([{ basis, outer, holes: [] }])
    const holed = outlinesToPositions([{ basis, outer, holes: [hole] }])
    // A filled-in hole would come back with no more triangles than the solid square.
    expect(holed.length / 9).toBeGreaterThan(solid.length / 9)
  })

  it('emits one object per node, not one per region', () => {
    // Two coplanar-but-separate decks under one name stay one entry in the tree.
    const two = [...DECK, ...DECK.map((v, i) => (i % 3 === 0 ? v + 50 : v))]
    const r = convertNodesToMvr([entry('STALLS', two)])
    expect(r.scene.objects).toHaveLength(1)
    expect(r.stats.regionsFound).toBe(2)
  })

  it('leaves out a node the user excluded', () => {
    const r = convertNodesToMvr([{ ...entry('STAGE', DECK), include: false }])
    expect(r.scene.objects).toHaveLength(0)
  })

  it('marks listening planes, and only those, for the ArrayCalc flavour', () => {
    const r = convertNodesToMvr([entry('STALLS', DECK), entry('STAGE', DECK, PlaneType.Stage)])
    expect(r.scene.objects.map((o) => [o.name, o.listening])).toEqual([
      ['STALLS', true],
      ['STAGE', false],
    ])
  })

  it('writes a rationalised area alongside the ordinary nodes', () => {
    const basis = planeBasis({ point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } })
    const r = convertNodesToMvr(
      [entry('STAGE', DECK)],
      DEFAULT_MVR_CONVERT,
      [{
        name: 'STALLS',
        planeType: PlaneType.Listening,
        outlines: [{ basis, outer: [[0, 0], [8, 0], [8, 8], [0, 8]], holes: [] }],
      }],
    )
    expect(r.scene.objects.map((o) => o.name)).toEqual(['STAGE', 'STALLS'])
    expect(r.scene.objects[1].listening).toBe(true)
  })
})

describe('MVR round trip', () => {
  /** The importer's decoder, stubbed to read the glbs this writer produced. */
  const decodeGlb: MeshDecoder = async (bytes, fileName) => {
    const positions = glbPositions(bytes)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const jsonLen = view.getUint32(12, true)
    const doc = JSON.parse(strFromU8(bytes.subarray(20, 20 + jsonLen)))
    // Trim the BIN padding back off: the accessor count is the truth, not the chunk size.
    const n = doc.accessors[0].count * 3
    return [{
      id: fileName,
      name: doc.meshes[0].name,
      tags: [],
      positions: new Float64Array(positions.slice(0, n)),
      children: [],
    }]
  }

  it('exports a venue and reads the same room back', async () => {
    const out = convertNodesToMvr(
      [entry('STALLS RAKE', DECK), entry('CEILING', DECK.map((v, i) => (i % 3 === 2 ? 9 : v)), PlaneType.Surface)],
      DEFAULT_MVR_CONVERT,
      [],
      'Theatre',
    )
    const { bytes } = writeMvr(out.scene)

    const back = parseMvr(readRootFile(bytes), parser)
    const files = readMembers(bytes, referencedFiles(back))
    const built = await buildMvrNodes(back, { files, decode: decodeGlb })
    intoArrayCalcFrame(built.nodes)

    const names = flattenNodes(built.nodes).map((n) => n.name)
    expect(names).toContain('Theatre')
    expect(names).toContain('STALLS RAKE')
    expect(names).toContain('CEILING')

    // Metres out, millimetres back, in the same venue axes: the deck that left on
    // 0..10 x 0..6 at floor level comes back on 0..10000 x 0..6000 at 0, and the ceiling
    // at 9000. Two halves agreeing proves only that they agree — the import test and
    // docs/mvr-format.md §8 cite ArrayCalc 13 for the axes themselves.
    const flat = flattenNodes(built.nodes)
    const bounds = (name: string) => {
      const p = [...flat.find((n) => n.name === name)!.positions]
      const axis = (a: number) => p.filter((_, i) => i % 3 === a)
      return [0, 1, 2].map((a) => [Math.min(...axis(a)), Math.max(...axis(a))].map((v) => Math.round(v) + 0))
    }
    expect(bounds('STALLS RAKE')).toEqual([[0, 10000], [0, 6000], [0, 0]])
    expect(bounds('CEILING')).toEqual([[0, 10000], [0, 6000], [9000, 9000]])
  })

  it('brings the plane-type class back as a tag', async () => {
    const out = convertNodesToMvr([entry('STALLS', DECK)], DEFAULT_MVR_CONVERT, [], 'V')
    const { bytes } = writeMvr(out.scene)
    const back = parseMvr(readRootFile(bytes), parser)
    const built = await buildMvrNodes(back, {
      files: readMembers(bytes, referencedFiles(back)),
      decode: decodeGlb,
    })
    const stalls = flattenNodes(built.nodes).find((n) => n.name === 'STALLS')!
    expect(stalls.tags).toContain('Listening (1)')
  })
})
