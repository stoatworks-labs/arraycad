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

/** A 10 m x 10 m square deck, in glTF's metres. */
const DECK = [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 0, 0, 10, 10, 0, 0, 10, 0]

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
    // 10 m of glTF becomes 10000 mm of MVR, and the object matrix lifts it 1500 mm.
    expect([...deck.positions.slice(0, 3)]).toEqual([0, 0, 1500])
    expect([...deck.positions.slice(3, 6)]).toEqual([10000, 0, 1500])
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
