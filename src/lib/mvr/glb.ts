/**
 * A minimal glb writer: one named mesh, positions only.
 *
 * Hand-rolled rather than taken from three's `GLTFExporter` for the same reason the `.fc3`
 * SOAP/gzip container is hand-rolled — `src/lib/` stays free of three.js so the whole
 * pipeline runs in node (AGENTS.md §2), and a writer whose every byte is chosen here is
 * one whose output a test can assert exactly.
 *
 * It writes the smallest thing that is a valid glTF 2.0 asset and a legal MVR geometry
 * file: no materials, no normals, no indices, no extensions. MVR spec Table 46 requires
 * `extensionsRequired` to be empty, which is trivially satisfied by never writing one.
 * Normals are omitted deliberately — glTF says a primitive without them is rendered flat
 * shaded, which is what a room surface should be, and computing per-vertex normals for a
 * welded venue plane would only invent smoothing that is not in the model.
 *
 * Container layout, glTF 2.0 §4.4: a 12-byte header, then length-prefixed chunks. Both
 * chunks are padded to a 4-byte boundary — JSON with spaces (0x20), BIN with zeros — and
 * the padding counts towards the chunk length.
 */

const MAGIC = 0x46546c67 // "glTF"
const CHUNK_JSON = 0x4e4f534a // "JSON"
const CHUNK_BIN = 0x004e4942 // "BIN\0"
const FLOAT = 5126
const ARRAY_BUFFER = 34962

const padTo4 = (n: number) => (4 - (n % 4)) % 4

export class GlbError extends Error {}

/**
 * Triangle soup -> a glb holding one mesh of that name.
 *
 * `positions` is flat xyz, 9 numbers per triangle, in the units the caller wants the file
 * to be in. This function applies no scale of its own: glTF is metres by specification and
 * `convert.ts` hands over metres, so there is nothing here to convert. See
 * docs/mvr-format.md §5 for why that is the interesting half of the decision.
 */
export function writeGlb(name: string, positions: Float64Array): Uint8Array {
  const count = Math.floor(positions.length / 3)
  if (count < 3) {
    throw new GlbError(`"${name}" has ${count} vertices, which is not a triangle.`)
  }

  // Float32 is glTF's ordinary POSITION type. At venue scale it resolves to a few microns,
  // which is far below the weld tolerance the geometry already went through.
  const verts = new Float32Array(count * 3)
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < count * 3; i++) {
    const v = positions[i]
    if (!Number.isFinite(v)) throw new GlbError(`"${name}" contains a non-finite coordinate.`)
    verts[i] = v
    const a = i % 3
    // Read back from the Float32Array, so min/max bound the values actually written. A
    // bound computed from the doubles can fall inside the rounded data, and a validator
    // that checks the accessor against its contents then rejects the file.
    if (verts[i] < min[a]) min[a] = verts[i]
    if (verts[i] > max[a]) max[a] = verts[i]
  }

  const bin = new Uint8Array(verts.buffer, verts.byteOffset, verts.byteLength)
  const json = JSON.stringify({
    asset: { version: '2.0', generator: 'ArrayCAD' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    // No `mode`: glTF's default primitive mode is 4, TRIANGLES.
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0 } }] }],
    // min and max are mandatory on a POSITION accessor, not optional metadata — loaders
    // use them to size the scene and three's rejects the file without them.
    accessors: [{ bufferView: 0, componentType: FLOAT, count, type: 'VEC3', min, max }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length, target: ARRAY_BUFFER }],
    buffers: [{ byteLength: bin.length }],
  })

  // From the ENCODED length, never `json.length`: an object name carrying an accent or a
  // CJK character is more bytes than characters, and a chunk length taken from the string
  // length would truncate the JSON and misplace every chunk after it.
  const jsonBytes = new TextEncoder().encode(json)
  const jsonLen = jsonBytes.length + padTo4(jsonBytes.length)
  const binLen = bin.length + padTo4(bin.length)
  const total = 12 + 8 + jsonLen + 8 + binLen

  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)

  view.setUint32(12, jsonLen, true)
  view.setUint32(16, CHUNK_JSON, true)
  out.set(jsonBytes, 20)
  for (let i = 20 + jsonBytes.length; i < 20 + jsonLen; i++) out[i] = 0x20

  const binStart = 20 + jsonLen
  view.setUint32(binStart, binLen, true)
  view.setUint32(binStart + 4, CHUNK_BIN, true)
  out.set(bin, binStart + 8)
  // The tail is already zero from the allocation, which is what BIN padding must be.

  return out
}
