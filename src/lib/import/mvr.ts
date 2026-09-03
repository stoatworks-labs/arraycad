/**
 * MVR (`.mvr`) -> `ImportedScene`.
 *
 * Thin on purpose. Everything that could be wrong — the matrix chain, symbol instancing,
 * unit normalisation, tagging — lives in `lib/mvr/`, which is three-free and covered by
 * node tests. All this module adds is the one thing those cannot have: the three.js
 * loaders that turn the archive's `.glb` and `.3ds` members into triangles.
 *
 * Why MVR is here at all: it is the only open format any lighting visualiser reads or
 * writes. Capture imports MVR 1.4+ and exports MVR 1.4 with venue geometry; Depence,
 * Vectorworks, WYSIWYG, grandMA3 and Blender all handle it. Their own project formats are
 * closed and none of them needs to be opened. See docs/mvr-format.md.
 */

import { type ImportedNode, type ImportedScene, ImportError } from './types.ts'
import { type MeshFormat, decodeMeshNodes } from './mesh.ts'
import { readMembers, readRootFile } from '../mvr/container.ts'
import { parseMvr } from '../mvr/read.ts'
import { buildMvrNodes, referencedFiles } from '../mvr/scene.ts'
import { MVR_UNITS_PER_METRE } from '../mvr/types.ts'

/**
 * Spec §"Node Definition: Geometry3D": "If there is no extension, it will assume that the
 * extension is 3ds." Anything else is not an MVR geometry format; `scene.ts` reports it.
 */
function formatOf(fileName: string): MeshFormat | null {
  const dot = fileName.lastIndexOf('.')
  if (dot === -1) return '3ds'
  switch (fileName.slice(dot + 1).toLowerCase()) {
    case '3ds':
      return '3ds'
    case 'glb':
      return 'glb'
    case 'gltf':
      return 'gltf'
    default:
      return null
  }
}

export async function importMvr(
  buffer: ArrayBuffer,
  filename: string,
  /** Supplied by the tests, which run in node and have no DOMParser. As dbacvScene.ts. */
  parser?: DOMParser,
): Promise<ImportedScene> {
  const bytes = new Uint8Array(buffer)
  const scene = parseMvr(readRootFile(bytes), parser)
  const files = readMembers(bytes, referencedFiles(scene))

  const decode = async (data: Uint8Array, fileName: string): Promise<ImportedNode[]> => {
    const format = formatOf(fileName)
    if (!format) return []
    // `slice()` rather than `.buffer`: fflate hands back views into a larger arena, and a
    // loader reading the raw buffer would parse whatever member happens to sit next to
    // this one. A glb read that way fails its magic-number check; a 3ds read that way
    // does not, and quietly produces nonsense.
    return decodeMeshNodes(data.slice().buffer, fileName, format)
  }

  const built = await buildMvrNodes(scene, { files, decode })

  if (built.nodes.length === 0) {
    throw new ImportError(
      'This MVR loaded but contains no geometry this tool can use.',
      built.fixturesSkipped > 0
        ? `Its ${built.fixturesSkipped} object(s) are all lighting fixtures, whose shapes ` +
          'live in separate GDTF files. Export the venue itself — the stage, seating and ' +
          'walls — from the visualiser as well, or send a DWG or glTF of the room instead.'
        : 'It may hold only fixtures, focus points or empty layers. The room surfaces have ' +
          'to be in the export for there to be anything to convert.',
    )
  }

  const provider = scene.provider ? `${scene.provider} ${scene.providerVersion}`.trim() : ''
  return {
    format: `MVR ${scene.version}`,
    sourceName: filename.replace(/\.[^.]+$/, ''),
    // Stated by the specification, not guessed: "Right-handed, Z-Up, 1 Distance Unit
    // equals 1 mm". `lib/mvr/scene.ts` has already normalised every embedded file into
    // that unit, which is why one number can be declared for the whole scene.
    unitsPerMetre: MVR_UNITS_PER_METRE,
    upAxis: 'z',
    // An MVR is a production model full of rig, not a finished venue like a .dbacv — the
    // exact case prepare/ exists for. Do not set alreadyAVenue.
    nodes: built.nodes,
    warnings: provider ? [`Written by ${provider}.`, ...built.warnings] : built.warnings,
  }
}
