/**
 * The `.mvr` container: a plain zip, read selectively.
 *
 * Spec §"File Format Definition": PKWARE 6.3.3, STORE or DEFLATE only, no encryption,
 * every referenced file at the root of the archive rather than in folders, and one
 * mandatory root file `GeneralSceneDescription.xml`.
 *
 * ## Why this reads twice
 *
 * A real show MVR is mostly payload this tool has no use for: textures, and one `.gdtf`
 * per fixture type, each of which is itself a zip full of 3D models. Decompressing all of
 * it to reach the geometry would cost hundreds of megabytes of memory for a file whose
 * useful part is a few hundred kilobytes of XML and a handful of meshes.
 *
 * So the archive is opened twice with fflate's `filter`: once for the XML alone, then —
 * after the caller has read it and knows which files the scene actually references — once
 * more for exactly those. Inflating the same central directory twice is far cheaper than
 * inflating a `.gdtf` nobody asked for.
 */

import { strFromU8, unzipSync } from 'fflate'
import { ImportError } from '../import/types.ts'
import { ROOT_FILE } from './types.ts'

/** Case-insensitive lookup: the spec forbids names differing only by case, so this is safe. */
function findMember(names: string[], wanted: string): string | undefined {
  const lower = wanted.toLowerCase()
  return names.find((n) => n.toLowerCase() === lower)
}

function unzip(bytes: Uint8Array, want: (name: string) => boolean): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes, { filter: (f) => want(f.name) })
  } catch (e) {
    throw new ImportError(
      `This .mvr file could not be opened: ${(e as Error).message}`,
      'An MVR is a zip archive. If the file was renamed from something else, or the ' +
        'download was truncated, that is what this looks like. Re-export it from the ' +
        'application that produced it.',
    )
  }
}

/**
 * Read `GeneralSceneDescription.xml` out of an archive.
 *
 * Throws rather than returning null: a zip without the root file is not an MVR, and the
 * only useful thing to tell someone holding one is what it should have contained.
 */
export function readRootFile(bytes: Uint8Array): string {
  // The filter cannot be case-insensitive on its own without listing the directory first,
  // and a mis-cased root file is a real thing exporters do, so match loosely here and let
  // the emptiness check below carry the error.
  const files = unzip(bytes, (n) => n.toLowerCase().endsWith(ROOT_FILE.toLowerCase()))
  const name = findMember(Object.keys(files), ROOT_FILE) ?? Object.keys(files)[0]
  if (!name) {
    throw new ImportError(
      `This archive has no ${ROOT_FILE}, so it is not an MVR file.`,
      'Every MVR contains that file at its root. A zip of loose models is not an MVR — ' +
        'if that is what you have, unzip it and drop the .glb, .3ds or .dwg in directly.',
    )
  }
  return strFromU8(files[name])
}

/**
 * Read the named members, skipping any the archive does not hold.
 *
 * A missing geometry file is NOT an error. Exporters do ship MVRs that reference a model
 * they failed to include, and losing one truss to that is no reason to refuse the venue;
 * `scene.ts` reports what was missing instead.
 */
export function readMembers(bytes: Uint8Array, names: Iterable<string>): Map<string, Uint8Array> {
  const wanted = new Set<string>()
  for (const n of names) wanted.add(n.toLowerCase())
  if (wanted.size === 0) return new Map()

  const files = unzip(bytes, (n) => wanted.has(n.toLowerCase()))
  const out = new Map<string, Uint8Array>()
  for (const [name, data] of Object.entries(files)) out.set(name.toLowerCase(), data)
  return out
}
