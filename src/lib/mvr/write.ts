/**
 * Write a `.mvr`: `GeneralSceneDescription.xml` plus one glb per venue plane, zipped.
 *
 * The shape written here is the one that makes an ArrayCAD venue useful on the other side:
 * **one `SceneObject` per plane**, each with its own small glb and an identity matrix, all
 * under one `Layer` named for the project. A visualiser then shows the plane names the
 * user pruned by — `STALLS RAKE`, `BALCONY` — as a readable object tree, rather than one
 * anonymous lump called `venue`.
 *
 * Plane types go out as MVR `Class`es, which is what a visualiser filters visibility by,
 * so the audience areas can be toggled as a set. The class name carries the RAW NUMERIC
 * CODE alongside the label, because those labels are inferred and not verified against
 * ArrayCalc (CLAUDE.md) — an inferred label leaving the tool unqualified is exactly how a
 * guess becomes folklore.
 */

import { strToU8, zipSync } from 'fflate'
import { writeGlb } from './glb.ts'

/** One venue plane, ready to write. */
export interface MvrWriteObject {
  name: string
  /**
   * Venue-space triangle soup, 9 numbers per triangle, in METRES.
   *
   * Metres because that is what glTF states, and because the importer reads a glb back as
   * metres — so an ArrayCAD export re-imported into ArrayCAD is the same room. That is a
   * decision, not a certainty; see docs/mvr-format.md §5.
   */
  positions: Float64Array
  /** MVR Class name, used for visibility filtering. */
  className?: string
}

export interface MvrWriteScene {
  projectName: string
  /** The single Layer everything is written under. */
  layerName: string
  objects: MvrWriteObject[]
}

/** What names this exporter as the producer, per the `provider` attributes. */
export const PROVIDER = 'ArrayCAD'
export const PROVIDER_VERSION = '0.3.0'

/**
 * The MVR version DECLARED on export, which is the oldest one this file conforms to — not
 * the newest one `read.ts` understands.
 *
 * Nothing written here — Layer, SceneObject, Geometries, Geometry3D, Class, Classing —
 * postdates 1.4, and 1.4 is the floor both Capture and Depence state they accept. A
 * consumer reads these attributes to decide how to parse, so declaring 1.6 would promise
 * features this file does not use and could turn a readable export into a refused one for
 * nothing. Same instinct as the `.dbacv` writer claiming 12.8.2: say what is actually
 * there.
 */
export const WRITE_VER_MAJOR = 1
export const WRITE_VER_MINOR = 4

const escapeXml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

/**
 * A stable RFC4122 uuid derived from a string.
 *
 * MVR asks for persistent ids: "All objects used have a persistent unique ID to track
 * changes between the different applications", and Depence uses exactly that to re-import
 * an updated MVR and update in place rather than duplicating. A fresh random uuid per
 * export would throw that away and leave a second copy of the room on every re-export.
 *
 * The bits come from a 128-bit FNV-1a over the key rather than from a random source, so
 * the same venue exported twice keeps its ids. The version nibble is 4 and the variant
 * bits are RFC4122, which is the truthful classification: version 4 says the bits are
 * random or PSEUDO-random, and a hash is a pseudo-random source. It is not a name-based
 * v5, which would have to be SHA-1, and it is not claimed to be.
 */
export function stableUuid(key: string): string {
  // Four independently seeded FNV-1a passes, since one 32-bit hash is not 128 bits of id.
  const words: number[] = []
  for (let seed = 0; seed < 4; seed++) {
    let h = 0x811c9dc5 ^ (seed * 0x9e3779b9)
    const s = `${seed}:${key}`
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      // FNV prime 16777619, in 32-bit shift-add form: Math.imul keeps it exact.
      h = Math.imul(h, 0x01000193) >>> 0
    }
    words.push(h >>> 0)
  }
  const hex = words.map((w) => w.toString(16).padStart(8, '0')).join('')
  const bytes = hex.match(/../g)!.map((b) => parseInt(b, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC4122 variant
  const h = bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * A venue plane's name -> a filename the MVR spec is happy with.
 *
 * Spec: filenames must avoid FAT32/NTFS reserved characters, and it "is recommended to
 * limit filenames to the POSIX Fully Portable Filenames character set" — `[A-Za-z0-9._-]`
 * — with at most one full stop. `STALLS RAKE` therefore cannot be the filename, and the
 * index prefix keeps two planes of the same name apart without the readable part being
 * lost.
 */
export function geometryFileName(index: number, name: string): string {
  const safe = name
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return `${String(index + 1).padStart(3, '0')}${safe ? `_${safe}` : ''}.glb`
}

export interface MvrWriteResult {
  bytes: Uint8Array
  /** Planes that held no triangle and so could not be written. */
  skipped: string[]
}

export function writeMvr(scene: MvrWriteScene): MvrWriteResult {
  const files: Record<string, Uint8Array> = {}
  const skipped: string[] = []
  const body: string[] = []

  // Classes are declared once in AUXData and referred to by uuid, so collect them as the
  // objects are walked rather than requiring the caller to pre-declare them.
  const classes = new Map<string, string>()
  // How many planes of this name have been written already. The uuid key is the name plus
  // that count, NOT the array index: keying on the index would change every id downstream
  // of an inserted plane, and re-importing would then duplicate the whole room rather than
  // update it — the one thing the stable id exists to prevent.
  const seen = new Map<string, number>()

  scene.objects.forEach((obj, i) => {
    let glb: Uint8Array
    try {
      glb = writeGlb(obj.name, obj.positions)
    } catch {
      // A plane that reduced to nothing is a fact about the model, not a reason to refuse
      // the export. It is reported instead.
      skipped.push(obj.name)
      return
    }
    const fileName = geometryFileName(i, obj.name)
    files[fileName] = glb

    let classing = ''
    if (obj.className) {
      if (!classes.has(obj.className)) {
        classes.set(obj.className, stableUuid(`class:${obj.className}`))
      }
      classing = `\n        <Classing>${classes.get(obj.className)}</Classing>`
    }

    // No Matrix: the coordinates are already where they belong, and an identity matrix
    // written out is one more thing for a consumer to compose wrongly. The spec says a
    // missing Matrix IS the identity.
    const occurrence = seen.get(obj.name) ?? 0
    seen.set(obj.name, occurrence + 1)

    body.push(
      `      <SceneObject uuid="${stableUuid(`object:${obj.name}#${occurrence}`)}" ` +
        `name="${escapeXml(obj.name)}">${classing}\n` +
        `        <Geometries><Geometry3D fileName="${fileName}"/></Geometries>\n` +
        `      </SceneObject>`,
    )
  })

  const aux = [...classes]
    .map(([name, uuid]) => `    <Class uuid="${uuid}" name="${escapeXml(name)}"/>`)
    .join('\n')

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<GeneralSceneDescription verMajor="${WRITE_VER_MAJOR}" verMinor="${WRITE_VER_MINOR}" ` +
    `provider="${PROVIDER}" providerVersion="${PROVIDER_VERSION}">\n` +
    `  <Scene>\n` +
    (aux ? `    <AUXData>\n${aux}\n    </AUXData>\n` : '') +
    `    <Layers>\n` +
    `      <Layer uuid="${stableUuid(`layer:${scene.layerName}`)}" ` +
    `name="${escapeXml(scene.layerName)}">\n` +
    `        <ChildList>\n${body.join('\n')}\n        </ChildList>\n` +
    `      </Layer>\n` +
    `    </Layers>\n` +
    `  </Scene>\n` +
    `</GeneralSceneDescription>\n`

  files['GeneralSceneDescription.xml'] = strToU8(xml)
  // DEFLATE, which the spec permits alongside STORE. A venue of a few hundred planes is
  // mostly repeated float patterns and compresses well.
  return { bytes: zipSync(files, { level: 6 }), skipped }
}
