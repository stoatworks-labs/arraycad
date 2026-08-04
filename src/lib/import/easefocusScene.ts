/**
 * Import an EASE Focus 3 project (`.fc3`) as if it were a CAD file.
 *
 * The third leg of the converter: with `dbacvScene.ts` and `soundvisionScene.ts` it makes
 * all three prediction packages' venue formats interconvertible. Everything after this is
 * the ordinary pipeline.
 *
 * A zone is a plan rectangle with a height profile along its axis, so each profile
 * segment becomes one raked rectangle — two triangles — placed by the zone's centre,
 * orientation and depth. The planariser then merges collinear segments back into one
 * plane exactly as it would for a CAD import.
 */

import { type ImportedNode, type ImportedScene, ImportError } from './types.ts'
import { PlaneType } from '../dbacv/types.ts'
import { isEaseFocusFile, readEaseFocus } from '../easefocus/read.ts'
import type { EaseFocusZone } from '../easefocus/types.ts'

let seq = 0
const nextId = () => `efz${++seq}`

/** Tessellate one zone: each profile segment is a raked rectangle, two triangles. */
function zoneTriangles(zone: EaseFocusZone): Float64Array {
  const rad = (zone.orientation * Math.PI) / 180
  const ax = Math.cos(rad)
  const ay = Math.sin(rad)
  const wx = -ay
  const wy = ax
  const half = zone.width / 2
  // d runs from the FRONT edge; the zone centre is half the depth along the axis.
  const frontX = zone.x - (ax * zone.depth) / 2
  const frontY = zone.y - (ay * zone.depth) / 2

  const corner = (d: number, w: number, z: number): [number, number, number] => [
    frontX + ax * d + wx * w,
    frontY + ay * d + wy * w,
    zone.referenceZ + z,
  ]

  const out: number[] = []
  for (const area of zone.areas) {
    const a = corner(area.d1, -half, area.z1)
    const b = corner(area.d1, half, area.z1)
    const c = corner(area.d2, half, area.z2)
    const d = corner(area.d2, -half, area.z2)
    out.push(...a, ...b, ...c, ...a, ...c, ...d)
  }
  return new Float64Array(out)
}

export function importEaseFocusAsScene(bytes: Uint8Array, filename: string): ImportedScene {
  if (!isEaseFocusFile(bytes)) {
    throw new ImportError(
      'This .fc3 is not an EASE Focus 3 project file.',
      'An EASE Focus project begins with a SOAP header this file does not have. If it came ' +
        'from EASE Focus 2, open it in EASE Focus 3 and save it as .fc3 first.',
    )
  }

  const { project, writtenBy, warnings } = readEaseFocus(bytes)

  const nodes: ImportedNode[] = project.zones.map((zone) => ({
    id: nextId(),
    name: zone.label,
    tags: [],
    positions: zoneTriangles(zone),
    // A zone IS audience by definition; carrying that through saves re-typing on export.
    suggestedPlaneType: PlaneType.Listening,
    children: [],
  }))

  const notes = [...warnings]
  if (nodes.length === 0) {
    notes.push('The project has no audience zones — there is no venue geometry to convert.')
  } else {
    notes.push(
      'EASE Focus zones carry audience geometry only, so every object arrives as a ' +
        'Listening plane. Sound sources, filters and mapping settings are not read.',
    )
  }

  return {
    format: `EASE Focus project${writtenBy ? ` (${writtenBy.trim()})` : ''}`,
    alreadyAVenue: true,
    sourceName: filename.replace(/\.[^.]+$/, ''),
    // EASE Focus is metres with Z up throughout; the format carries no unit declaration
    // and the application offers no unit setting.
    unitsPerMetre: 1,
    upAxis: 'z',
    nodes,
    warnings: notes,
  }
}
