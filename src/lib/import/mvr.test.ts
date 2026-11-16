/**
 * End to end: a real zip holding a real glb, through the real three.js loader.
 *
 * `lib/mvr/mvr.test.ts` covers the parts that matter most — matrices, instancing, units,
 * tagging — with a stub decoder, because those must be checkable without a mesh library.
 * This file exists to prove the one thing a stub cannot: that the seam between the
 * archive and three.js is actually wired up, glb bytes and all.
 */

import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { strToU8, zipSync } from 'fflate'
import { importMvr } from './mvr.ts'
import { ImportError, flattenNodes } from './types.ts'
import { DEFAULT_MVR_CONVERT, convertNodesToMvr } from '../mvr/convert.ts'
import { writeMvr } from '../mvr/write.ts'
import { PlaneType } from '../dbacv/types.ts'
import { categorise } from '../prepare/vocabulary.ts'

// Vitest runs in node here, so supply the browser's DOMParser explicitly.
const parser = new (new JSDOM().window.DOMParser)()
const load = (buffer: ArrayBuffer, name: string) => importMvr(buffer, name, parser)

/**
 * The smallest valid glb: one mesh, one triangle, positions only.
 *
 * Written by hand rather than by an exporter so the bytes in the test are the bytes being
 * asserted on. Container layout per the glTF 2.0 specification §4.4: a 12-byte header,
 * then length-prefixed JSON and BIN chunks, each padded to a 4-byte boundary — JSON with
 * spaces, BIN with zeros.
 */
function glb(positions: number[], meshName: string): Uint8Array {
  const bin = new Uint8Array(new Float32Array(positions).buffer)
  const count = positions.length / 3
  const min = [0, 1, 2].map((a) => Math.min(...positions.filter((_, i) => i % 3 === a)))
  const max = [0, 1, 2].map((a) => Math.max(...positions.filter((_, i) => i % 3 === a)))

  const json = JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: meshName }],
    meshes: [{ name: meshName, primitives: [{ attributes: { POSITION: 0 } }] }],
    // min/max are mandatory on a POSITION accessor, and GLTFLoader rejects the file
    // without them.
    accessors: [{ bufferView: 0, componentType: 5126, count, type: 'VEC3', min, max }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length }],
  })

  const pad = (n: number) => (4 - (n % 4)) % 4
  const jsonBytes = strToU8(json + ' '.repeat(pad(json.length)))
  const binBytes = new Uint8Array(bin.length + pad(bin.length))
  binBytes.set(bin)

  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true) // "glTF"
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonBytes.length, true)
  view.setUint32(16, 0x4e4f534a, true) // "JSON"
  out.set(jsonBytes, 20)
  const binStart = 20 + jsonBytes.length
  view.setUint32(binStart, binBytes.length, true)
  view.setUint32(binStart + 4, 0x004e4942, true) // "BIN\0"
  out.set(binBytes, binStart + 8)
  return out
}

/**
 * A 10 m x 10 m square deck, in glTF's metres and glTF's axes: Y is up, so a floor lies in
 * the XZ plane.
 */
const DECK = [0, 0, 0, 10, 0, 0, 10, 0, 10, 0, 0, 0, 10, 0, 10, 0, 0, 10]

function mvrFile(xml: string, members: Record<string, Uint8Array> = {}): ArrayBuffer {
  const zip = zipSync({ 'GeneralSceneDescription.xml': strToU8(xml), ...members })
  return zip.slice().buffer as ArrayBuffer
}

const SCENE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6" provider="Capture" providerVersion="2025">
  <Scene><Layers>
    <Layer uuid="L1" name="Stage"><ChildList>
      <SceneObject uuid="o1" name="STAGE DECK">
        <Matrix>{1,0,0}{0,1,0}{0,0,1}{0,0,1500}</Matrix>
        <Geometries><Geometry3D fileName="deck.glb"/></Geometries>
      </SceneObject>
      <Truss uuid="t1" name="Sunstrip 12">
        <Geometries><Geometry3D fileName="deck.glb"/></Geometries>
      </Truss>
    </ChildList></Layer>
  </Layers></Scene>
</GeneralSceneDescription>`

describe('MVR import, end to end', () => {
  it('reads a glb out of the archive and places it by the object matrix', async () => {
    const scene = await load(mvrFile(SCENE_XML, { 'deck.glb': glb(DECK, 'Mesh_0') }), 'venue.mvr')

    expect(scene.format).toBe('MVR 1.6')
    expect(scene.sourceName).toBe('venue')
    // Stated by the specification, not guessed: millimetres, Z up.
    expect(scene.unitsPerMetre).toBe(0.001)
    expect(scene.upAxis).toBe('z')

    const deck = flattenNodes(scene.nodes).find((n) => n.name === 'STAGE DECK')!
    // 10 m of glTF becomes 10000 mm of MVR, the object matrix lifts it 1500 mm, and the
    // turn into venue axes puts MVR's +X along venue +Y.
    expect([...deck.positions.slice(0, 3)].map((v) => v + 0)).toEqual([0, 0, 1500])
    expect([...deck.positions.slice(3, 6)].map((v) => v + 0)).toEqual([0, 10000, 1500])
    // Read Y-up, it is still a floor: every vertex at the height the matrix gave it.
    expect([...deck.positions].filter((_, i) => i % 3 === 2).every((z) => z === 1500)).toBe(true)
  })

  it('keeps the MVR object name rather than the name inside the glb', async () => {
    const scene = await load(mvrFile(SCENE_XML, { 'deck.glb': glb(DECK, 'Mesh_0') }), 'venue.mvr')
    const names = flattenNodes(scene.nodes).map((n) => n.name)
    expect(names).toContain('STAGE DECK')
    expect(names).not.toContain('Mesh_0')
  })

  it('tags the truss so preparation can prune it', async () => {
    const scene = await load(mvrFile(SCENE_XML, { 'deck.glb': glb(DECK, 'Mesh_0') }), 'venue.mvr')
    const truss = flattenNodes(scene.nodes).find((n) => n.name === 'Sunstrip 12')!
    expect(truss.tags).toContain('Truss')
  })

  it('names the application that wrote the file', async () => {
    const scene = await load(mvrFile(SCENE_XML, { 'deck.glb': glb(DECK, 'Mesh_0') }), 'venue.mvr')
    expect(scene.warnings[0]).toBe('Written by Capture 2025.')
  })

  it('refuses an archive that is not an MVR', async () => {
    const zip = zipSync({ 'model.glb': glb(DECK, 'Mesh_0') })
    await expect(load(zip.slice().buffer as ArrayBuffer, 'x.mvr')).rejects.toThrow(ImportError)
  })

  it('explains itself when the export held only fixtures', async () => {
    const xml = `<?xml version="1.0"?><GeneralSceneDescription verMajor="1" verMinor="6">
      <Scene><Layers><Layer uuid="L1" name="Rig"><ChildList>
        <Fixture uuid="f1" name="Mac Aura"><GDTFSpec>Robe@MacAura.gdtf</GDTFSpec></Fixture>
      </ChildList></Layer></Layers></Scene></GeneralSceneDescription>`
    // The guidance is in `advice`, which is what the app shows under the message.
    await expect(load(mvrFile(xml), 'rig.mvr')).rejects.toThrow(ImportError)
    const err = await load(mvrFile(xml), 'rig.mvr').then(
      () => null,
      (e: ImportError) => e,
    )
    expect(err?.advice).toMatch(/lighting fixtures/)
    expect(err?.advice).toMatch(/Export the venue itself/)
  })
})

describe('MVR export, read back through three.js', () => {
  /**
   * The proof the writer's own tests cannot give.
   *
   * `mvr/write.test.ts` round-trips an export through a stub decoder, which only shows the
   * two halves of this codebase agree with each other. Reading the same file with the real
   * GLTFLoader is what shows the glb is a glb — that the chunk lengths, the padding, the
   * accessor bounds and the buffer view are all things a loader nobody here wrote will
   * accept. A hand-rolled binary writer is exactly where that is worth checking.
   */
  it('writes a venue that the real loader reads back at the right size', async () => {
    // A 12 x 8 m deck at 1.2 m, in venue metres.
    const deck = [-6, -4, 1.2, 6, -4, 1.2, 6, 4, 1.2, -6, -4, 1.2, 6, 4, 1.2, -6, 4, 1.2]
    const out = convertNodesToMvr(
      [{
        node: { id: 'n1', name: 'STAGE DECK', tags: [], positions: new Float64Array(deck), children: [] },
        planeType: PlaneType.Stage,
        include: true,
        name: 'STAGE DECK',
      }],
      DEFAULT_MVR_CONVERT,
      [],
      'Theatre',
    )
    for (const flavour of ['arraycalc', 'visualiser'] as const) {
      const written = writeMvr(out.scene, flavour)

      const scene = await load(written.bytes.slice().buffer as ArrayBuffer, 'Theatre.mvr')
      expect(scene.format).toBe(flavour === 'arraycalc' ? 'MVR 1.6' : 'MVR 1.4')
      expect(scene.unitsPerMetre).toBe(0.001)

      const node = flattenNodes(scene.nodes).find((n) => n.name === 'STAGE DECK')!
      const axis = (i: number) => [...node.positions].filter((_, k) => k % 3 === i)
      // Written as metres, read back as MVR millimetres, in the axes it left in: the deck
      // on -6..6 x -4..4 at 1.2 m is back on -6000..6000 x -4000..4000 at 1200.
      expect(Math.min(...axis(0))).toBeCloseTo(-6000, 0)
      expect(Math.max(...axis(0))).toBeCloseTo(6000, 0)
      expect(Math.min(...axis(1))).toBeCloseTo(-4000, 0)
      expect(Math.max(...axis(1))).toBeCloseTo(4000, 0)
      expect(Math.min(...axis(2))).toBeCloseTo(1200, 0)
      expect(Math.max(...axis(2))).toBeCloseTo(1200, 0)
      // The plane type went out as a Class and comes back as a tag.
      expect(node.tags).toContain('Stage (4)')
    }
  })

  it('brings a listening plane back as an audience area', async () => {
    const out = convertNodesToMvr(
      [{
        node: { id: 'n1', name: 'STALLS', tags: [], positions: new Float64Array([0, 0, 0, 10, 0, 0, 10, 6, 0]), children: [] },
        planeType: PlaneType.Listening,
        include: true,
        name: 'STALLS',
      }],
      DEFAULT_MVR_CONVERT,
      [],
      'Theatre',
    )
    const scene = await load(writeMvr(out.scene).bytes.slice().buffer as ArrayBuffer, 'Theatre.mvr')
    const stalls = flattenNodes(scene.nodes).find((n) => n.name === 'STALLS')!
    expect(stalls.tags).toContain('ListeningPlane')
    expect(categorise(stalls.name, stalls.tags)).toBe('seating')
  })
})

/**
 * The shape of an MVR from ArrayCalc 13.2.1 beta (Export MVR, "latest MVR audio
 * extensions", Rotate around z 90°), rebuilt by hand from what it wrote for its default
 * venue: listening planes as `ListeningPlane` nodes with no Matrix and their geometry
 * baked into a Y-up glb in metres; sources as `Speaker` nodes naming a GDTF, hung from a
 * `SpeakerBumper`. The vertices are its "Right Corner" plane's, as written. d&b's own file
 * is not in the repo; this is the same structure and the same numbers.
 */
describe("ArrayCalc 13's MVR dialect", () => {
  // The quarter-ring behind the right of the floor, rising 0 to 7 m, as glTF (x, y-up, z).
  const ring: [number, number, number][] = [
    [-20, 0, 55], [-20, 7, 80], [-29.567, 7, 78.097], [-37.678, 7, 72.678], [-43.097, 7, 64.567], [-45, 7, 55],
  ]
  const fan: number[] = []
  for (let i = 1; i + 1 < ring.length; i++) fan.push(...ring[0], ...ring[i], ...ring[i + 1])

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GeneralSceneDescription verMajor="1" verMinor="6" provider="ArrayCalc d&amp;b" providerVersion="0.5">
  <UserData/>
  <Scene>
    <AUXData><Class uuid="C-LP" name="Listening Plane"/><Class uuid="C-SRC" name="Sources"/></AUXData>
    <Layers>
      <Layer uuid="L-LP" name="Listening Planes"><ChildList>
        <ListeningPlane uuid="P-RC" name="Right Corner" AudioDescriptionFile="P-RC.xml">
          <Geometries><Geometry3D fileName="P-RC.glb"/></Geometries>
          <Classing>C-LP</Classing>
        </ListeningPlane>
      </ChildList></Layer>
      <Layer uuid="L-SRC" name="ArrayCalc Sources"><ChildList>
        <GroupObject uuid="G-MAIN" name="Main"><ChildList>
          <SpeakerBumper uuid="B-1" name="VFlyingFrame">
            <Matrix>{1,0,0}{0,1,0}{0,0,1}{-9000,3.49,11920.08}</Matrix>
            <Classing>C-SRC</Classing>
            <ChildList>
              <Speaker uuid="S-1" name="V8"><Classing>C-SRC</Classing><GDTFSpec>V8.gdtf</GDTFSpec><GDTFMode>Speaker</GDTFMode></Speaker>
              <Speaker uuid="S-2" name="V8"><Classing>C-SRC</Classing><GDTFSpec>V8.gdtf</GDTFSpec><GDTFMode>Speaker</GDTFMode></Speaker>
            </ChildList>
          </SpeakerBumper>
        </ChildList></GroupObject>
      </ChildList></Layer>
    </Layers>
  </Scene>
</GeneralSceneDescription>`

  it('lands the plane where ArrayCalc had it, the right way up', async () => {
    const scene = await load(mvrFile(xml, { 'P-RC.glb': glb(fan, 'Mesh') }), 'default.mvr')
    const rc = flattenNodes(scene.nodes).find((n) => n.name === 'Right Corner')!
    const axis = (a: number) => [...rc.positions].filter((_, i) => i % 3 === a)
    const range = (a: number) => [Math.min(...axis(a)), Math.max(...axis(a))].map((v) => Math.round(v) + 0)
    // In ArrayCalc this plane sits behind the floor (x 55..80 m) on its right (y -20..-45 m),
    // rising from 0 to 7 m. Read Z-up or unturned, it would stand on end or lie off to the side.
    expect(range(0)).toEqual([55000, 80000])
    expect(range(1)).toEqual([-45000, -20000])
    expect(range(2)).toEqual([0, 7000])
  })

  it('reads the listening plane as audience and leaves the loudspeakers out, counted', async () => {
    const scene = await load(mvrFile(xml, { 'P-RC.glb': glb(fan, 'Mesh') }), 'default.mvr')
    const names = flattenNodes(scene.nodes).map((n) => n.name)
    const rc = flattenNodes(scene.nodes).find((n) => n.name === 'Right Corner')!
    expect(categorise(rc.name, rc.tags)).toBe('seating')
    expect(names).not.toContain('V8')
    expect(scene.warnings.some((w) => /2 loudspeaker/.test(w))).toBe(true)
    expect(scene.warnings[0]).toBe('Written by ArrayCalc d&b 0.5.')
  })
})
